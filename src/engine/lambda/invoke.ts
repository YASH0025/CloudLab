import { randomUUID } from "node:crypto";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import type { PermissionStatement } from "../services/lambda";
import type { Resource } from "../types";
import { runFunction, type FunctionError } from "./runtime";

/**
 * Invoking a function: the checks Lambda makes first (state, throttling,
 * payload size), the run itself, and the record of it: the recent
 * invocations with their logs (what CloudWatch Logs will show) and running
 * totals for metrics. A function stays "warm" for five minutes after a call;
 * a call after that, or after the code changes, is a cold start.
 */

export interface InvocationRecord {
  requestId: string;
  at: string;
  source: string;
  status: "Succeeded" | "Failed" | "Timed out";
  durationMs: number;
  billedDurationMs: number;
  initDurationMs?: number;
  errorType?: string;
  logs: string[];
}

export interface InvokeResult {
  requestId: string;
  statusCode: 200;
  executedVersion: "$LATEST";
  /** Set when the function threw or timed out, as in the Invoke API's X-Amz-Function-Error. */
  functionError?: "Unhandled";
  /** The function's return value, or Lambda's error object. */
  payload: unknown;
  logs: string[];
  durationMs: number;
  billedDurationMs: number;
  initDurationMs?: number;
  maxMemoryUsedMb: number;
  timedOut: boolean;
}

/** Invocations per account per minute. Generous for learning, small enough to stop abuse. */
export const INVOKES_PER_MINUTE = 60;
export const MAX_EVENT_BYTES = 256 * 1024;
const WARM_MS = 5 * 60_000;
const KEEP_INVOCATIONS = 20;
const KEEP_LOG_CHARS = 8_000;

export async function invokeFunction(engine: Engine, accountId: string, fn: Resource, event: unknown, source: string): Promise<InvokeResult> {
  if (fn.state !== "Active") {
    throw new EngineError(
      "ResourceConflictException",
      `The operation cannot be performed at this time. The function is currently in the following state: ${fn.state}`,
      409,
    );
  }
  if (JSON.stringify(event ?? {}).length > MAX_EVENT_BYTES) {
    throw new EngineError("RequestTooLargeException", `Request must be smaller than ${MAX_EVENT_BYTES} bytes for the InvokeFunction operation in CloudLab.`, 413);
  }
  const count = await engine.countInWindow(`lambda-invoke:${accountId}`, 60_000);
  if (count > INVOKES_PER_MINUTE) {
    await engine.metrics.lambdaInvoked(fn, { durationMs: 0, error: false, throttled: true });
    throw new EngineError("TooManyRequestsException", `Rate Exceeded. (CloudLab allows ${INVOKES_PER_MINUTE} invocations a minute per account.)`, 429);
  }

  const now = engine.now();
  const warmUntil = fn.attributes.warmUntil ? new Date(String(fn.attributes.warmUntil)).getTime() : 0;
  const requestId = randomUUID();
  const env = Object.fromEntries(((fn.config.environment as { key: string; value?: string }[] | undefined) ?? []).map((e) => [e.key, e.value ?? ""]));
  const out = await runFunction({
    files: (fn.config.files as Record<string, string>) ?? {},
    handler: String(fn.config.handler),
    event,
    env,
    functionName: fn.name,
    functionArn: fn.id,
    memoryMb: Number(fn.config.memorySize),
    timeoutSec: Number(fn.config.timeout),
    requestId,
    region: fn.region,
    cold: now.getTime() > warmUntil,
  });

  const payload: unknown = out.error ? lambdaErrorPayload(out.error, out.timedOut) : out.result;
  const record: InvocationRecord = {
    requestId,
    at: now.toISOString(),
    source,
    status: out.timedOut ? "Timed out" : out.error ? "Failed" : "Succeeded",
    durationMs: Math.round(out.durationMs * 100) / 100,
    billedDurationMs: out.billedDurationMs,
    initDurationMs: out.initDurationMs,
    errorType: out.error?.errorType,
    logs: trimLogs(out.logs),
  };
  const previous = (fn.attributes.invocations as InvocationRecord[] | undefined) ?? [];
  const metrics = (fn.attributes.metrics as { invocations?: number; errors?: number; durationMs?: number } | undefined) ?? {};
  await engine.setAttributes(accountId, fn.id, {
    invocations: [record, ...previous].slice(0, KEEP_INVOCATIONS),
    metrics: {
      invocations: (metrics.invocations ?? 0) + 1,
      errors: (metrics.errors ?? 0) + (out.error ? 1 : 0),
      durationMs: (metrics.durationMs ?? 0) + out.durationMs,
    },
    warmUntil: new Date(now.getTime() + WARM_MS).toISOString(),
    lastInvokedAt: now.toISOString(),
  });

  await engine.metrics.lambdaInvoked(fn, { durationMs: out.durationMs, error: !!out.error });

  return {
    requestId,
    statusCode: 200,
    executedVersion: "$LATEST",
    functionError: out.error ? "Unhandled" : undefined,
    payload,
    logs: out.logs,
    durationMs: out.durationMs,
    billedDurationMs: out.billedDurationMs,
    initDurationMs: out.initDurationMs,
    maxMemoryUsedMb: out.maxMemoryUsedMb,
    timedOut: out.timedOut,
  };
}

/** The payload Lambda returns for a failed invocation. */
function lambdaErrorPayload(e: FunctionError, timedOut: boolean) {
  if (timedOut) return { errorMessage: e.errorMessage };
  return { errorType: e.errorType, errorMessage: e.errorMessage, ...(e.trace ? { trace: e.trace } : {}) };
}

function trimLogs(lines: string[]): string[] {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) {
    n += l.length;
    if (n > KEEP_LOG_CHARS) {
      out.push("[CloudLab: older lines of this invocation's log were trimmed]");
      out.push(lines.at(-1)!);
      break;
    }
    out.push(l);
  }
  return out;
}

/** The last 4 KB of the log, base64-encoded: what `--log-type Tail` returns as LogResult. */
export function logTail(logs: string[]): string {
  const text = logs.join("\n") + "\n";
  return Buffer.from(text.slice(-4096)).toString("base64");
}

// ---------- resource-based policy (who else may invoke) ----------

const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value);

/** Whether the function's policy lets a service (e.g. apigateway.amazonaws.com) invoke it for this source ARN. */
export function allowsService(fn: Resource, service: string, sourceArn: string): boolean {
  const statements = (fn.attributes.permissions as PermissionStatement[] | undefined) ?? [];
  return statements.some((s) => {
    if (s.Effect !== "Allow" || s.Principal.Service !== service) return false;
    if (s.Action !== "lambda:InvokeFunction" && s.Action !== "lambda:*") return false;
    const src = s.Condition?.ArnLike?.["AWS:SourceArn"];
    return !src || glob(src, sourceArn);
  });
}

export interface AddPermissionInput {
  statementId: string;
  action: string;
  principal: string;
  sourceArn?: string;
}

/** Adds a statement to the function's resource-based policy, like `aws lambda add-permission`. */
export async function addPermission(engine: Engine, accountId: string, fn: Resource, input: AddPermissionInput): Promise<PermissionStatement> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.statementId)) {
    throw new EngineError(
      "ValidationException",
      `1 validation error detected: Value '${input.statementId}' at 'statementId' failed to satisfy constraint: Member must satisfy regular expression pattern: ([a-zA-Z0-9-_]+)`,
    );
  }
  if (!/^lambda:(InvokeFunction|\*)$/.test(input.action)) {
    throw new EngineError("InvalidParameterValueException", `CloudLab supports the action lambda:InvokeFunction, not ${input.action}.`);
  }
  const statements = (fn.attributes.permissions as PermissionStatement[] | undefined) ?? [];
  if (statements.some((s) => s.Sid === input.statementId)) {
    throw new EngineError(
      "ResourceConflictException",
      `The statement id (${input.statementId}) provided already exists. Please provide a new statement id, or remove the existing statement.`,
      409,
    );
  }
  const statement: PermissionStatement = {
    Sid: input.statementId,
    Effect: "Allow",
    Principal: input.principal.includes(".") ? { Service: input.principal } : { AWS: `arn:aws:iam::${input.principal}:root` },
    Action: input.action,
    Resource: fn.id,
    ...(input.sourceArn ? { Condition: { ArnLike: { "AWS:SourceArn": input.sourceArn } } } : {}),
  };
  await engine.setAttributes(accountId, fn.id, { permissions: [...statements, statement] });
  return statement;
}

export async function removePermission(engine: Engine, accountId: string, fn: Resource, statementId: string): Promise<void> {
  const statements = (fn.attributes.permissions as PermissionStatement[] | undefined) ?? [];
  if (!statements.some((s) => s.Sid === statementId)) {
    throw new EngineError("ResourceNotFoundException", "The resource you requested does not exist.", 404);
  }
  await engine.setAttributes(accountId, fn.id, { permissions: statements.filter((s) => s.Sid !== statementId) });
}

/** The function's resource-based policy document, as `get-policy` returns it. */
export function policyDocument(fn: Resource): string | null {
  const statements = (fn.attributes.permissions as PermissionStatement[] | undefined) ?? [];
  if (statements.length === 0) return null;
  return JSON.stringify({ Version: "2012-10-17", Id: "default", Statement: statements });
}

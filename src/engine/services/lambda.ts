import { createHash, randomUUID } from "node:crypto";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { FieldDef, ResourceTypeDef, ServiceDef } from "../types";
import { trustedPrincipals } from "./iam";

/**
 * AWS Lambda: functions that run your code when called, with no server to
 * manage. CloudLab really runs Node.js functions, in a sandbox (see
 * lambda/runtime.ts). A function needs an execution role that Lambda may
 * assume; other services (API Gateway) may only call it if its resource-based
 * policy allows them (add-permission).
 */

export const LAMBDA_RUNTIMES = [
  { value: "nodejs22.x", label: "Node.js 22.x" },
  { value: "nodejs20.x", label: "Node.js 20.x" },
];

/** Runtimes AWS no longer lets you create functions with. */
const DEPRECATED = ["nodejs18.x", "nodejs16.x", "nodejs14.x", "nodejs12.x", "python3.8", "python2.7"];

/** Environment variables Lambda sets itself; you can't override them. */
export const RESERVED_ENV = [
  "_HANDLER",
  "_X_AMZN_TRACE_ID",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_INITIALIZATION_TYPE",
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_LAMBDA_RUNTIME_API",
  "LAMBDA_TASK_ROOT",
  "LAMBDA_RUNTIME_DIR",
];

/** The code a new function starts with in the console, like AWS's. */
export const STARTER_CODE: Record<string, string> = {
  "index.mjs": `export const handler = async (event) => {
  // TODO implement
  const response = {
    statusCode: 200,
    body: JSON.stringify('Hello from Lambda!'),
  };
  return response;
};
`,
};

export const LAMBDA_ARN = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9_-]{1,64}$/;

export const functionArn = (region: string, accountId: string, name: string) => `arn:aws:lambda:${region}:${accountNumber(accountId)}:function:${name}`;

/** What Lambda reports as CodeSha256: a base64 SHA-256 of the deployed code. */
export function codeSha256(files: Record<string, string>) {
  const canonical = JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]]));
  return createHash("sha256").update(canonical).digest("base64");
}

export const codeSize = (files: Record<string, string>) => Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0);

const NAME_PATTERN =
  "(arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?";

const envItem: FieldDef[] = [
  { key: "key", label: "Key", type: "string", required: true, maxLength: 128, pattern: "^[a-zA-Z]([a-zA-Z0-9_])*$", patternMessage: "Letters, numbers and _; starts with a letter.", placeholder: "TABLE_NAME" },
  { key: "value", label: "Value", type: "string", maxLength: 4096, placeholder: "orders" },
];

export interface PermissionStatement {
  Sid: string;
  Effect: "Allow";
  Principal: { Service?: string; AWS?: string };
  Action: string;
  Resource: string;
  Condition?: { ArnLike?: { "AWS:SourceArn": string } };
}

const lambdaFunction: ResourceTypeDef = {
  service: "lambda",
  type: "function",
  label: "Function",
  pluralLabel: "Functions",
  description:
    "Code that runs when something calls it (an API, a schedule, an upload) and stops when it's done. No server to manage, and you pay only while it runs. CloudLab really runs your Node.js code, in a sandbox.",
  idPrefix: "function",
  makeId: ({ name, region, accountId }) => functionArn(region, accountId, name),
  idPattern: LAMBDA_ARN,
  notFoundCode: "ResourceNotFoundException",
  notFoundMessage: (id) => `Function not found: ${id}`,
  notFoundByNameMessage: (name) => `Function not found: ${name}`,
  malformedCode: "ResourceNotFoundException",
  malformedMessage: (id) => `Function not found: ${id}`,
  apiNoun: "function",
  stateErrorCode: "ResourceConflictException",
  panelAttributes: ["invocations", "permissions", "warmUntil", "metrics", "revisionId"],
  fields: [
    {
      key: "name",
      label: "Function name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 64,
      pattern: "^[a-zA-Z0-9_-]+$",
      patternMessage: "Letters, numbers, hyphens and underscores only.",
      placeholder: "hello-world",
      param: "functionName",
    },
    {
      key: "runtime",
      label: "Runtime",
      type: "enum",
      required: true,
      default: "nodejs22.x",
      options: LAMBDA_RUNTIMES,
      param: "Runtime",
      description: "CloudLab runs Node.js. Python and others are planned.",
    },
    {
      key: "handler",
      label: "Handler",
      type: "string",
      required: true,
      default: "index.handler",
      maxLength: 128,
      pattern: "^[^\\s]+$",
      patternMessage: "file.function, e.g. index.handler (no spaces).",
      param: "Handler",
      description: "file.export: index.handler runs the handler exported by index.mjs (or index.js).",
    },
    {
      key: "role",
      label: "Execution role",
      type: "ref",
      required: true,
      ref: { service: "iam", type: "role", by: "name" },
      refNotFound: () => ({ code: "InvalidParameterValueException", message: "The role defined for the function cannot be assumed by Lambda." }),
      param: "Role",
      description: "The IAM role the function runs as. Its trust policy must let lambda.amazonaws.com assume it.",
    },
    {
      key: "files",
      label: "Code",
      type: "files",
      required: true,
      default: STARTER_CODE,
      param: "Code",
    },
    { key: "description", label: "Description", type: "string", maxLength: 256, param: "Description" },
    { key: "memorySize", label: "Memory (MB)", type: "number", required: true, default: 128, min: 128, max: 10240, param: "MemorySize" },
    {
      key: "timeout",
      label: "Timeout (seconds)",
      type: "number",
      required: true,
      default: 3,
      min: 1,
      max: 900,
      param: "Timeout",
      description: "The function is stopped if it runs longer. Default 3 seconds.",
    },
    {
      key: "environment",
      label: "Environment variables",
      type: "list",
      item: envItem,
      maxItems: 30,
      param: "Environment",
      description: "Settings your code reads from process.env, e.g. a table name. Don't put secrets here in real projects.",
    },
    {
      key: "architecture",
      label: "Architecture",
      type: "enum",
      required: true,
      default: "x86_64",
      options: [
        { value: "x86_64", label: "x86_64" },
        { value: "arm64", label: "arm64", hint: "Graviton: cheaper per millisecond" },
      ],
      param: "Architectures",
    },
  ],
  columns: [
    { label: "Runtime", path: "config.runtime" },
    { label: "Memory (MB)", path: "config.memorySize" },
    { label: "Last modified", path: "attributes.lastModified" },
  ],
  lifecycle: { create: { state: "Pending", settlesTo: "Active", afterMs: 1_500 } },
  iam: {
    create: "lambda:CreateFunction",
    read: "lambda:GetFunction",
    update: (changed) => [
      ...(changed.includes("files") ? ["lambda:UpdateFunctionCode"] : []),
      ...(changed.some((c) => c !== "files") ? ["lambda:UpdateFunctionConfiguration"] : []),
    ],
    delete: "lambda:DeleteFunction",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "name") {
      return new EngineError(
        "ValidationException",
        `1 validation error detected: Value '${value}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: ${NAME_PATTERN}`,
      );
    }
    if (field.key === "runtime") {
      const v = String(value);
      if (DEPRECATED.includes(v)) {
        return new EngineError(
          "InvalidParameterValueException",
          `The runtime parameter of ${v} is no longer supported for creating or updating AWS Lambda functions. We recommend you use a supported runtime while creating or updating functions.`,
        );
      }
      return new EngineError(
        "InvalidParameterValueException",
        `CloudLab runs Node.js functions only for now (nodejs22.x or nodejs20.x), not ${v}.`,
      );
    }
    if (field.key === "memorySize") {
      return new EngineError(
        "ValidationException",
        `1 validation error detected: Value '${value}' at 'memorySize' failed to satisfy constraint: Member must have value ${Number(value) < 128 ? "greater than or equal to 128" : "less than or equal to 10240"}`,
      );
    }
    if (field.key === "timeout") {
      return new EngineError(
        "ValidationException",
        `1 validation error detected: Value '${value}' at 'timeout' failed to satisfy constraint: Member must have value ${Number(value) < 1 ? "greater than or equal to 1" : "less than or equal to 900"}`,
      );
    }
    if (field.key === "files") {
      return new EngineError("InvalidParameterValueException", "Unzipped size must be smaller than 262144 bytes in CloudLab.");
    }
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("lambda", "function")).some((f) => f.name === config.name)) {
      throw new EngineError("ResourceConflictException", `Function already exist: ${config.name}`);
    }
    const role = (await ctx.list("iam", "role")).find((r) => r.name === config.role);
    if (role) {
      const trusted = trustedPrincipals(String(role.config.trustPolicy ?? "{}"));
      if (!trusted.services.includes("lambda.amazonaws.com")) {
        throw new EngineError("InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda.");
      }
    }
    const env = (config.environment as { key: string }[] | undefined) ?? [];
    const reserved = env.map((e) => e.key).filter((k) => RESERVED_ENV.includes(k));
    if (reserved.length) {
      throw new EngineError(
        "InvalidParameterValueException",
        `Lambda was unable to configure your environment variables because the environment variables you have provided contains reserved keys that are currently not supported for modification. Reserved keys used in this request: ${reserved.join(", ")}`,
      );
    }
    const keys = env.map((e) => e.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) throw new EngineError("InvalidParameterValueException", `Environment variable ${dup} is defined more than once.`);
  },
  async derive({ id, config, existing, ctx }) {
    const files = (config.files as Record<string, string>) ?? {};
    const sha = codeSha256(files);
    const changed = !existing || JSON.stringify(existing.config) !== JSON.stringify(config);
    return {
      ...(existing?.attributes ?? {}),
      functionArn: id,
      codeSha256: sha,
      codeSize: codeSize(files),
      version: "$LATEST",
      packageType: "Zip",
      lastModified: changed ? ctx.now().toISOString().replace("Z", "+0000") : existing!.attributes.lastModified,
      revisionId: changed ? randomUUID() : existing!.attributes.revisionId,
      // New code or settings mean a fresh execution environment: the next call is a cold start.
      warmUntil: changed ? null : (existing?.attributes.warmUntil ?? null),
      logGroup: `/aws/lambda/${config.name}`,
    };
  },
};

export const lambdaService: ServiceDef = {
  id: "lambda",
  label: "Lambda",
  modelledOn: "Lambda",
  description: "Run code without servers: functions that start when called and stop when done.",
  category: "Compute",
  types: [lambdaFunction],
};

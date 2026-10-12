import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { filesFromZip } from "@/engine/lambda/code";
import { addPermission, invokeFunction, logTail, policyDocument, removePermission } from "@/engine/lambda/invoke";
import { LAMBDA_ARN } from "@/engine/services/lambda";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { ClientSideError, LocalPathError, UsageError } from "./parse";

/**
 * `aws lambda`: functions, invoking them, and their resource-based policy.
 * Code is uploaded as a .zip (--zip-file fileb://function.zip), as with AWS.
 */

const cmd = (c: Command) => c;

const listFns = (ctx: CliContext) => ctx.engine.list(ctx.accountId, { service: "lambda", type: "function", region: ctx.region });

const fullArn = (ctx: CliContext, name: string) => `arn:aws:lambda:${ctx.region}:${accountNumber(ctx.accountId)}:function:${name}`;

/** --function-name takes a name, an ARN or a partial ARN (123456789012:function:name). */
function nameOf(value: string): string {
  if (LAMBDA_ARN.test(value)) return value.split(":").pop()!;
  const m = /^(?:\d{12}:)?function:([a-zA-Z0-9_-]+)$/.exec(value);
  return m ? m[1] : value;
}

async function fnByName(ctx: CliContext, value: string): Promise<Resource> {
  const name = nameOf(value);
  const fn = (await listFns(ctx)).find((f) => f.name === name);
  if (!fn) throw new EngineError("ResourceNotFoundException", `Function not found: ${fullArn(ctx, name)}`, 404);
  return fn;
}

/** Reads file://… (text) or fileb://… (bytes) the terminal sent along with the command. */
function readLocal(ctx: CliContext, value: string): { data: Buffer; binary: boolean } | null {
  const m = /^(fileb?):\/\/(.+)$/.exec(value);
  if (!m) return null;
  const content = ctx.files?.[m[2]];
  if (content === undefined) throw new LocalPathError(m[2]);
  return { data: Buffer.from(content, "base64"), binary: m[1] === "fileb" };
}

function zipArg(ctx: CliContext, args: Args): Record<string, string> | undefined {
  const value = args.one("zip-file");
  if (value === undefined) return undefined;
  const local = readLocal(ctx, value);
  if (!local) throw new UsageError(`--zip-file must be a local file, like fileb://function.zip`);
  return filesFromZip(local.data);
}

/** --environment Variables={KEY=value,OTHER=x} or JSON {"Variables":{...}}. */
function envArg(args: Args): { key: string; value: string }[] | undefined {
  const raw = args.raw("environment").join(" ").trim();
  if (!raw) return undefined;
  let vars: Record<string, string>;
  if (raw.startsWith("{")) {
    try {
      vars = (JSON.parse(raw) as { Variables?: Record<string, string> }).Variables ?? {};
    } catch {
      throw new UsageError(`Error parsing parameter '--environment': Invalid JSON: ${raw}`);
    }
  } else {
    const m = /^Variables=\{(.*)\}$/.exec(raw);
    if (!m) throw new UsageError(`Error parsing parameter '--environment': Expected: 'Variables={KEY=value,...}', received: '${raw}'`);
    vars = Object.fromEntries(
      m[1]
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const i = pair.indexOf("=");
          if (i < 1) throw new UsageError(`Error parsing parameter '--environment': Expected: '=', received: '${pair}'`);
          return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
        }),
    );
  }
  return Object.entries(vars).map(([key, value]) => ({ key, value: String(value) }));
}

/** --role arn:aws:iam::<account>:role/<name> → the role's name. */
function roleArg(ctx: CliContext, value: string): string {
  const m = /^arn:aws:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]+)$/.exec(value);
  if (!m) {
    throw new EngineError(
      "ValidationException",
      `1 validation error detected: Value '${value}' at 'role' failed to satisfy constraint: Member must satisfy regular expression pattern: arn:(aws[a-zA-Z-]*)?:iam::\\d{12}:role/?[a-zA-Z_0-9+=,.@\\-_/]+`,
    );
  }
  if (m[1] !== accountNumber(ctx.accountId)) throw new EngineError("InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda.");
  return m[2];
}

const int = (args: Args, name: string) => {
  const v = args.one(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`argument --${name}: invalid int value: '${v}'`);
  return n;
};

export function configurationOut(ctx: CliContext, fn: Resource) {
  const a = fn.attributes;
  const env = (fn.config.environment as { key: string; value?: string }[] | undefined) ?? [];
  const pending = fn.state === "Pending";
  return {
    FunctionName: fn.name,
    FunctionArn: fn.id,
    Runtime: fn.config.runtime,
    Role: `arn:aws:iam::${accountNumber(ctx.accountId)}:role/${fn.config.role}`,
    Handler: fn.config.handler,
    CodeSize: a.codeSize,
    Description: fn.config.description ?? "",
    Timeout: fn.config.timeout,
    MemorySize: fn.config.memorySize,
    LastModified: a.lastModified,
    CodeSha256: a.codeSha256,
    Version: "$LATEST",
    ...(env.length ? { Environment: { Variables: Object.fromEntries(env.map((e) => [e.key, e.value ?? ""])) } } : {}),
    TracingConfig: { Mode: "PassThrough" },
    RevisionId: a.revisionId,
    State: fn.state,
    ...(pending ? { StateReason: "The function is being created.", StateReasonCode: "Creating" } : { LastUpdateStatus: "Successful" }),
    PackageType: "Zip",
    Architectures: [fn.config.architecture ?? "x86_64"],
    EphemeralStorage: { Size: 512 },
    SnapStart: { ApplyOn: "None", OptimizationStatus: "Off" },
    RuntimeVersionConfig: { RuntimeVersionArn: `arn:aws:lambda:${fn.region}::runtime:cloudlab-${fn.config.runtime}` },
    LoggingConfig: { LogFormat: "Text", LogGroup: `/aws/lambda/${fn.name}` },
  };
}

/** --payload: AWS CLI v2 expects base64 unless --cli-binary-format raw-in-base64-out is given. */
function payloadArg(ctx: CliContext, args: Args): unknown {
  const raw = args.one("payload");
  if (raw === undefined) return {};
  const local = readLocal(ctx, raw);
  let text: string;
  if (local?.binary) text = local.data.toString("utf8");
  else {
    const given = local ? local.data.toString("utf8") : raw;
    if (args.one("cli-binary-format") === "raw-in-base64-out") text = given;
    else {
      const clean = given.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) {
        throw new ClientSideError(
          `\nInvalid base64: "${given}"\n(Nuvora: the AWS CLI v2 reads --payload as base64. Add --cli-binary-format raw-in-base64-out to pass JSON as is.)`,
        );
      }
      text = Buffer.from(clean, "base64").toString("utf8");
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError("InvalidRequestContentException", "Could not parse request body into json: Could not parse payload into json: Unexpected character");
  }
}

export const LAMBDA_COMMANDS: Command[] = [
  cmd({
    service: "lambda",
    operation: "create-function",
    apiName: "CreateFunction",
    summary: "Create a function from a .zip of your code",
    usage:
      "--function-name <name> --runtime nodejs22.x --role <role-arn> --handler index.handler --zip-file fileb://function.zip [--description <text>] [--timeout <seconds>] [--memory-size <MB>] [--environment Variables={KEY=value}] [--architectures x86_64|arm64]",
    mutates: true,
    async run(args, ctx) {
      const files = zipArg(ctx, args);
      if (!files) throw new EngineError("InvalidParameterValueException", "Please provide a source for function code.");
      const role = args.one("role");
      if (!role) throw new UsageError("the following arguments are required: --role");
      const fn = await ctx.engine.create(ctx.accountId, {
        service: "lambda",
        type: "function",
        region: ctx.region,
        config: {
          name: nameOf(args.required("function-name")),
          runtime: args.required("runtime"),
          role: roleArg(ctx, role),
          handler: args.required("handler"),
          files,
          description: args.one("description"),
          timeout: int(args, "timeout") ?? 3,
          memorySize: int(args, "memory-size") ?? 128,
          environment: envArg(args) ?? [],
          architecture: args.list("architectures")[0] ?? "x86_64",
        },
      });
      return configurationOut(ctx, fn);
    },
  }),
  cmd({
    service: "lambda",
    operation: "list-functions",
    apiName: "ListFunctions",
    summary: "List functions",
    mutates: false,
    async run(_args, ctx) {
      return { Functions: (await listFns(ctx)).map((f) => configurationOut(ctx, f)) };
    },
  }),
  cmd({
    service: "lambda",
    operation: "get-function",
    apiName: "GetFunction",
    summary: "Show a function's settings and where its code is",
    usage: "--function-name <name>",
    mutates: false,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      return {
        Configuration: configurationOut(ctx, fn),
        Code: { RepositoryType: "S3", Location: `https://awslambda-${fn.region}-tasks.s3.${fn.region}.cloudlab.local/snapshots/${accountNumber(ctx.accountId)}/${fn.name}` },
      };
    },
  }),
  cmd({
    service: "lambda",
    operation: "get-function-configuration",
    apiName: "GetFunctionConfiguration",
    summary: "Show a function's settings",
    usage: "--function-name <name>",
    mutates: false,
    async run(args, ctx) {
      return configurationOut(ctx, await fnByName(ctx, args.required("function-name")));
    },
  }),
  cmd({
    service: "lambda",
    operation: "update-function-code",
    apiName: "UpdateFunctionCode",
    summary: "Deploy new code from a .zip",
    usage: "--function-name <name> --zip-file fileb://function.zip",
    mutates: true,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      const files = zipArg(ctx, args);
      if (!files) throw new EngineError("InvalidParameterValueException", "Please provide a source for function code.");
      return configurationOut(ctx, await ctx.engine.update(ctx.accountId, fn.id, { files }));
    },
  }),
  cmd({
    service: "lambda",
    operation: "update-function-configuration",
    apiName: "UpdateFunctionConfiguration",
    summary: "Change a function's settings (handler, timeout, memory, environment, role…)",
    usage:
      "--function-name <name> [--handler <file.export>] [--timeout <seconds>] [--memory-size <MB>] [--environment Variables={KEY=value}] [--description <text>] [--role <role-arn>] [--runtime <runtime>]",
    mutates: true,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      const patch: Record<string, unknown> = {};
      const set = (k: string, v: unknown) => v !== undefined && (patch[k] = v);
      set("handler", args.one("handler"));
      set("timeout", int(args, "timeout"));
      set("memorySize", int(args, "memory-size"));
      set("description", args.one("description"));
      set("runtime", args.one("runtime"));
      set("environment", envArg(args));
      const role = args.one("role");
      if (role) patch.role = roleArg(ctx, role);
      return configurationOut(ctx, await ctx.engine.update(ctx.accountId, fn.id, patch));
    },
  }),
  cmd({
    service: "lambda",
    operation: "delete-function",
    apiName: "DeleteFunction",
    summary: "Delete a function",
    usage: "--function-name <name>",
    mutates: true,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      await ctx.engine.remove(ctx.accountId, fn.id);
    },
  }),
  cmd({
    service: "lambda",
    operation: "invoke",
    apiName: "Invoke",
    summary: "Run a function; its answer is written to the output file (use /dev/stdout to print it)",
    usage:
      "--function-name <name> [--payload <json>] [--cli-binary-format <raw-in-base64-out>] [--log-type <Tail>] [--invocation-type <RequestResponse|Event|DryRun>] <outfile>",
    mutates: true,
    async run(args, ctx) {
      const outfile = args.positionals[0];
      if (!outfile) throw new UsageError("the following arguments are required: outfile");
      const fn = await fnByName(ctx, args.required("function-name"));
      const event = payloadArg(ctx, args);
      const type = args.one("invocation-type") ?? "RequestResponse";
      if (!["RequestResponse", "Event", "DryRun"].includes(type)) {
        throw new UsageError(`argument --invocation-type: Invalid choice, valid choices are:\n\nDryRun | Event | RequestResponse`);
      }
      if (type === "DryRun") return { StatusCode: 204 };
      const result = await invokeFunction(ctx.engine, ctx.accountId, fn, event, "cli");
      if (ctx.effects) ctx.effects.apiName = "Invoke";
      const meta = {
        StatusCode: type === "Event" ? 202 : 200,
        ...(type === "Event" ? {} : result.functionError ? { FunctionError: result.functionError } : {}),
        ...(args.one("log-type") === "Tail" && type !== "Event" ? { LogResult: logTail(result.logs) } : {}),
        ...(type === "Event" ? {} : { ExecutedVersion: "$LATEST" }),
      };
      const body = type === "Event" ? "" : JSON.stringify(result.payload ?? null);
      if (outfile === "/dev/stdout" || outfile === "-") {
        // The function's answer, then the CLI's own output, as on a real terminal.
        return `${body}\n${JSON.stringify(meta, null, 4)}`;
      }
      if (ctx.effects) ctx.effects.download = { filename: outfile.split("/").pop() || "response.json", data: Buffer.from(body).toString("base64"), contentType: "application/json" };
      return meta;
    },
  }),
  cmd({
    service: "lambda",
    operation: "add-permission",
    apiName: "AddPermission",
    summary: "Let another service (e.g. API Gateway) invoke the function",
    usage: "--function-name <name> --statement-id <id> --action lambda:InvokeFunction --principal apigateway.amazonaws.com [--source-arn <arn>]",
    mutates: true,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      const statement = await addPermission(ctx.engine, ctx.accountId, fn, {
        statementId: args.required("statement-id"),
        action: args.required("action"),
        principal: args.required("principal"),
        sourceArn: args.one("source-arn"),
      });
      return { Statement: JSON.stringify(statement) };
    },
  }),
  cmd({
    service: "lambda",
    operation: "remove-permission",
    apiName: "RemovePermission",
    summary: "Remove a statement from the function's resource-based policy",
    usage: "--function-name <name> --statement-id <id>",
    mutates: true,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      await removePermission(ctx.engine, ctx.accountId, fn, args.required("statement-id"));
    },
  }),
  cmd({
    service: "lambda",
    operation: "get-policy",
    apiName: "GetPolicy",
    summary: "Show who else may invoke the function",
    usage: "--function-name <name>",
    mutates: false,
    async run(args, ctx) {
      const fn = await fnByName(ctx, args.required("function-name"));
      const policy = policyDocument(fn);
      if (!policy) throw new EngineError("ResourceNotFoundException", "The resource you requested does not exist.", 404);
      return { Policy: policy, RevisionId: fn.attributes.revisionId };
    },
  }),
];

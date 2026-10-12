import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten";

/**
 * Runs a learner's Lambda function for real, inside QuickJS compiled to
 * WebAssembly: a separate JavaScript engine with no network, no file system
 * and no access to the host. Each invocation gets a fresh engine with a
 * memory cap and a CPU-time cap, so a runaway function can't hurt the server.
 *
 * It behaves like the Node.js Lambda runtime where learners will notice:
 * - handler "index.handler" loads index.mjs (ES module) or index.js
 *   (CommonJS, unless package.json says "type": "module");
 * - async handlers, callback handlers, imports/require between your files;
 * - console.log lines, START/END/REPORT log lines and the error shapes
 *   (Runtime.ImportModuleError, Runtime.HandlerNotFound, timeouts…);
 * - setTimeout runs on simulated time: `await sleep(2000)` returns at once
 *   but counts as 2 seconds, so timeouts behave as on AWS.
 * There is no AWS SDK or Node.js built-in module (fs, http…) yet.
 */

export interface RunInput {
  files: Record<string, string>;
  handler: string;
  event: unknown;
  env: Record<string, string>;
  functionName: string;
  functionArn: string;
  memoryMb: number;
  timeoutSec: number;
  requestId: string;
  region: string;
  /** Whether a fresh execution environment starts (shows Init Duration). */
  cold: boolean;
}

export interface FunctionError {
  errorType: string;
  errorMessage: string;
  trace?: string[];
}

export interface RunOutput {
  /** The function's return value (JSON) when it succeeded. */
  result?: unknown;
  error?: FunctionError;
  /** Log lines, as they'd appear in CloudWatch Logs. */
  logs: string[];
  durationMs: number;
  billedDurationMs: number;
  initDurationMs?: number;
  maxMemoryUsedMb: number;
  timedOut: boolean;
}

/** Real CPU time a single invocation may use, whatever its configured timeout. */
export const CPU_LIMIT_MS = 5_000;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Memory the sandbox may use, at most (the configured size counts too). */
const MAX_SANDBOX_MB = 64;
/** What an idle Node.js runtime already uses, added to the sandbox's own usage. */
const BASE_MEMORY_MB = 42;

let quickjs: Promise<QuickJSWASMModule> | null = null;
const engine = () => (quickjs ??= getQuickJS());

/** Code that runs before the function: console, process.env, timers on simulated time, and require(). */
const PRELUDE = String.raw`
globalThis.__virtualMs = 0;
globalThis.__timers = [];
let __timerId = 0;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = ++__timerId;
  __timers.push({ id, at: __virtualMs + Math.max(0, Number(ms) || 0), fn, args });
  return id;
};
globalThis.clearTimeout = (id) => { globalThis.__timers = __timers.filter((t) => t.id !== id); };
globalThis.setInterval = () => { throw new Error("setInterval isn't available in CloudLab's Lambda runtime"); };
globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
globalThis.__runNextTimer = () => {
  if (__timers.length === 0) return false;
  __timers.sort((a, b) => a.at - b.at || a.id - b.id);
  const t = __timers.shift();
  globalThis.__virtualMs = Math.max(__virtualMs, t.at);
  t.fn(...t.args);
  return true;
};
const __fmt = (a) => {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || (a.name + ": " + a.message);
  try { return JSON.stringify(a, null, 2) ?? String(a); } catch { return String(a); }
};
globalThis.console = {
  log: (...a) => __log("INFO", a.map(__fmt).join(" ")),
  info: (...a) => __log("INFO", a.map(__fmt).join(" ")),
  debug: (...a) => __log("DEBUG", a.map(__fmt).join(" ")),
  warn: (...a) => __log("WARN", a.map(__fmt).join(" ")),
  error: (...a) => __log("ERROR", a.map(__fmt).join(" ")),
};
globalThis.process = { env: JSON.parse(__envJson), version: "v22.11.0", platform: "linux", argv: [] };
const __cjsCache = {};
const __resolve = (from, name) => {
  if (!name.startsWith(".") && !name.startsWith("/")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of name.replace(/^\/var\/task\//, "").split("/")) {
    if (seg === "..") parts.pop(); else if (seg !== "." && seg) parts.push(seg);
  }
  const base = parts.join("/");
  for (const c of [base, base + ".js", base + ".cjs", base + ".json", base + "/index.js"]) if (c in __files) return c;
  return null;
};
globalThis.__require = (from, name) => {
  const path = __resolve(from, name);
  if (path === null) {
    const e = new Error("Cannot find module '" + name + "'\nRequire stack:\n- /var/task/" + from + "\n- /var/runtime/index.mjs");
    e.code = "MODULE_NOT_FOUND";
    throw e;
  }
  if (__cjsCache[path]) return __cjsCache[path].exports;
  const module = { exports: {} };
  __cjsCache[path] = module;
  if (path.endsWith(".json")) { module.exports = JSON.parse(__files[path]); return module.exports; }
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", __files[path] + "\n//# sourceURL=/var/task/" + path);
  fn(module.exports, (n) => __require(path, n), module, "/var/task/" + path, "/var/task");
  return module.exports;
};
`;

function findModule(files: Record<string, string>, handler: string) {
  const dot = handler.lastIndexOf(".");
  const modulePath = dot > 0 ? handler.slice(0, dot) : handler;
  const fnName = dot > 0 ? handler.slice(dot + 1) : "";
  const pkg = files["package.json"];
  let typeModule = false;
  try {
    typeModule = pkg ? JSON.parse(pkg).type === "module" : false;
  } catch {
    // An invalid package.json is ignored, as Node would only fail if it needed it.
  }
  for (const ext of [".mjs", ".js", ".cjs"]) {
    const file = modulePath + ext;
    if (file in files) return { file, fnName, modulePath, esm: ext === ".mjs" || (ext === ".js" && typeModule) };
  }
  return { file: null, fnName, modulePath, esm: false };
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function runFunction(input: RunInput): Promise<RunOutput> {
  const QuickJS = await engine();
  const rt = QuickJS.newRuntime();
  const memoryMb = Math.min(input.memoryMb, MAX_SANDBOX_MB);
  rt.setMemoryLimit(memoryMb * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  const timeoutMs = input.timeoutSec * 1000;

  const started = Date.now();
  let cpuDeadline = started + CPU_LIMIT_MS;
  let interruptedForTime = false;
  rt.setInterruptHandler(() => {
    if (Date.now() > cpuDeadline) {
      interruptedForTime = true;
      return true;
    }
    return false;
  });

  const logs: string[] = [];
  let logBytes = 0;
  const vm: QuickJSContext = rt.newContext();
  const log = (level: string, message: string) => {
    if (logBytes > MAX_LOG_BYTES) return;
    const line = `${iso(Date.now())}\t${input.requestId}\t${level}\t${message}`;
    logBytes += line.length;
    logs.push(logBytes > MAX_LOG_BYTES ? `${iso(Date.now())}\t${input.requestId}\tWARN\t[CloudLab: further log output dropped, 64 KB limit]` : line);
  };

  const handles: QuickJSHandle[] = [];
  const keep = <T extends QuickJSHandle>(h: T) => {
    handles.push(h);
    return h;
  };
  const setGlobalString = (name: string, value: string) => {
    const h = vm.newString(value);
    vm.setProp(vm.global, name, h);
    h.dispose();
  };
  const virtualMs = () => {
    const r = vm.evalCode("__virtualMs");
    if (r.error) {
      r.error.dispose();
      return 0;
    }
    const v = vm.getNumber(r.value);
    r.value.dispose();
    return v;
  };

  const env: Record<string, string> = {
    AWS_REGION: input.region,
    AWS_DEFAULT_REGION: input.region,
    AWS_LAMBDA_FUNCTION_NAME: input.functionName,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(input.memoryMb),
    AWS_LAMBDA_FUNCTION_VERSION: "$LATEST",
    AWS_EXECUTION_ENV: "AWS_Lambda_nodejs22.x",
    LAMBDA_TASK_ROOT: "/var/task",
    TZ: ":UTC",
    ...input.env,
  };

  let result: unknown;
  let error: FunctionError | undefined;
  let initMs: number | undefined;
  let timedOut = false;

  const toError = (h: QuickJSHandle, fallbackType = "Error"): FunctionError => {
    const v = vm.dump(h) as unknown;
    if (v && typeof v === "object" && "message" in (v as object)) {
      const e = v as { name?: string; message?: string; stack?: string };
      const type = e.name || fallbackType;
      const stack = String(e.stack ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return { errorType: type, errorMessage: String(e.message ?? ""), trace: [`${type}: ${e.message ?? ""}`, ...stack.map((l) => `    ${l}`)] };
    }
    return { errorType: typeof v, errorMessage: typeof v === "string" ? v : JSON.stringify(v) };
  };

  try {
    logs.push(`START RequestId: ${input.requestId} Version: $LATEST`);
    const logFn = keep(
      vm.newFunction("__log", (level, msg) => {
        log(vm.getString(level), vm.getString(msg));
      }),
    );
    vm.setProp(vm.global, "__log", logFn);
    setGlobalString("__envJson", JSON.stringify(env));
    const files = keep(vm.newObject());
    for (const [path, content] of Object.entries(input.files)) {
      const h = vm.newString(content);
      vm.setProp(files, path, h);
      h.dispose();
    }
    vm.setProp(vm.global, "__files", files);
    const prelude = vm.evalCode(PRELUDE, "/var/runtime/bootstrap.js");
    if (prelude.error) throw new Error(`CloudLab runtime failed to start: ${JSON.stringify(vm.dump(prelude.error))}`);
    prelude.value.dispose();

    // ---- init: load the handler's module ----
    const initStart = Date.now();
    const { file, fnName, modulePath, esm } = findModule(input.files, input.handler);
    let handlerFn: QuickJSHandle | null = null;
    if (!file) {
      error = {
        errorType: "Runtime.ImportModuleError",
        errorMessage: `Error: Cannot find module '${modulePath}'\nRequire stack:\n- /var/runtime/index.mjs`,
        trace: [`Runtime.ImportModuleError: Error: Cannot find module '${modulePath}'`, "Require stack:", "- /var/runtime/index.mjs"],
      };
    } else if (esm) {
      rt.setModuleLoader(
        (name) => {
          const path = name.replace(/^\/var\/task\//, "");
          if (path in input.files) return input.files[path];
          return { error: new Error(`Cannot find package '${name}' imported from /var/task/${file}`) };
        },
        (base, requested) => {
          if (!requested.startsWith(".") && !requested.startsWith("/")) return requested;
          const parts = base.replace(/^\/var\/task\//, "").split("/").slice(0, -1);
          for (const seg of requested.split("/")) {
            if (seg === "..") parts.pop();
            else if (seg !== "." && seg) parts.push(seg);
          }
          return parts.join("/");
        },
      );
      const evaluated = vm.evalCode(input.files[file], file, { type: "module" });
      if (evaluated.error) {
        const e = toError(evaluated.error);
        evaluated.error.dispose();
        error = classifyLoadError(e);
      } else {
        let ns: QuickJSHandle = keep(evaluated.value);
        const state = vm.getPromiseState(ns);
        if (state.type === "pending") {
          rt.executePendingJobs();
          const again = vm.getPromiseState(ns);
          if (again.type === "fulfilled") ns = keep(again.value);
          else if (again.type === "rejected") {
            error = classifyLoadError(toError(again.error));
            again.error.dispose();
          }
        } else if (state.type === "fulfilled" && !state.notAPromise) {
          ns = keep(state.value);
        } else if (state.type === "rejected") {
          error = classifyLoadError(toError(state.error));
          state.error.dispose();
        }
        if (!error) {
          const h = keep(vm.getProp(ns, fnName));
          if (vm.typeof(h) === "function") handlerFn = h;
        }
      }
    } else {
      const evaluated = vm.evalCode(`__require("${file}", "./${file}")`, "/var/runtime/index.mjs");
      if (evaluated.error) {
        const e = toError(evaluated.error);
        evaluated.error.dispose();
        error = classifyLoadError(e, input.files[file]);
      } else {
        const exports = keep(evaluated.value);
        const h = keep(vm.getProp(exports, fnName));
        if (vm.typeof(h) === "function") handlerFn = h;
      }
    }
    if (!error && !handlerFn) {
      error = {
        errorType: "Runtime.HandlerNotFound",
        errorMessage: `${input.handler} is undefined or not exported`,
        trace: [`Runtime.HandlerNotFound: ${input.handler} is undefined or not exported`],
      };
    }
    if (input.cold) initMs = Date.now() - initStart + 120;

    // ---- invoke ----
    if (!error && handlerFn) {
      setGlobalString("__eventJson", JSON.stringify(input.event ?? {}));
      const ctxCode = `({
        functionName: ${JSON.stringify(input.functionName)},
        functionVersion: "$LATEST",
        invokedFunctionArn: ${JSON.stringify(input.functionArn)},
        memoryLimitInMB: ${JSON.stringify(String(input.memoryMb))},
        awsRequestId: ${JSON.stringify(input.requestId)},
        logGroupName: ${JSON.stringify(`/aws/lambda/${input.functionName}`)},
        logStreamName: ${JSON.stringify(`${iso(Date.now()).slice(0, 10).replace(/-/g, "/")}/[$LATEST]${input.requestId.replace(/-/g, "")}`)},
        callbackWaitsForEmptyEventLoop: true,
        getRemainingTimeInMillis: () => Math.max(0, ${timeoutMs} - __virtualMs),
      })`;
      const event = keep(vm.unwrapResult(vm.evalCode("JSON.parse(__eventJson)")));
      const context = keep(vm.unwrapResult(vm.evalCode(ctxCode)));
      // Callback-style handlers (event, context, callback) get a callback that settles the call.
      const settle = keep(vm.unwrapResult(vm.evalCode(`(() => { let done; const p = new Promise((res, rej) => { done = (err, value) => err ? rej(err) : res(value); }); globalThis.__cb = done; return p; })()`)));
      const cb = keep(vm.unwrapResult(vm.evalCode("__cb")));
      const arity = vm.getNumber(keep(vm.getProp(handlerFn, "length")));

      cpuDeadline = Date.now() + CPU_LIMIT_MS;
      const called = vm.callFunction(handlerFn, vm.undefined, event, context, cb);
      let outcome: QuickJSHandle | null = null;
      if (called.error) {
        error = toError(called.error);
        called.error.dispose();
      } else {
        const returned = keep(called.value);
        const isPromise = vm.getPromiseState(returned);
        // A non-async handler that takes a callback and returns nothing finishes through the callback.
        outcome = arity >= 3 && isPromise.type === "fulfilled" && isPromise.notAPromise && vm.typeof(returned) === "undefined" ? settle : returned;

        for (;;) {
          const jobs = rt.executePendingJobs();
          if (jobs.error) {
            if (interruptedForTime) break;
            error = toError(jobs.error);
            jobs.error.dispose();
            break;
          }
          if (virtualMs() > timeoutMs) {
            timedOut = true;
            break;
          }
          const s = vm.getPromiseState(outcome);
          if (s.type === "fulfilled") {
            result = dumpJson(vm, s.value);
            if (!s.notAPromise) s.value.dispose();
            break;
          }
          if (s.type === "rejected") {
            error = toError(s.error);
            s.error.dispose();
            break;
          }
          const next = vm.evalCode("__runNextTimer()");
          if (next.error) {
            if (interruptedForTime) break;
            error = toError(next.error);
            next.error.dispose();
            break;
          }
          const ran = vm.dump(next.value);
          next.value.dispose();
          if (!ran) {
            if (virtualMs() > timeoutMs) timedOut = true;
            else {
              error = { errorType: "Runtime.NodeJsExit", errorMessage: "Runtime exited without providing a reason" };
            }
            break;
          }
        }
      }
      if (interruptedForTime) timedOut = true;
    }
  } catch (e) {
    if (interruptedForTime) timedOut = true;
    else if (String(e).includes("out of memory")) {
      error = { errorType: "Runtime.OutOfMemory", errorMessage: `RequestId: ${input.requestId} Error: Runtime exited with error: signal: killed` };
    } else {
      error = { errorType: "Runtime.Unknown", errorMessage: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- report ----
  const realMs = Date.now() - started - (initMs ? initMs - 120 : 0);
  let durationMs = Math.max(0.5, realMs + safe(() => virtualMs(), 0));
  let maxMemoryUsedMb = BASE_MEMORY_MB;
  try {
    const usage = rt.computeMemoryUsage();
    const dumped = vm.dump(usage) as { memory_used_size?: number };
    usage.dispose();
    maxMemoryUsedMb = Math.min(input.memoryMb, BASE_MEMORY_MB + Math.ceil((dumped.memory_used_size ?? 0) / (1024 * 1024)));
  } catch {
    // Memory usage is best-effort.
  }
  if (timedOut) {
    durationMs = timeoutMs;
    const reason =
      interruptedForTime && timeoutMs > CPU_LIMIT_MS
        ? `Task timed out after ${(CPU_LIMIT_MS / 1000).toFixed(2)} seconds (CloudLab's limit on real computing time per invocation)`
        : `Task timed out after ${input.timeoutSec.toFixed(2)} seconds`;
    error = { errorType: "Sandbox.Timedout", errorMessage: `${iso(Date.now())} ${input.requestId} ${reason}` };
    logs.push(`${iso(Date.now())} ${input.requestId} ${reason}`);
  }
  if (!error && result !== undefined) {
    const size = JSON.stringify(result ?? null).length;
    if (size > MAX_RESPONSE_BYTES) {
      error = {
        errorType: "Function.ResponseSizeTooLarge",
        errorMessage: `Response payload size exceeded maximum allowed payload size (${MAX_RESPONSE_BYTES} bytes in CloudLab).`,
      };
      result = undefined;
    }
  }
  if (error && !timedOut) {
    logs.push(`${iso(Date.now())}\t${input.requestId}\tERROR\tInvoke Error \t${JSON.stringify(error)}`);
  }
  const billed = Math.max(1, Math.ceil(durationMs));
  logs.push(`END RequestId: ${input.requestId}`);
  logs.push(
    `REPORT RequestId: ${input.requestId}\tDuration: ${durationMs.toFixed(2)} ms\tBilled Duration: ${billed} ms\tMemory Size: ${input.memoryMb} MB\tMax Memory Used: ${maxMemoryUsedMb} MB${initMs !== undefined ? `\tInit Duration: ${initMs.toFixed(2)} ms` : ""}${timedOut ? "\tStatus: timeout" : ""}`,
  );

  for (const h of handles.reverse()) {
    try {
      if (h.alive) h.dispose();
    } catch {
      // Already gone.
    }
  }
  try {
    vm.dispose();
    rt.dispose();
  } catch {
    // An interrupted runtime may refuse to clean up; it's garbage-collected with the module instance.
  }

  return { result: error ? undefined : (result ?? null), error, logs, durationMs, billedDurationMs: billed, initDurationMs: initMs, maxMemoryUsedMb, timedOut };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The handler's result as JSON (undefined becomes null, as Lambda returns). */
function dumpJson(vm: QuickJSContext, h: QuickJSHandle): unknown {
  const stringify = vm.unwrapResult(vm.evalCode("(v) => JSON.stringify(v === undefined ? null : v)"));
  const r = vm.callFunction(stringify, vm.undefined, h);
  stringify.dispose();
  if (r.error) {
    r.error.dispose();
    return null;
  }
  const text = vm.dump(r.value);
  r.value.dispose();
  return typeof text === "string" ? JSON.parse(text) : null;
}

/** Errors while loading the module get Lambda's Runtime.* types. */
function classifyLoadError(e: FunctionError, source?: string): FunctionError {
  if (e.errorType === "SyntaxError") {
    // CommonJS can't contain ES module syntax: Node says "Unexpected token 'export'" or "Cannot use import statement outside a module".
    let message = e.errorMessage;
    if (source && /^\s*export\s/m.test(source)) message = "Unexpected token 'export'";
    else if (source && /^\s*import\s.+from\s/m.test(source)) message = "Cannot use import statement outside a module";
    return { errorType: "Runtime.UserCodeSyntaxError", errorMessage: `SyntaxError: ${message}`, trace: [`Runtime.UserCodeSyntaxError: SyntaxError: ${message}`] };
  }
  if (/Cannot find (module|package)/.test(e.errorMessage)) {
    const sdk = /'(@aws-sdk\/[^']+|aws-sdk)'/.exec(e.errorMessage);
    const message = sdk ? `${e.errorMessage}\n(CloudLab can't run AWS SDK calls from functions yet.)` : e.errorMessage;
    return { errorType: "Runtime.ImportModuleError", errorMessage: `Error: ${message}`, trace: [`Runtime.ImportModuleError: Error: ${message}`] };
  }
  return e;
}

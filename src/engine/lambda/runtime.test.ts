import { describe, expect, it } from "vitest";
import { runFunction, type RunInput } from "./runtime";

const base = (files: Record<string, string>, extra: Partial<RunInput> = {}): RunInput => ({
  files,
  handler: "index.handler",
  event: { name: "Ada" },
  env: { STAGE: "test" },
  functionName: "hello",
  functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hello",
  memoryMb: 128,
  timeoutSec: 3,
  requestId: "11111111-2222-3333-4444-555555555555",
  region: "us-east-1",
  cold: true,
  ...extra,
});

describe("Lambda runtime (QuickJS sandbox)", { timeout: 30_000 }, () => {
  it("runs an async ES module handler with imports, env and context", async () => {
    const out = await runFunction(
      base({
        "index.mjs": `import { greet } from "./lib/greet.mjs";
export const handler = async (event, context) => {
  console.log("event", event);
  return { statusCode: 200, body: greet(event.name), stage: process.env.STAGE, fn: context.functionName, region: process.env.AWS_REGION };
};`,
        "lib/greet.mjs": `export const greet = (n) => "Hello, " + n + "!";`,
      }),
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ statusCode: 200, body: "Hello, Ada!", stage: "test", fn: "hello", region: "us-east-1" });
    expect(out.logs[0]).toBe("START RequestId: 11111111-2222-3333-4444-555555555555 Version: $LATEST");
    expect(out.logs[1]).toMatch(/\tINFO\tevent \{\n  "name": "Ada"\n\}$/);
    expect(out.logs.at(-1)).toMatch(/^REPORT RequestId: .*\tBilled Duration: \d+ ms\tMemory Size: 128 MB\tMax Memory Used: \d+ MB\tInit Duration: [\d.]+ ms$/);
  });

  it("runs CommonJS with require, and callback handlers", async () => {
    const out = await runFunction(
      base({
        "index.js": `const { double } = require("./math");
exports.handler = function (event, context, callback) { callback(null, { value: double(21) }); };`,
        "math.js": `module.exports.double = (x) => x * 2;`,
      }),
    );
    expect(out.result).toEqual({ value: 42 });
  });

  it("explains the classic mistakes with Lambda's own error types", async () => {
    // ES module syntax in a .js file without "type": "module".
    let out = await runFunction(base({ "index.js": `export const handler = async () => 1;` }));
    expect(out.error).toMatchObject({ errorType: "Runtime.UserCodeSyntaxError", errorMessage: "SyntaxError: Unexpected token 'export'" });

    out = await runFunction(base({ "index.js": `export const handler = async () => 1;`, "package.json": `{"type":"module"}` }));
    expect(out.result).toBe(1);

    out = await runFunction(base({ "app.mjs": `export const handler = async () => 1;` }));
    expect(out.error?.errorType).toBe("Runtime.ImportModuleError");
    expect(out.error?.errorMessage).toContain("Cannot find module 'index'");

    out = await runFunction(base({ "index.mjs": `export const main = async () => 1;` }));
    expect(out.error).toMatchObject({ errorType: "Runtime.HandlerNotFound", errorMessage: "index.handler is undefined or not exported" });

    out = await runFunction(base({ "index.mjs": `import { S3Client } from "@aws-sdk/client-s3";\nexport const handler = async () => 1;` }));
    expect(out.error?.errorType).toBe("Runtime.ImportModuleError");
    expect(out.error?.errorMessage).toContain("@aws-sdk/client-s3");

    out = await runFunction(base({ "index.mjs": `export const handler = async (e) => { throw new TypeError("bad input: " + e.name); };` }));
    expect(out.error).toMatchObject({ errorType: "TypeError", errorMessage: "bad input: Ada" });
    expect(out.logs.some((l) => l.includes("\tERROR\tInvoke Error"))).toBe(true);
  });

  it("times out on simulated time, and stops runaway loops", async () => {
    const sleepy = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const handler = async () => { await sleep(1500); return "slept"; };`;
    let out = await runFunction(base({ "index.mjs": sleepy }));
    expect(out.result).toBe("slept");
    expect(out.durationMs).toBeGreaterThanOrEqual(1500);

    out = await runFunction(base({ "index.mjs": sleepy }, { timeoutSec: 1 }));
    expect(out.timedOut).toBe(true);
    expect(out.error?.errorMessage).toMatch(/Task timed out after 1\.00 seconds$/);

    const started = Date.now();
    out = await runFunction(base({ "index.mjs": `export const handler = async () => { for (;;) {} };` }, { timeoutSec: 3 }));
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("caps memory", async () => {
    const out = await runFunction(
      base({ "index.mjs": `export const handler = async () => { const a = []; for (;;) a.push("x".repeat(1e5)); };` }, { memoryMb: 128 }),
    );
    expect(out.error).toBeDefined();
    expect(out.result).toBeUndefined();
  });
});

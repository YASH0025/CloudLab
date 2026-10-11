import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { invokeFunction } from "../lambda/invoke";
import { MemoryStore } from "../store";
import { compileFilter } from "./filter";

const A = "acct-logs";
const R = "us-east-1";
let clock: Date;
let engine: Engine;
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const TRUST = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
const BASIC = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

beforeEach(() => {
  clock = new Date("2026-08-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("filter patterns", () => {
  const lines = ["INFO started", "ERROR timeout talking to db", "WARN slow request", "ERROR healthcheck failed", '{"level":"error","ms":120}', '{"level":"info","ms":5}'];
  const run = (p: string) => lines.filter(compileFilter(p));
  it("supports terms, phrases, OR, exclusions and JSON", () => {
    expect(run("")).toHaveLength(6);
    expect(run("ERROR")).toEqual(["ERROR timeout talking to db", "ERROR healthcheck failed"]);
    expect(run("ERROR timeout")).toEqual(["ERROR timeout talking to db"]);
    expect(run('"slow request"')).toEqual(["WARN slow request"]);
    expect(run("?ERROR ?WARN")).toHaveLength(3);
    expect(run("ERROR -healthcheck")).toEqual(["ERROR timeout talking to db"]);
    expect(run('{ $.level = "error" }')).toEqual(['{"level":"error","ms":120}']);
    expect(run("{ $.ms > 100 }")).toEqual(['{"level":"error","ms":120}']);
    expect(run('{ $.level = "err*" || $.ms < 10 }')).toHaveLength(2);
    expect(() => compileFilter("{ level = x }")).toThrow(/Invalid filter pattern/);
  });
});

describe("CloudWatch Logs", { timeout: 30_000 }, () => {
  it("gets Lambda logs only when the role allows it", async () => {
    await engine.create(A, { service: "iam", type: "role", region: "global", config: { name: "bare", trustPolicy: TRUST } });
    const fn = await engine.create(A, {
      service: "lambda",
      type: "function",
      region: R,
      config: { name: "hello", role: "bare", files: { "index.mjs": "export const handler = async (e) => { console.log('hi', e.n); if (e.n === 2) console.error('ERROR bad'); return e.n; };" } },
    });
    later(2_000);
    await invokeFunction(engine, A, await engine.get(A, fn.id), { n: 1 }, "test");
    expect(await engine.list(A, { service: "logs", type: "log-group", region: R })).toEqual([]);
    expect(String((await engine.get(A, fn.id)).attributes.logsDenied)).toContain("Attach AWSLambdaBasicExecutionRole");

    const role = (await engine.list(A, { service: "iam", type: "role", region: "global" }))[0];
    await engine.update(A, role.id, { policyArns: [BASIC] });
    await invokeFunction(engine, A, await engine.get(A, fn.id), { n: 2 }, "test");
    later(1_000);
    await invokeFunction(engine, A, await engine.get(A, fn.id), { n: 3 }, "test");

    const [group] = await engine.list(A, { service: "logs", type: "log-group", region: R });
    expect(group.name).toBe("/aws/lambda/hello");
    expect((await engine.get(A, fn.id)).attributes.logsDenied).toBeNull();
    // Warm calls share a stream; the stream name looks like AWS's.
    const streams = await engine.logs.streams(A, R, "/aws/lambda/hello");
    expect(streams).toHaveLength(1);
    expect(streams[0].stream).toMatch(/^2026\/08\/01\/\[\$LATEST\][0-9a-f]{32}$/);

    const page = await engine.logs.events(A, R, "/aws/lambda/hello", { streams: [streams[0].stream] });
    expect(page.events[0].message).toMatch(/^START RequestId: /);
    expect(page.events.some((e) => e.message.includes("\tINFO\thi 3"))).toBe(true);

    const errors = await engine.logs.filter(A, R, "/aws/lambda/hello", { pattern: "ERROR bad" });
    expect(errors).toHaveLength(1);

    // A cold start opens a new stream.
    later(10 * 60_000);
    await invokeFunction(engine, A, await engine.get(A, fn.id), { n: 4 }, "test");
    expect(await engine.logs.streams(A, R, "/aws/lambda/hello")).toHaveLength(2);
  });

  it("applies retention and deletes events with the group", async () => {
    const g = await engine.create(A, { service: "logs", type: "log-group", region: R, config: { name: "/app/web", retentionInDays: "1" } });
    await expect(engine.create(A, { service: "logs", type: "log-group", region: R, config: { name: "/app/web" } })).rejects.toMatchObject({
      code: "ResourceAlreadyExistsException",
    });
    await expect(engine.create(A, { service: "logs", type: "log-group", region: R, config: { name: "/x", retentionInDays: "4" } })).rejects.toMatchObject({
      code: "InvalidParameterException",
    });
    const t = clock.getTime();
    await engine.logs.put(A, R, "/app/web", "web-1", [
      { timestamp: t - 2 * 24 * 60 * 60_000, message: "old" },
      { timestamp: t, message: "new" },
    ]);
    expect((await engine.logs.events(A, R, "/app/web")).events.map((e) => e.message)).toEqual(["new"]);
    await expect(engine.logs.put(A, R, "/missing", "s", [{ timestamp: t, message: "x" }])).rejects.toMatchObject({ code: "ResourceNotFoundException" });

    await engine.remove(A, g.id);
    await engine.create(A, { service: "logs", type: "log-group", region: R, config: { name: "/app/web" } });
    expect((await engine.logs.events(A, R, "/app/web")).events).toEqual([]);
  });
});

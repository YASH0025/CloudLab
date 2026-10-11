import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { invokeFunction } from "../lambda/invoke";
import { MemoryStore } from "../store";

const A = "acct-metrics";
const R = "us-east-1";
let clock: Date;
let engine: Engine;
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const TRUST = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });

beforeEach(() => {
  clock = new Date("2026-07-01T10:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("CloudWatch metrics", { timeout: 30_000 }, () => {
  it("records Lambda invocations, errors and duration, and computes statistics per period", async () => {
    await engine.create(A, { service: "iam", type: "role", region: "global", config: { name: "r", trustPolicy: TRUST } });
    const fn = await engine.create(A, {
      service: "lambda",
      type: "function",
      region: R,
      config: { name: "calc", role: "r", files: { "index.mjs": "export const handler = async (e) => { if (e.fail) throw new Error('no'); return 1; };" } },
    });
    later(2_000);
    for (let i = 0; i < 3; i++) await invokeFunction(engine, A, await engine.get(A, fn.id), {}, "test");
    later(60_000);
    await invokeFunction(engine, A, await engine.get(A, fn.id), { fail: true }, "test");

    const q = (name: string, statistics: ("Sum" | "Average" | "SampleCount" | "Maximum")[], period = 60) =>
      engine.metrics.statistics(A, R, {
        namespace: "AWS/Lambda",
        name,
        dimensions: [{ Name: "FunctionName", Value: "calc" }],
        start: new Date("2026-07-01T09:00:00Z"),
        end: new Date("2026-07-01T11:00:00Z"),
        period,
        statistics,
      });
    expect((await q("Invocations", ["Sum"])).map((d) => d.Sum)).toEqual([3, 1]);
    expect((await q("Errors", ["Sum"])).map((d) => d.Sum)).toEqual([0, 1]);
    expect((await q("Invocations", ["Sum"], 3600)).map((d) => [d.Timestamp, d.Sum])).toEqual([["2026-07-01T10:00:00Z", 4]]);
    const duration = await q("Duration", ["Average", "SampleCount", "Maximum"]);
    expect(duration[0]).toMatchObject({ SampleCount: 3, Unit: "Milliseconds" });

    // The same metric without dimensions covers every function.
    const all = await engine.metrics.statistics(A, R, { namespace: "AWS/Lambda", name: "Invocations", dimensions: [], start: new Date("2026-07-01T09:00:00Z"), end: new Date("2026-07-01T11:00:00Z"), period: 3600, statistics: ["Sum"] });
    expect(all[0].Sum).toBe(4);

    const listed = await engine.metrics.list(A, R, { namespace: "AWS/Lambda" });
    expect(listed.map((m) => `${m.name}:${m.dimensions}`)).toContain("Invocations:FunctionName=calc");
  });

  it("validates like CloudWatch and accepts custom metrics", async () => {
    const base = { namespace: "Shop", name: "Orders", dimensions: [], start: new Date("2026-07-01T09:00:00Z"), end: new Date("2026-07-01T11:00:00Z"), statistics: ["Sum" as const] };
    await expect(engine.metrics.statistics(A, R, { ...base, period: 90 })).rejects.toMatchObject({ message: "The parameter Period must be a multiple of 60." });
    await expect(engine.metrics.statistics(A, R, { ...base, period: 60, start: new Date("2026-06-01T00:00:00Z") })).rejects.toMatchObject({
      code: "InvalidParameterCombination",
    });
    await expect(engine.metrics.putData(A, R, "AWS/EC2", [{ name: "x", dimensions: [], value: 1 }])).rejects.toMatchObject({
      message: "The value AWS/EC2 for parameter Namespace is invalid.",
    });
    await engine.metrics.putData(A, R, "Shop", [
      { name: "Orders", dimensions: [], value: 5, unit: "Count" },
      { name: "Orders", dimensions: [], value: 7, unit: "Count" },
    ]);
    expect(await engine.metrics.statistics(A, R, { ...base, period: 300 })).toEqual([{ Timestamp: "2026-07-01T10:00:00Z", Sum: 12, Unit: "Count" }]);
  });

  it("simulates CPU for instances that don't really run, and stops when they stop", async () => {
    await engine.ensureDefaults(A, R);
    const [subnet] = await engine.list(A, { service: "networking", type: "subnet", region: R });
    const i = await engine.create(A, { service: "compute", type: "instance", region: R, config: { imageId: "ami-0lab2023linux0001", subnetId: subnet.id } });
    later(10 * 60_000);
    const q = () =>
      engine.metrics.statistics(A, R, {
        namespace: "AWS/EC2",
        name: "CPUUtilization",
        dimensions: [{ Name: "InstanceId", Value: i.id }],
        start: new Date("2026-07-01T09:00:00Z"),
        end: new Date("2026-07-01T11:00:00Z"),
        period: 60,
        statistics: ["Average"],
      });
    const points = await q();
    expect(points.length).toBe(10);
    expect(points.every((p) => p.Average! > 0 && p.Average! < 10 && p.Unit === "Percent")).toBe(true);
    expect((await q()).map((p) => p.Average)).toEqual(points.map((p) => p.Average)); // same on every read
    await engine.runAction(A, i.id, "stop");
    later(60_000);
    expect(await q()).toEqual([]);
  });
});

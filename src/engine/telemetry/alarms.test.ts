import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { invokeFunction } from "../lambda/invoke";
import { parseDashboardBody } from "../services/cloudwatch";
import { MemoryStore } from "../store";

const A = "acct-alarms";
const R = "us-east-1";
let clock: Date;
let engine: Engine;
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const tick = async (ms: number) => {
  later(ms);
  await engine.ensureDefaults(A, R);
};
const TRUST = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });

beforeEach(() => {
  clock = new Date("2026-09-01T10:00:30Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("CloudWatch alarms", { timeout: 30_000 }, () => {
  it("goes to ALARM when Lambda errors, and back to OK, with AWS-style reasons and history", async () => {
    await engine.create(A, { service: "iam", type: "role", region: "global", config: { name: "r", trustPolicy: TRUST } });
    const fn = await engine.create(A, {
      service: "lambda",
      type: "function",
      region: R,
      config: { name: "risky", role: "r", files: { "index.mjs": "export const handler = async (e) => { if (e.fail) throw new Error('boom'); return 'ok'; };" } },
    });
    const alarm = await engine.create(A, {
      service: "cloudwatch",
      type: "alarm",
      region: R,
      config: {
        name: "risky-errors",
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: [{ name: "FunctionName", value: "risky" }],
        statistic: "Sum",
        period: 60,
        evaluationPeriods: 1,
        comparisonOperator: "GreaterThanThreshold",
        threshold: 0,
        treatMissingData: "notBreaching",
      },
    });
    expect(alarm.attributes).toMatchObject({ stateValue: "INSUFFICIENT_DATA", conditionText: "Errors > 0 for 1 of 1 × 1 min" });

    // No data, treated as not breaching: OK.
    await tick(60_000);
    expect((await engine.get(A, alarm.id)).attributes.stateValue).toBe("OK");

    await invokeFunction(engine, A, await engine.get(A, fn.id), { fail: true }, "test");
    await tick(60_000); // the minute with the error is now complete
    const fired = await engine.get(A, alarm.id);
    expect(fired.attributes.stateValue).toBe("ALARM");
    expect(fired.attributes.stateReason).toMatch(
      /^Threshold Crossed: 1 out of the last 1 datapoints \[1 \(01\/09\/26 10:01:00\)\] was greater than the threshold \(0\) \(minimum 1 datapoint for OK -> ALARM transition\)\.$/,
    );

    await invokeFunction(engine, A, await engine.get(A, fn.id), {}, "test");
    await tick(60_000);
    const history = (await engine.get(A, alarm.id)).attributes.history as { summary: string }[];
    expect((await engine.get(A, alarm.id)).attributes.stateValue).toBe("OK");
    expect(history.map((h) => h.summary).slice(0, 3)).toEqual([
      "Alarm updated from ALARM to OK",
      "Alarm updated from OK to ALARM",
      "Alarm updated from INSUFFICIENT_DATA to OK",
    ]);
  });

  it("needs M of N datapoints, and reports missing data", async () => {
    const make = (name: string, extra: Record<string, unknown>) =>
      engine.create(A, {
        service: "cloudwatch",
        type: "alarm",
        region: R,
        config: { name, namespace: "Shop", metricName: "Latency", statistic: "Average", period: 60, evaluationPeriods: 3, comparisonOperator: "GreaterThanThreshold", threshold: 100, ...extra },
      });
    const twoOfThree = await make("slow", { datapointsToAlarm: 2 });
    const missing = await make("quiet", {});
    await expect(make("bad", { datapointsToAlarm: 5 })).rejects.toMatchObject({ message: "DatapointsToAlarm must be less than or equal to EvaluationPeriods." });

    const put = (value: number) => engine.metrics.putData(A, R, "Shop", [{ name: "Latency", dimensions: [], value }]);
    await put(150);
    await tick(60_000);
    await put(50);
    await tick(60_000);
    await put(180);
    await tick(60_000);
    expect((await engine.get(A, twoOfThree.id)).attributes.stateValue).toBe("ALARM");
    await tick(60 * 60_000);
    expect((await engine.get(A, missing.id)).attributes).toMatchObject({ stateValue: "INSUFFICIENT_DATA", stateReason: "Insufficient Data: 3 datapoints were unknown." });
  });

  it("parses dashboard bodies like PutDashboard, including '.' shorthand", () => {
    const widgets = parseDashboardBody(
      JSON.stringify({
        widgets: [
          {
            type: "metric",
            width: 12,
            properties: {
              title: "Lambda",
              stat: "Sum",
              period: 60,
              metrics: [["AWS/Lambda", "Invocations", "FunctionName", "hello"], [".", "Errors", ".", "."], ["AWS/Lambda", "Duration", "FunctionName", "hello", { stat: "Average" }]],
            },
          },
          { type: "text", properties: { markdown: "# My app" } },
        ],
      }),
    );
    expect(widgets[0].lines.map((l) => [l.namespace, l.name, l.dimensions[0]?.Value, l.stat])).toEqual([
      ["AWS/Lambda", "Invocations", "hello", undefined],
      ["AWS/Lambda", "Errors", "hello", undefined],
      ["AWS/Lambda", "Duration", "hello", "Average"],
    ]);
    expect(widgets[1]).toMatchObject({ type: "text", markdown: "# My app" });
    expect(() => parseDashboardBody('{"widgets":[{"type":"metric"}]}')).toThrow(/Should have required property 'properties'/);
  });
});

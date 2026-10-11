import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { accountNumber } from "@/engine/ids";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-cw-cli";
let files: Record<string, string> = {};
const ctx = () => ({ engine, accountId: ACCOUNT, region: "us-east-1", files });
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const run = (line: string) => executeCli(line, ctx());
async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  const m = /\(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[3] };
}
const zip = (entries: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])))).toString("base64");

beforeEach(() => {
  clock = new Date("2026-10-01T12:00:10Z");
  engine = new Engine(new MemoryStore(), () => clock);
  files = {};
});

describe("aws cloudwatch", { timeout: 30_000 }, () => {
  it("puts custom metrics, gets statistics and runs an alarm", async () => {
    await json("aws cloudwatch put-metric-data --namespace Shop --metric-name Orders --value 3 --unit Count --dimensions Store=pune");
    await json("aws cloudwatch put-metric-data --namespace Shop --metric-name Orders --value 4 --unit Count --dimensions Store=pune");
    expect(await fails("aws cloudwatch put-metric-data --namespace AWS/EC2 --metric-name X --value 1")).toMatchObject({
      code: "InvalidParameterValue",
      message: "The value AWS/EC2 for parameter Namespace is invalid.",
    });
    const stats = await json(
      "aws cloudwatch get-metric-statistics --namespace Shop --metric-name Orders --dimensions Name=Store,Value=pune --start-time 2026-10-01T11:00:00Z --end-time 2026-10-01T13:00:00Z --period 60 --statistics Sum Average",
    );
    expect(stats).toEqual({ Label: "Orders", Datapoints: [{ Timestamp: "2026-10-01T12:00:00Z", Sum: 7, Average: 3.5, Unit: "Count" }] });
    expect((await json("aws cloudwatch list-metrics --namespace Shop")).Metrics).toEqual([{ Namespace: "Shop", MetricName: "Orders", Dimensions: [{ Name: "Store", Value: "pune" }] }]);

    await json(
      "aws cloudwatch put-metric-alarm --alarm-name few-orders --namespace Shop --metric-name Orders --dimensions Name=Store,Value=pune --statistic Sum --period 60 --evaluation-periods 1 --threshold 5 --comparison-operator LessThanThreshold --treat-missing-data breaching",
    );
    let alarm = (await json("aws cloudwatch describe-alarms --alarm-names few-orders")).MetricAlarms[0];
    // Checked at once: the last complete minute had no data, and missing data counts as breaching here.
    expect(alarm).toMatchObject({ AlarmName: "few-orders", StateValue: "ALARM", Threshold: 5, Dimensions: [{ Name: "Store", Value: "pune" }] });

    advance(60_000);
    await json("aws cloudwatch describe-alarms");
    alarm = (await json("aws cloudwatch describe-alarms --alarm-names few-orders")).MetricAlarms[0];
    expect(alarm.StateValue).toBe("OK"); // 7 orders, not less than 5

    await json('aws cloudwatch set-alarm-state --alarm-name few-orders --state-value ALARM --state-reason "testing notifications"');
    expect((await json("aws cloudwatch describe-alarms --state-value ALARM")).MetricAlarms).toHaveLength(1);
    const history = (await json("aws cloudwatch describe-alarm-history --alarm-name few-orders --history-item-type StateUpdate")).AlarmHistoryItems;
    expect(history[0]).toMatchObject({ HistorySummary: "Alarm updated from OK to ALARM", AlarmType: "MetricAlarm" });
    expect(JSON.parse(history[0].HistoryData).newState.stateReason).toBe("testing notifications");

    expect(await fails("aws cloudwatch delete-alarms --alarm-names nope")).toMatchObject({ code: "ResourceNotFound", message: "1 alarms not found" });
    await json("aws cloudwatch delete-alarms --alarm-names few-orders");
    expect((await json("aws cloudwatch describe-alarms")).MetricAlarms).toEqual([]);
  });

  it("stores dashboards", async () => {
    const body = JSON.stringify({ widgets: [{ type: "metric", properties: { metrics: [["Shop", "Orders"]], period: 60, stat: "Sum" } }] });
    expect(await json(`aws cloudwatch put-dashboard --dashboard-name shop --dashboard-body '${body}'`)).toEqual({ DashboardValidationMessages: [] });
    expect((await json("aws cloudwatch get-dashboard --dashboard-name shop")).DashboardBody).toBe(body);
    expect((await json("aws cloudwatch list-dashboards")).DashboardEntries[0]).toMatchObject({ DashboardName: "shop" });
    expect((await fails(`aws cloudwatch put-dashboard --dashboard-name bad --dashboard-body '{"widgets":[{"type":"chart"}]}'`)).code).toBe("InvalidParameterInput");
  });
});

describe("aws logs", { timeout: 30_000 }, () => {
  it("reads Lambda logs with tail, filter-log-events and get-log-events", async () => {
    const trust = `'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'`;
    await json(`aws iam create-role --role-name fn --assume-role-policy-document ${trust}`);
    await json("aws iam attach-role-policy --role-name fn --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole");
    files["f.zip"] = zip({ "index.mjs": "export const handler = async (e) => { console.log('order', e.id); if (e.id === 2) console.error('ERROR payment declined'); return e.id; };" });
    await json(
      `aws lambda create-function --function-name orders --runtime nodejs22.x --handler index.handler --role arn:aws:iam::${accountNumber(ACCOUNT)}:role/fn --zip-file fileb://f.zip`,
    );
    advance(2_000);
    for (const id of [1, 2]) await run(`aws lambda invoke --function-name orders --cli-binary-format raw-in-base64-out --payload '{"id":${id}}' out.json`);

    const groups = (await json("aws logs describe-log-groups --log-group-name-prefix /aws/lambda")).logGroups;
    expect(groups.map((g: { logGroupName: string }) => g.logGroupName)).toEqual(["/aws/lambda/orders"]);

    const tail = (await run("aws logs tail /aws/lambda/orders --since 1h")).output.split("\n");
    expect(tail[0]).toMatch(/^2026-10-01T12:00:12\.\d{3}000\+00:00 2026\/10\/01\/\[\$LATEST\][0-9a-f]{32} START RequestId: /);
    expect(tail.some((l) => l.includes("INFO\torder 2"))).toBe(true);

    const found = (await json('aws logs filter-log-events --log-group-name /aws/lambda/orders --filter-pattern "ERROR payment"')).events;
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("ERROR payment declined");

    const stream = (await json("aws logs describe-log-streams --log-group-name /aws/lambda/orders --order-by LastEventTime --descending")).logStreams[0].logStreamName;
    const events = (await json(`aws logs get-log-events --log-group-name /aws/lambda/orders --log-stream-name '${stream}' --start-from-head --limit 1`)).events;
    expect(events[0].message).toMatch(/^START RequestId/);

    expect(await fails("aws logs put-retention-policy --log-group-name /aws/lambda/orders --retention-in-days 4")).toMatchObject({ code: "InvalidParameterException" });
    await json("aws logs put-retention-policy --log-group-name /aws/lambda/orders --retention-in-days 7");
    expect((await json("aws logs describe-log-groups")).logGroups[0].retentionInDays).toBe(7);
  });

  it("writes your own events", async () => {
    await json("aws logs create-log-group --log-group-name /shop/web");
    expect(await fails("aws logs create-log-group --log-group-name /shop/web")).toMatchObject({ code: "ResourceAlreadyExistsException" });
    expect(await fails(`aws logs put-log-events --log-group-name /shop/web --log-stream-name web-1 --log-events timestamp=${clock.getTime()},message=hi`)).toMatchObject({
      code: "ResourceNotFoundException",
      message: "The specified log stream does not exist.",
    });
    await json("aws logs create-log-stream --log-group-name /shop/web --log-stream-name web-1");
    await json(`aws logs put-log-events --log-group-name /shop/web --log-stream-name web-1 --log-events timestamp=${clock.getTime()},message=checkout-ok timestamp=${clock.getTime() + 1},message=checkout-failed`);
    expect((await json("aws logs filter-log-events --log-group-name /shop/web --filter-pattern failed")).events).toHaveLength(1);
    expect(await fails("aws logs describe-log-streams --log-group-name /nope")).toMatchObject({ message: "The specified log group does not exist." });
  });
});

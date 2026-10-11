import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-r53-cli";
const files: Record<string, string> = {};
const run = (line: string) => executeCli(line, { engine, accountId: ACCOUNT, region: "us-east-1", files });
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
const batch = (changes: unknown[]) => `'${JSON.stringify({ Changes: changes })}'`;

beforeEach(() => {
  clock = new Date("2026-10-01T12:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws route53", { timeout: 30_000 }, () => {
  it("creates a zone, changes records in batches and answers dig, nslookup and test-dns-answer", async () => {
    const made = await json("aws route53 create-hosted-zone --name myshop.com --caller-reference first");
    const id = made.HostedZone.Id.split("/").pop();
    expect(made).toMatchObject({ HostedZone: { Name: "myshop.com.", ResourceRecordSetCount: 2, Config: { PrivateZone: false } }, ChangeInfo: { Status: "PENDING" } });
    expect(made.DelegationSet.NameServers).toHaveLength(4);
    expect(await fails("aws route53 create-hosted-zone --name other.com --caller-reference first")).toMatchObject({ code: "HostedZoneAlreadyExists" });

    await json(
      `aws route53 change-resource-record-sets --hosted-zone-id /hostedzone/${id} --change-batch ${batch([
        { Action: "CREATE", ResourceRecordSet: { Name: "www.myshop.com", Type: "A", TTL: 300, ResourceRecords: [{ Value: "203.0.113.10" }] } },
        { Action: "CREATE", ResourceRecordSet: { Name: "myshop.com", Type: "A", AliasTarget: { HostedZoneId: id, DNSName: "www.myshop.com", EvaluateTargetHealth: false } } },
        { Action: "CREATE", ResourceRecordSet: { Name: "myshop.com", Type: "MX", TTL: 3600, ResourceRecords: [{ Value: "10 mail.myshop.com" }] } },
      ])}`,
    );
    // All or nothing: the second change fails, so the first is undone too.
    expect(
      await fails(
        `aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch ${batch([
          { Action: "CREATE", ResourceRecordSet: { Name: "api.myshop.com", Type: "A", TTL: 60, ResourceRecords: [{ Value: "203.0.113.20" }] } },
          { Action: "CREATE", ResourceRecordSet: { Name: "www.myshop.com", Type: "A", TTL: 60, ResourceRecords: [{ Value: "203.0.113.21" }] } },
        ])}`,
      ),
    ).toEqual({ code: "InvalidChangeBatch", message: "[Tried to create resource record set [name='www.myshop.com.', type='A'] but it already exists]" });

    const list = (await json(`aws route53 list-resource-record-sets --hosted-zone-id ${id}`)).ResourceRecordSets;
    expect(list.map((r: { Name: string; Type: string }) => `${r.Name} ${r.Type}`)).toEqual(["myshop.com. A", "myshop.com. MX", "myshop.com. NS", "myshop.com. SOA", "www.myshop.com. A"]);
    expect(list[0].AliasTarget).toEqual({ HostedZoneId: id, DNSName: "www.myshop.com.", EvaluateTargetHealth: false });

    await json(
      `aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch ${batch([
        { Action: "UPSERT", ResourceRecordSet: { Name: "www.myshop.com", Type: "A", TTL: 60, ResourceRecords: [{ Value: "203.0.113.11" }] } },
      ])}`,
    );
    expect((await run("dig +short myshop.com")).output).toBe("203.0.113.11");
    const dig = (await run("dig www.myshop.com")).output;
    expect(dig).toContain("status: NOERROR");
    expect(dig).toMatch(/www\.myshop\.com\.\s+\t60\tIN\tA\t203\.0\.113\.11/);
    expect((await run("dig nope.myshop.com")).output).toContain("status: NXDOMAIN");
    expect((await run("nslookup -type=MX myshop.com")).output).toContain("myshop.com\tmail exchanger = 10 mail.myshop.com");
    expect((await run("nslookup google.com")).output).toContain("** server can't find google.com: NXDOMAIN");
    expect(await json(`aws route53 test-dns-answer --hosted-zone-id ${id} --record-name www.myshop.com --record-type A`)).toMatchObject({ RecordData: ["203.0.113.11"], ResponseCode: "NOERROR" });

    expect(
      await fails(`aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch ${batch([{ Action: "DELETE", ResourceRecordSet: { Name: "www.myshop.com", Type: "A", TTL: 60, ResourceRecords: [{ Value: "1.2.3.4" }] } }])}`),
    ).toMatchObject({ message: "[Tried to delete resource record set [name='www.myshop.com.', type='A'] but the values provided do not match the current values]" });
    expect(await fails(`aws route53 delete-hosted-zone --id ${id}`)).toMatchObject({ code: "HostedZoneNotEmpty" });
    expect((await run("curl http://www.myshop.com")).output).toContain("curl: (28) Failed to connect to www.myshop.com port 80");
  });

  it("creates health checks", async () => {
    const hc = await json("aws route53 create-health-check --caller-reference hc1 --health-check-config Type=HTTP,IPAddress=203.0.113.10,Port=80,ResourcePath=/");
    expect(hc.HealthCheck.HealthCheckConfig).toMatchObject({ IPAddress: "203.0.113.10", Type: "HTTP", RequestInterval: 30, FailureThreshold: 3 });
    const status = await json(`aws route53 get-health-check-status --health-check-id ${hc.HealthCheck.Id}`);
    expect(status.HealthCheckObservations[0].StatusReport.Status).toMatch(/^Failure: /);
    expect(await fails("aws route53 get-health-check --health-check-id 00000000-0000-4000-8000-000000000000")).toMatchObject({ code: "NoSuchHealthCheck" });
    expect(await fails('aws route53 create-health-check --caller-reference hc2 --health-check-config \'{"Type":"HTTP","IPAddress":"10.0.0.5","Port":80}\'')).toMatchObject({
      code: "InvalidInput",
    });
  });
});

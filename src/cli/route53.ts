import { EngineError } from "@/engine/errors";
import { healthCheckStatus, resolve } from "@/engine/route53/dns";
import {
  aliasTargetKind,
  aliasZoneId,
  bareZoneId,
  nameServersFor,
  newChangeId,
  normalizeName,
  recordConfig,
  recordValues,
} from "@/engine/services/route53";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { ClientSideError, LocalPathError, parseShorthand } from "./parse";

/**
 * `aws route53`: hosted zones, record sets (changed in batches, as the real API
 * does) and health checks. Route 53 is global, so --region doesn't matter.
 */

const cmd = (c: Command) => c;
const GLOBAL = "global";

const listOf = (ctx: CliContext, type: string) => ctx.engine.list(ctx.accountId, { service: "route53", type, region: GLOBAL });
const create = (ctx: CliContext, type: string, config: Record<string, unknown>) => ctx.engine.create(ctx.accountId, { service: "route53", type, region: GLOBAL, config });
const zoneArn = (id: string) => `arn:aws:route53:::hostedzone/${bareZoneId(id)}`;

async function zoneById(ctx: CliContext, raw: string): Promise<Resource> {
  const id = bareZoneId(raw);
  const zone = (await listOf(ctx, "hosted-zone")).find((z) => z.id === id);
  if (!zone) throw new EngineError("NoSuchHostedZone", `No hosted zone found with ID: ${id}`, 404);
  return zone;
}

async function healthCheckById(ctx: CliContext, id: string): Promise<Resource> {
  const hc = (await listOf(ctx, "health-check")).find((h) => h.id === id);
  if (!hc) throw new EngineError("NoSuchHealthCheck", `A health check with id ${id} does not exist.`, 404);
  return hc;
}

/** --change-batch '{…}' or file://batch.json */
function jsonArg(ctx: CliContext, option: string, value: string): Record<string, unknown> {
  let text = value;
  const m = /^file:\/\/(.+)$/.exec(value);
  if (m) {
    const data = ctx.files?.[m[1]];
    if (data === undefined) throw new LocalPathError(m[1]);
    text = Buffer.from(data, "base64").toString("utf8");
  }
  const t = text.trim();
  if (!t.startsWith("{")) return parseShorthand(t) as Record<string, unknown>;
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new ClientSideError(`\nError parsing parameter '--${option}': Invalid JSON: ${(e as Error).message}\nJSON received: ${t}`);
  }
}

const changeInfo = (ctx: CliContext, comment?: string) => ({
  Id: `/change/${newChangeId()}`,
  Status: "PENDING",
  SubmittedAt: ctx.engine.now().toISOString(),
  ...(comment ? { Comment: comment } : {}),
});

// ---------- output shapes ----------

function zoneOut(z: Resource) {
  return {
    Id: `/hostedzone/${z.id}`,
    Name: `${z.name}.`,
    CallerReference: String(z.attributes.callerReference ?? z.createdAt),
    Config: { ...(z.config.comment ? { Comment: z.config.comment } : {}), PrivateZone: false },
    ResourceRecordSetCount: Number(z.attributes.recordCount ?? 2),
  };
}

/** AWS lists records sorted by name with the labels reversed (com.myshop.www), then by type. */
const sortKey = (r: Resource) => `${r.name.split(".").reverse().join(".")} ${r.config.type} ${r.config.setIdentifier ?? ""}`;

async function recordOut(ctx: CliContext, r: Resource, zone: Resource) {
  const c = recordConfig(r);
  const out: Record<string, unknown> = { Name: `${r.name}.`, Type: c.type };
  if (c.setIdentifier) out.SetIdentifier = c.setIdentifier;
  if (c.routingPolicy === "weighted") out.Weight = c.weight;
  if (c.routingPolicy === "failover") out.Failover = c.failover;
  if (c.alias && c.aliasTarget) {
    const kind = await aliasTargetKind(c.aliasTarget, zone, {
      listAll: (service, type) => ctx.engine.list(ctx.accountId, { service, type }),
      list: (service, type) => listOf(ctx, type),
    });
    out.AliasTarget = { HostedZoneId: kind ? aliasZoneId(kind) : zone.id, DNSName: `${c.aliasTarget}.`, EvaluateTargetHealth: c.evaluateTargetHealth === true };
  } else {
    out.TTL = c.ttl;
    out.ResourceRecords = recordValues(r).map((Value) => ({ Value }));
  }
  if (c.healthCheckId) out.HealthCheckId = c.healthCheckId;
  return out;
}

function healthCheckOut(h: Resource) {
  const c = h.config as Record<string, unknown>;
  return {
    Id: h.id,
    CallerReference: String(h.attributes.callerReference ?? h.createdAt),
    HealthCheckConfig: {
      ...(c.ipAddress ? { IPAddress: c.ipAddress } : {}),
      Port: c.port,
      Type: c.type,
      ...(c.resourcePath ? { ResourcePath: c.resourcePath } : {}),
      ...(c.domainName ? { FullyQualifiedDomainName: c.domainName } : {}),
      RequestInterval: c.requestInterval,
      FailureThreshold: c.failureThreshold,
      MeasureLatency: false,
      Inverted: false,
      Disabled: false,
      ...(c.type === "HTTPS" ? { EnableSNI: true } : {}),
    },
    HealthCheckVersion: 1,
  };
}

// ---------- record changes ----------

interface ChangeInput {
  Action?: string;
  ResourceRecordSet?: {
    Name?: string;
    Type?: string;
    TTL?: number;
    ResourceRecords?: { Value: string }[];
    AliasTarget?: { HostedZoneId?: string; DNSName?: string; EvaluateTargetHealth?: boolean };
    SetIdentifier?: string;
    Weight?: number;
    Failover?: string;
    HealthCheckId?: string;
  };
}

function toConfig(zone: Resource, rr: NonNullable<ChangeInput["ResourceRecordSet"]>): Record<string, unknown> {
  const where = `Change with [Action=?, Name=${rr.Name}, Type=${rr.Type}, SetIdentifier=${rr.SetIdentifier ?? "null"}]`;
  if (!rr.Name || !rr.Type) throw new EngineError("InvalidInput", `Invalid request: Missing field '${!rr.Name ? "Name" : "Type"}' in ${where}`);
  if (rr.AliasTarget && (rr.TTL !== undefined || rr.ResourceRecords)) {
    throw new EngineError("InvalidInput", `Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found more than one in ${where}`);
  }
  const policy = rr.Weight !== undefined ? "weighted" : rr.Failover ? "failover" : rr.SetIdentifier ? "weighted" : "simple";
  // The CLI's names are absolute: a trailing dot makes sure "www" isn't read as relative to the zone.
  const name = normalizeName(rr.Name);
  return {
    zoneId: zone.id,
    name: `${name}.`,
    type: rr.Type,
    alias: !!rr.AliasTarget,
    aliasTarget: rr.AliasTarget?.DNSName,
    evaluateTargetHealth: rr.AliasTarget?.EvaluateTargetHealth ?? false,
    ttl: rr.TTL,
    values: (rr.ResourceRecords ?? []).map((v) => ({ value: v.Value })),
    routingPolicy: policy,
    setIdentifier: rr.SetIdentifier,
    weight: rr.Weight,
    failover: rr.Failover,
    healthCheckId: rr.HealthCheckId,
  };
}

const sameSet = (r: Resource, name: string, type: string, setId?: string) =>
  r.name === name && r.config.type === type && (r.config.setIdentifier ?? undefined) === (setId ?? undefined);

/** Applies a change batch all-or-nothing: if any change fails, the ones before it are undone. */
async function applyChanges(ctx: CliContext, zone: Resource, changes: ChangeInput[]) {
  const undo: (() => Promise<unknown>)[] = [];
  try {
    for (const change of changes) {
      const action = String(change.Action ?? "").toUpperCase();
      const rr = change.ResourceRecordSet;
      if (!["CREATE", "DELETE", "UPSERT"].includes(action)) throw new EngineError("InvalidInput", `Invalid request: Action '${change.Action}' must be one of CREATE, DELETE, UPSERT`);
      if (!rr) throw new EngineError("InvalidInput", "Invalid request: Missing field 'ResourceRecordSet' in Change");
      const config = toConfig(zone, rr);
      const name = normalizeName(String(rr.Name));
      const existing = (await listOf(ctx, "record-set")).find((r) => r.config.zoneId === zone.id && sameSet(r, name, String(rr.Type), rr.SetIdentifier));
      const label = `[name='${name}.', type='${rr.Type}'${rr.SetIdentifier ? `, set-identifier='${rr.SetIdentifier}'` : ""}]`;

      if (action === "DELETE") {
        if (!existing) throw new EngineError("InvalidChangeBatch", `[Tried to delete resource record set ${label} but it was not found]`);
        const given = rr.AliasTarget ? [normalizeName(String(rr.AliasTarget.DNSName))] : (rr.ResourceRecords ?? []).map((v) => v.Value.trim()).sort();
        const current = existing.config.alias ? [String(existing.config.aliasTarget)] : recordValues(existing).sort();
        if (JSON.stringify(given) !== JSON.stringify(current) || (!rr.AliasTarget && rr.TTL !== existing.config.ttl)) {
          throw new EngineError("InvalidChangeBatch", `[Tried to delete resource record set ${label} but the values provided do not match the current values]`);
        }
        await ctx.engine.remove(ctx.accountId, existing.id);
        const snapshot = { ...existing.config };
        undo.push(() => create(ctx, "record-set", snapshot));
      } else if (existing && action === "UPSERT") {
        const before = { ...existing.config };
        await ctx.engine.update(ctx.accountId, existing.id, { ...config, name: existing.name });
        undo.push(() => ctx.engine.update(ctx.accountId, existing.id, before));
      } else {
        const made = await create(ctx, "record-set", config);
        undo.push(() => ctx.engine.remove(ctx.accountId, made.id));
      }
    }
  } catch (e) {
    for (const u of undo.reverse()) await u().catch(() => undefined);
    throw e;
  }
}

/** Shorthand or JSON for --health-check-config. */
function healthCheckConfig(ctx: CliContext, args: Args) {
  const c = jsonArg(ctx, "health-check-config", args.raw("health-check-config").join(" ") || "{}") as Record<string, string | number | undefined>;
  const num = (v: unknown) => (v === undefined ? undefined : Number(v));
  const type = String(c.Type ?? "");
  if (!["HTTP", "HTTPS", "TCP"].includes(type)) {
    throw new EngineError("InvalidInput", `Invalid parameter : Type ${type || "(none)"} isn't supported by Nuvora. Use HTTP, HTTPS or TCP.`);
  }
  return {
    type,
    ipAddress: c.IPAddress,
    domainName: c.FullyQualifiedDomainName,
    port: num(c.Port) ?? (type === "HTTPS" ? 443 : 80),
    resourcePath: c.ResourcePath ?? (type === "TCP" ? undefined : "/"),
    requestInterval: num(c.RequestInterval) ?? 30,
    failureThreshold: num(c.FailureThreshold) ?? 3,
  };
}

const perm = (action: string, resource: (args: Args) => string) => (args: Args) => [{ action: `route53:${action}`, resource: resource(args) }];
const zonePerm = (action: string, option = "id") => perm(action, (args) => zoneArn(args.one(option) ?? "*"));
const hcPerm = (action: string) => perm(action, (args) => `arn:aws:route53:::healthcheck/${args.one("health-check-id") ?? "*"}`);

export const ROUTE53_COMMANDS: Command[] = [
  // --- hosted zones ---
  cmd({
    service: "route53",
    operation: "create-hosted-zone",
    apiName: "CreateHostedZone",
    summary: "Create a hosted zone for a domain (it starts with NS and SOA records)",
    usage: "--name <domain> --caller-reference <unique-string> [--hosted-zone-config Comment=<text>,PrivateZone=false]",
    mutates: true,
    permissions: perm("CreateHostedZone", () => "*"),
    async run(args, ctx) {
      const reference = args.required("caller-reference");
      const zones = await listOf(ctx, "hosted-zone");
      if (zones.some((z) => z.attributes.callerReference === reference)) {
        throw new EngineError("HostedZoneAlreadyExists", "A hosted zone has already been created with the specified caller reference.", 409);
      }
      const config = args.raw("hosted-zone-config").length ? jsonArg(ctx, "hosted-zone-config", args.raw("hosted-zone-config").join(" ")) : {};
      if (String(config.PrivateZone ?? "false").toLowerCase() === "true") {
        throw new EngineError("InvalidInput", "Private hosted zones need a VPC (--vpc), and Nuvora doesn't simulate them yet. Create a public zone instead.");
      }
      const zone = await create(ctx, "hosted-zone", { name: args.required("name"), comment: config.Comment, zoneType: "public" });
      await ctx.engine.setAttributes(ctx.accountId, zone.id, { callerReference: reference });
      const fresh = await ctx.engine.get(ctx.accountId, zone.id);
      return {
        Location: `https://route53.amazonaws.com/2013-04-01/hostedzone/${zone.id}`,
        HostedZone: zoneOut(fresh),
        ChangeInfo: changeInfo(ctx),
        DelegationSet: { NameServers: nameServersFor(zone.id) },
      };
    },
  }),
  cmd({
    service: "route53",
    operation: "get-hosted-zone",
    apiName: "GetHostedZone",
    summary: "Show a hosted zone and its name servers",
    usage: "--id <hosted-zone-id>",
    mutates: false,
    permissions: zonePerm("GetHostedZone"),
    async run(args, ctx) {
      const zone = await zoneById(ctx, args.required("id"));
      return { HostedZone: zoneOut(zone), DelegationSet: { NameServers: nameServersFor(zone.id) } };
    },
  }),
  cmd({
    service: "route53",
    operation: "list-hosted-zones",
    apiName: "ListHostedZones",
    summary: "List your hosted zones",
    usage: "",
    mutates: false,
    permissions: perm("ListHostedZones", () => "*"),
    async run(_args, ctx) {
      const zones = (await listOf(ctx, "hosted-zone")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { HostedZones: zones.map(zoneOut), IsTruncated: false, MaxItems: "100" };
    },
  }),
  cmd({
    service: "route53",
    operation: "list-hosted-zones-by-name",
    apiName: "ListHostedZonesByName",
    summary: "List hosted zones in name order, optionally from a name",
    usage: "[--dns-name <domain>]",
    mutates: false,
    permissions: perm("ListHostedZonesByName", () => "*"),
    async run(args, ctx) {
      const from = args.one("dns-name");
      const key = (n: string) => n.split(".").reverse().join(".");
      const zones = (await listOf(ctx, "hosted-zone")).sort((a, b) => key(a.name).localeCompare(key(b.name)));
      const shown = from ? zones.filter((z) => key(z.name) >= key(normalizeName(from))) : zones;
      return { HostedZones: shown.map(zoneOut), ...(from ? { DNSName: `${normalizeName(from)}.` } : {}), IsTruncated: false, MaxItems: "100" };
    },
  }),
  cmd({
    service: "route53",
    operation: "delete-hosted-zone",
    apiName: "DeleteHostedZone",
    summary: "Delete a hosted zone (only its NS and SOA records may be left)",
    usage: "--id <hosted-zone-id>",
    mutates: true,
    permissions: zonePerm("DeleteHostedZone"),
    async run(args, ctx) {
      const zone = await zoneById(ctx, args.required("id"));
      await ctx.engine.remove(ctx.accountId, zone.id);
      return { ChangeInfo: changeInfo(ctx) };
    },
  }),

  // --- records ---
  cmd({
    service: "route53",
    operation: "change-resource-record-sets",
    apiName: "ChangeResourceRecordSets",
    summary: "Create, change (UPSERT) or delete records, in one all-or-nothing batch",
    usage: "--hosted-zone-id <id> --change-batch <json|file://batch.json>",
    mutates: true,
    permissions: zonePerm("ChangeResourceRecordSets", "hosted-zone-id"),
    async run(args, ctx) {
      const zone = await zoneById(ctx, args.required("hosted-zone-id"));
      const batch = jsonArg(ctx, "change-batch", args.raw("change-batch").join(" ") || "{}") as { Comment?: string; Changes?: ChangeInput[] };
      if (!Array.isArray(batch.Changes) || batch.Changes.length === 0) throw new EngineError("InvalidInput", "Invalid request: Missing field 'Changes' in ChangeBatch");
      await applyChanges(ctx, zone, batch.Changes);
      return { ChangeInfo: changeInfo(ctx, batch.Comment) };
    },
  }),
  cmd({
    service: "route53",
    operation: "list-resource-record-sets",
    apiName: "ListResourceRecordSets",
    summary: "List a hosted zone's records",
    usage: "--hosted-zone-id <id> [--start-record-name <name>] [--start-record-type <type>]",
    mutates: false,
    permissions: zonePerm("ListResourceRecordSets", "hosted-zone-id"),
    async run(args, ctx) {
      const zone = await zoneById(ctx, args.required("hosted-zone-id"));
      const start = args.one("start-record-name");
      let records = (await listOf(ctx, "record-set")).filter((r) => r.config.zoneId === zone.id).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      if (start) {
        const from = normalizeName(start).split(".").reverse().join(".");
        records = records.filter((r) => sortKey(r) >= from);
      }
      return { ResourceRecordSets: await Promise.all(records.map((r) => recordOut(ctx, r, zone))), IsTruncated: false, MaxItems: "300" };
    },
  }),
  cmd({
    service: "route53",
    operation: "get-change",
    apiName: "GetChange",
    summary: "Check whether a change has reached all of Route 53's servers (INSYNC)",
    usage: "--id <change-id>",
    mutates: false,
    permissions: perm("GetChange", (args) => `arn:aws:route53:::change/${String(args.one("id") ?? "*").replace(/^\/change\//, "")}`),
    async run(args, ctx) {
      const id = args.required("id").replace(/^\/change\//, "");
      if (!/^C[A-Z0-9]{8,32}$/.test(id)) throw new EngineError("NoSuchChange", `Could not find resource with ID: ${id}`, 404);
      // Changes reach every name server within seconds; Nuvora's are instant.
      return { ChangeInfo: { Id: `/change/${id}`, Status: "INSYNC", SubmittedAt: ctx.engine.now().toISOString() } };
    },
  }),
  cmd({
    service: "route53",
    operation: "test-dns-answer",
    apiName: "TestDNSAnswer",
    summary: "Ask Route 53 what it would answer for a name and type",
    usage: "--hosted-zone-id <id> --record-name <name> --record-type <type>",
    mutates: false,
    permissions: zonePerm("TestDNSAnswer", "hosted-zone-id"),
    async run(args, ctx) {
      const zone = await zoneById(ctx, args.required("hosted-zone-id"));
      const name = normalizeName(args.required("record-name"));
      const type = args.required("record-type").toUpperCase();
      const answer = await resolve(ctx.engine, ctx.accountId, name, type);
      return {
        Nameserver: `${nameServersFor(zone.id)[0]}.`,
        RecordName: `${name}.`,
        RecordType: type,
        RecordData: answer.answers.filter((a) => a.type === type).map((a) => a.value),
        ResponseCode: answer.status,
        Protocol: "UDP",
      };
    },
  }),

  // --- health checks ---
  cmd({
    service: "route53",
    operation: "create-health-check",
    apiName: "CreateHealthCheck",
    summary: "Check a server or website from the internet every 30 seconds",
    usage: "--caller-reference <unique-string> --health-check-config <json|Type=HTTP,IPAddress=<ip>,Port=80,ResourcePath=/>",
    mutates: true,
    permissions: perm("CreateHealthCheck", () => "*"),
    async run(args, ctx) {
      const reference = args.required("caller-reference");
      const existing = (await listOf(ctx, "health-check")).find((h) => h.attributes.callerReference === reference);
      if (existing) {
        throw new EngineError("HealthCheckAlreadyExists", `A health check with the caller reference ${reference} already exists. Use another caller reference.`, 409);
      }
      const hc = await create(ctx, "health-check", healthCheckConfig(ctx, args));
      await ctx.engine.setAttributes(ctx.accountId, hc.id, { callerReference: reference });
      return { Location: `https://route53.amazonaws.com/2013-04-01/healthcheck/${hc.id}`, HealthCheck: healthCheckOut(await ctx.engine.get(ctx.accountId, hc.id)) };
    },
  }),
  cmd({
    service: "route53",
    operation: "get-health-check",
    apiName: "GetHealthCheck",
    summary: "Show a health check's settings",
    usage: "--health-check-id <id>",
    mutates: false,
    permissions: hcPerm("GetHealthCheck"),
    async run(args, ctx) {
      return { HealthCheck: healthCheckOut(await healthCheckById(ctx, args.required("health-check-id"))) };
    },
  }),
  cmd({
    service: "route53",
    operation: "list-health-checks",
    apiName: "ListHealthChecks",
    summary: "List your health checks",
    usage: "",
    mutates: false,
    permissions: perm("ListHealthChecks", () => "*"),
    async run(_args, ctx) {
      return { HealthChecks: (await listOf(ctx, "health-check")).map(healthCheckOut), Marker: "", IsTruncated: false, MaxItems: "100" };
    },
  }),
  cmd({
    service: "route53",
    operation: "get-health-check-status",
    apiName: "GetHealthCheckStatus",
    summary: "What the health checkers around the world see right now",
    usage: "--health-check-id <id>",
    mutates: false,
    permissions: hcPerm("GetHealthCheckStatus"),
    async run(args, ctx) {
      const hc = await healthCheckById(ctx, args.required("health-check-id"));
      const status = await healthCheckStatus(ctx.engine, ctx.accountId, hc);
      const checked = ctx.engine.now().toISOString();
      const checkers: [string, string][] = [
        ["us-east-1", "15.177.10.32"],
        ["eu-west-1", "15.177.62.17"],
        ["ap-southeast-1", "15.177.42.9"],
      ];
      return { HealthCheckObservations: checkers.map(([Region, IPAddress]) => ({ Region, IPAddress, StatusReport: { Status: status.report, CheckedTime: checked } })) };
    },
  }),
  cmd({
    service: "route53",
    operation: "delete-health-check",
    apiName: "DeleteHealthCheck",
    summary: "Delete a health check (no record may still use it)",
    usage: "--health-check-id <id>",
    mutates: true,
    permissions: hcPerm("DeleteHealthCheck"),
    async run(args, ctx) {
      const hc = await healthCheckById(ctx, args.required("health-check-id"));
      await ctx.engine.remove(ctx.accountId, hc.id);
      return {};
    },
  }),
];

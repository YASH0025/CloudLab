import { EngineError } from "../errors";
import type { HookContext, Resource, ResourceTypeDef, ServiceDef } from "../types";

/**
 * Amazon Route 53: DNS, the internet's phone book. A hosted zone holds the
 * records for one domain (myshop.com); each record answers one question
 * ("what's the address of www.myshop.com?"). Alias records point straight at
 * AWS resources (a load balancer, an API, an S3 website) and work at the
 * domain's apex, where CNAMEs aren't allowed. Health checks let failover and
 * weighted records skip what's down.
 *
 * In Nuvora, every hosted zone answers straight away, as if you had
 * registered the domain and pointed it at Route 53's name servers. The
 * terminal's dig, nslookup and curl use them.
 */

// ---------- names ----------

/** "WWW.MyShop.com." → "www.myshop.com". */
export const normalizeName = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

/** A DNS name: labels of letters, digits and hyphens (and a leading * or _ for wildcards and service records). */
const LABEL = /^(\*|_?[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?)$/;
export function isDomainName(name: string): boolean {
  if (!name || name.length > 253) return false;
  const labels = name.split(".");
  return labels.every((l, i) => LABEL.test(l) && (l !== "*" || i === 0));
}

/** A record name typed relative to the zone ("www", "" or "@" for the apex) or in full → its full name. */
export function fqdnFor(name: string | undefined, zone: string): string {
  const raw = (name ?? "").trim();
  if (raw === "" || raw === "@") return zone;
  const n = normalizeName(raw);
  if (raw.endsWith(".") || n === zone || n.endsWith(`.${zone}`)) return n;
  return `${n}.${zone}`;
}

export const inZone = (fqdn: string, zone: string) => fqdn === zone || fqdn.endsWith(`.${zone}`);

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const isIPv4 = (s: string) => IPV4.test(s);
export function isIPv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.split("::").length > 2) return false;
  const parts = s.split(":");
  if (parts.length < 3 || parts.length > 8) return false;
  return parts.every((p) => p === "" || /^[0-9a-fA-F]{1,4}$/.test(p) || (isIPv4(p) && p === parts[parts.length - 1]));
}

/** Private and other non-public ranges: health checks can't reach them, as in AWS. */
export function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}

// ---------- IDs ----------

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const randomChars = (n: number, alphabet: string) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join("");

export const ZONE_ID = /^Z[A-Z0-9]{12,31}$/;
export const newZoneId = () => `Z0${randomChars(19, UPPER)}`;
/** Route 53 change IDs look like C2682N5HXP0BZ4. */
export const newChangeId = () => `C${randomChars(20, UPPER)}`;
/** IDs may be given as "Z0…" or "/hostedzone/Z0…". */
export const bareZoneId = (id: string) => id.replace(/^\/hostedzone\//, "");

const HEALTH_CHECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The four name servers AWS assigns a zone (a "delegation set"), derived from its ID. */
export function nameServersFor(zoneId: string): string[] {
  let h = 7;
  for (const c of zoneId) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  const n = (i: number) => (h >>> (i * 5)) % 2048;
  const tld = ["com", "net", "org", "co.uk"];
  return tld.map((t, i) => `ns-${n(i)}.awsdns-${String(n(i) % 64).padStart(2, "0")}.${t}`);
}

/** The hosted zone IDs AWS uses for its own endpoints, which alias records name as their target zone. */
export const ALIAS_ZONE_IDS: Record<"elb" | "s3" | "apigateway", Record<string, string>> = {
  elb: { "us-east-1": "Z35SXDOTRQ7X7K", "us-west-2": "Z1H1FL5HABSF5", "eu-west-1": "Z32O12XQLNTSW2", "ap-south-1": "ZP97RAFLXTNZK" },
  s3: { "us-east-1": "Z3AQBSTGFYJSTF", "us-west-2": "Z3BJ6K6RIION7M", "eu-west-1": "Z1BKCTXD74EZPE", "ap-south-1": "Z11RGJOFQNVJUP" },
  apigateway: { "us-east-1": "Z1UJRXOUMOOFQ8", "us-west-2": "Z2OJLYMUO9EFXC", "eu-west-1": "ZLY8HYME6SFDD", "ap-south-1": "Z3VO1THU9YC4UR" },
};

// ---------- records ----------

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA"] as const;

export interface RecordConfig {
  zoneId: string;
  name: string;
  type: string;
  alias?: boolean;
  aliasTarget?: string;
  evaluateTargetHealth?: boolean;
  ttl?: number;
  values?: { value: string }[];
  routingPolicy?: "simple" | "weighted" | "failover";
  setIdentifier?: string;
  weight?: number;
  failover?: "PRIMARY" | "SECONDARY";
  healthCheckId?: string;
}

export const recordConfig = (r: Resource) => r.config as unknown as RecordConfig;
export const recordValues = (r: Resource) => (recordConfig(r).values ?? []).map((v) => v.value);

/** What an alias target name points at, if it's something Route 53 can alias to. */
export type AliasTargetKind =
  | { kind: "elb"; resource: Resource }
  | { kind: "apigateway"; resource: Resource }
  | { kind: "s3"; region: string }
  | { kind: "record"; zone: Resource };

const S3_WEBSITE = /^(?:(.+)\.)?s3-website[.-]([a-z]{2}-[a-z]+-\d)\.(?:cloudlab\.local|amazonaws\.com)$/;
const API_HOST = /^([a-z0-9]{10})\.execute-api\.([a-z0-9-]+)\.cloudlab\.local$/;

/** Finds what an alias target names: a load balancer, an API, an S3 website endpoint or a record in the same zone. */
export async function aliasTargetKind(
  target: string,
  zone: Resource,
  lookup: { listAll(service: string, type: string): Promise<Resource[]>; list(service: string, type: string): Promise<Resource[]> },
): Promise<AliasTargetKind | null> {
  const t = normalizeName(target).replace(/^dualstack\./, "");
  const s3 = S3_WEBSITE.exec(t);
  if (s3) return { kind: "s3", region: s3[2] };
  const api = API_HOST.exec(t);
  if (api) {
    const found = (await lookup.listAll("apigateway", "api")).find((a) => a.id === api[1]);
    return found ? { kind: "apigateway", resource: found } : null;
  }
  if (t.endsWith(".elb.cloudlab.local")) {
    const lb = (await lookup.listAll("loadbalancing", "load-balancer")).find((l) => String(l.attributes.dnsName).toLowerCase() === t);
    return lb ? { kind: "elb", resource: lb } : null;
  }
  if (inZone(t, zone.name)) return { kind: "record", zone };
  return null;
}

/** The Route 53 hosted zone ID shown for an alias target (AWS's own zones for its endpoints). */
export function aliasZoneId(kind: AliasTargetKind): string {
  if (kind.kind === "record") return kind.zone.id;
  if (kind.kind === "s3") return ALIAS_ZONE_IDS.s3[kind.region] ?? ALIAS_ZONE_IDS.s3["us-east-1"];
  return ALIAS_ZONE_IDS[kind.kind][kind.resource.region] ?? ALIAS_ZONE_IDS[kind.kind]["us-east-1"];
}

const batchError = (message: string) => new EngineError("InvalidChangeBatch", `[${message}]`);
const invalidRecord = (problem: string, explanation: string, value: string) =>
  batchError(`Invalid Resource Record: 'FATAL problem: ${problem} (${explanation}) encountered with '${value}''`);
const setLabel = (c: RecordConfig, fqdn: string) => `[name='${fqdn}.', type='${c.type}'${c.setIdentifier ? `, set-identifier='${c.setIdentifier}'` : ""}]`;

function checkValue(type: string, value: string) {
  if (type === "A" && !isIPv4(value)) throw invalidRecord("ARRDATAIllegalIPv4Address", "Value is not a valid IPv4 address", value);
  if (type === "AAAA" && !isIPv6(value)) throw invalidRecord("AAAARRDATAIllegalIPv6Address", "Value is not a valid IPv6 address", value);
  if ((type === "CNAME" || type === "NS") && !isDomainName(normalizeName(value))) throw invalidRecord("DomainLabelEmpty", "Domain label is empty", value);
  if (type === "MX") {
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 2) throw invalidRecord("MXRRDATANotTwoFields", "MX record must have two fields", value);
    if (!/^\d+$/.test(parts[0]) || Number(parts[0]) > 65535) throw invalidRecord("MXRRDATABadPriority", "MX priority must be a number from 0 to 65535", value);
  }
  if (type === "TXT" && !/^("([^"\\]|\\.)*"\s*)+$/.test(value.trim())) {
    throw invalidRecord("InvalidCharacterString", "Value should be enclosed in quotation marks", value);
  }
  if (type === "SOA" && value.trim().split(/\s+/).length !== 7) throw invalidRecord("SOARRDATANotSevenFields", "SOA record must have seven fields", value);
}

async function zoneOf(ctx: HookContext, zoneId: string): Promise<Resource | null> {
  const z = await ctx.get(zoneId);
  return z && z.service === "route53" && z.type === "hosted-zone" ? z : null;
}

// ---------- hosted zones ----------

const RESERVED = new Set(["example.com", "example.net", "example.org"]);

const hostedZone: ResourceTypeDef = {
  service: "route53",
  type: "hosted-zone",
  label: "Hosted zone",
  pluralLabel: "Hosted zones",
  description:
    "The DNS records for one domain, like myshop.com: which address www.myshop.com points to, where its email goes, and so on. In Nuvora it answers straight away, as if you'd registered the domain.",
  idPrefix: "hostedzone",
  global: true,
  makeId: () => newZoneId(),
  idPattern: ZONE_ID,
  notFoundCode: "NoSuchHostedZone",
  notFoundMessage: (id) => `No hosted zone found with ID: ${id}`,
  malformedCode: "NoSuchHostedZone",
  malformedMessage: (id) => `No hosted zone found with ID: ${id}`,
  apiNoun: "hosted zone",
  panelAttributes: ["recentRequests", "callerReference"],
  fields: [
    {
      key: "name",
      label: "Domain name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 1024,
      placeholder: "myshop.com",
      param: "Name",
      description: "The domain whose records this zone holds. Records for www.myshop.com, api.myshop.com and myshop.com itself all live here.",
    },
    { key: "comment", label: "Description", type: "string", maxLength: 256, param: "HostedZoneConfig.Comment" },
    {
      key: "zoneType",
      label: "Type",
      type: "enum",
      required: true,
      immutable: true,
      default: "public",
      options: [{ value: "public", label: "Public hosted zone", hint: "Answers for anyone on the internet. (Private zones, only inside a VPC, aren't simulated yet.)" }],
      param: "HostedZoneConfig.PrivateZone",
    },
  ],
  columns: [
    { label: "Hosted zone ID", path: "id", mono: true },
    { label: "Records", path: "attributes.recordCount" },
    { label: "Description", path: "config.comment" },
  ],
  iam: {
    create: "route53:CreateHostedZone",
    read: "route53:GetHostedZone",
    update: "route53:UpdateHostedZoneComment",
    delete: "route53:DeleteHostedZone",
    arn: (r) => `arn:aws:route53:::hostedzone/${r.id}`,
  },
  invalidValue: ({ field, value }) => new EngineError("InvalidInput", `Invalid parameter: ${field.param ?? field.key} '${String(value ?? "")}' is not valid.`),
  async normalize({ config }) {
    return { ...config, name: normalizeName(String(config.name ?? "")) };
  },
  async validate({ config }) {
    const name = String(config.name);
    if (RESERVED.has(name) || (!name.includes(".") && /^[a-z]+$/.test(name))) throw new EngineError("InvalidDomainName", `${name} is reserved by AWS!`);
    if (!isDomainName(name) || name.startsWith("*")) throw new EngineError("InvalidDomainName", `${name} is not a valid domain name.`);
  },
  dependencyError: () =>
    new EngineError("HostedZoneNotEmpty", "The specified hosted zone contains non-required resource record sets and so cannot be deleted."),
  async derive({ id, existing }) {
    return { ...(existing?.attributes ?? {}), nameServers: nameServersFor(id), recordCount: existing?.attributes.recordCount ?? 2 };
  },
  async afterCreate({ resource, system }) {
    // Every zone starts with its name servers (NS) and "start of authority" (SOA) records.
    const ns = nameServersFor(resource.id);
    const base = { zoneId: resource.id, name: resource.name, alias: false, routingPolicy: "simple" };
    await system.create("route53", "record-set", { ...base, type: "NS", ttl: 172800, values: ns.map((n) => ({ value: `${n}.` })) }, { ownedBy: resource.id });
    await system.create(
      "route53",
      "record-set",
      { ...base, type: "SOA", ttl: 900, values: [{ value: `${ns[0]}. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400` }] },
      { ownedBy: resource.id },
    );
  },
};

// ---------- record sets ----------

async function updateCount(system: { list(service: string, type: string): Promise<Resource[]>; setAttributes(id: string, p: Record<string, unknown>): Promise<void> }, zoneId: string) {
  const n = (await system.list("route53", "record-set")).filter((r) => r.config.zoneId === zoneId).length;
  await system.setAttributes(zoneId, { recordCount: n });
}

const routing = (policies: string[]) => ({ field: "routingPolicy", in: policies });

const recordSet: ResourceTypeDef = {
  service: "route53",
  type: "record-set",
  label: "Record",
  pluralLabel: "Records",
  description:
    "One DNS answer: www.myshop.com → 3.91.12.7 (an A record), or → your load balancer (an alias). Records live in a hosted zone; open the zone to see them all and test them.",
  idPrefix: "rrset",
  global: true,
  makeId: ({ config }) => `${config.zoneId}/rrset-${randomChars(12, "0123456789abcdef")}`,
  idPattern: /^Z[A-Z0-9]{12,31}\/rrset-[0-9a-f]{12}$/,
  notFoundCode: "InvalidChangeBatch",
  notFoundMessage: () => "[Tried to delete resource record set but it was not found]",
  malformedCode: "InvalidChangeBatch",
  malformedMessage: () => "[Tried to delete resource record set but it was not found]",
  apiNoun: "record",
  fields: [
    {
      key: "zoneId",
      label: "Hosted zone",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "route53", type: "hosted-zone" },
      param: "HostedZoneId",
    },
    {
      key: "name",
      label: "Record name",
      type: "string",
      immutable: true,
      maxLength: 1024,
      placeholder: "www",
      param: "Name",
      description: "The part before your domain: www makes www.myshop.com. Leave empty for myshop.com itself (the apex).",
    },
    {
      key: "type",
      label: "Record type",
      type: "enum",
      required: true,
      immutable: true,
      default: "A",
      param: "Type",
      options: [
        { value: "A", label: "A", hint: "Name → IPv4 address (or, as an alias, → an AWS resource)" },
        { value: "AAAA", label: "AAAA", hint: "Name → IPv6 address" },
        { value: "CNAME", label: "CNAME", hint: "Name → another name. Not allowed at the apex" },
        { value: "TXT", label: "TXT", hint: "Text, e.g. to prove you own the domain" },
        { value: "MX", label: "MX", hint: "Where the domain's email goes" },
        { value: "NS", label: "NS", hint: "Hand a subdomain to other name servers" },
        { value: "SOA", label: "SOA", hint: "Created with the zone; one per zone" },
      ],
    },
    {
      key: "alias",
      label: "Alias",
      type: "boolean",
      default: false,
      param: "AliasTarget",
      description: "Point straight at an AWS resource (load balancer, API, S3 website) or another record in this zone. Free, follows the resource's changing IPs, and works at the apex.",
      showWhen: { field: "type", in: ["A", "AAAA"] },
    },
    {
      key: "aliasTarget",
      label: "Alias target",
      type: "string",
      maxLength: 1024,
      placeholder: "my-lb-123456789.us-east-1.elb.cloudlab.local",
      param: "AliasTarget.DNSName",
      description: "A load balancer's DNS name, an API's domain (abc123defg.execute-api.us-east-1.cloudlab.local), s3-website.us-east-1.cloudlab.local, or a record in this zone.",
      showWhen: { field: "alias", in: [true] },
    },
    {
      key: "evaluateTargetHealth",
      label: "Evaluate target health",
      type: "boolean",
      default: false,
      param: "AliasTarget.EvaluateTargetHealth",
      description: "Treat the record as unhealthy when the target is (e.g. a load balancer with no healthy servers), so failover can skip it.",
      showWhen: { field: "alias", in: [true] },
    },
    {
      key: "ttl",
      label: "TTL (seconds)",
      type: "number",
      default: 300,
      min: 0,
      max: 2147483647,
      param: "TTL",
      description: "How long resolvers may remember the answer. Lower means changes spread faster; higher means fewer lookups.",
      showWhen: { field: "alias", in: [false, null, undefined] },
    },
    {
      key: "values",
      itemLabel: "value",
      label: "Values",
      type: "list",
      param: "ResourceRecords",
      maxItems: 100,
      item: [{ key: "value", label: "Value", type: "string", required: true, maxLength: 4000, placeholder: "3.91.12.7" }],
      description: 'One per line. A: an IPv4 address. CNAME: one name. MX: "10 mail.myshop.com". TXT: text in "quotes".',
      showWhen: { field: "alias", in: [false, null, undefined] },
    },
    {
      key: "routingPolicy",
      label: "Routing policy",
      type: "enum",
      required: true,
      default: "simple",
      param: "RoutingPolicy",
      options: [
        { value: "simple", label: "Simple", hint: "One answer" },
        { value: "weighted", label: "Weighted", hint: "Share traffic between several records, e.g. 90/10" },
        { value: "failover", label: "Failover", hint: "Use the primary while it's healthy, else the secondary" },
      ],
    },
    {
      key: "setIdentifier",
      label: "Record ID",
      type: "string",
      maxLength: 128,
      placeholder: "blue",
      param: "SetIdentifier",
      description: "Tells apart the records that share this name and type.",
      showWhen: routing(["weighted", "failover"]),
    },
    { key: "weight", label: "Weight", type: "number", min: 0, max: 255, default: 100, param: "Weight", description: "This record's share: its weight ÷ the sum of all weights.", showWhen: routing(["weighted"]) },
    {
      key: "failover",
      label: "Failover record type",
      type: "enum",
      param: "Failover",
      options: [
        { value: "PRIMARY", label: "Primary", hint: "Used while healthy" },
        { value: "SECONDARY", label: "Secondary", hint: "Used when the primary is unhealthy" },
      ],
      showWhen: routing(["failover"]),
    },
    {
      key: "healthCheckId",
      label: "Health check",
      type: "ref",
      ref: { service: "route53", type: "health-check" },
      param: "HealthCheckId",
      description: "Route 53 stops giving out this record while the health check fails.",
      showWhen: routing(["weighted", "failover"]),
    },
  ],
  columns: [
    { label: "Record name", path: "attributes.fqdn", mono: true },
    { label: "Type", path: "config.type" },
    { label: "Routing", path: "config.routingPolicy" },
    { label: "Value / route traffic to", path: "attributes.valueSummary", mono: true },
    { label: "TTL", path: "config.ttl" },
  ],
  iam: {
    create: "route53:ChangeResourceRecordSets",
    read: "route53:ListResourceRecordSets",
    update: "route53:ChangeResourceRecordSets",
    delete: "route53:ChangeResourceRecordSets",
    arn: (r) => `arn:aws:route53:::hostedzone/${String(r.config.zoneId)}`,
  },
  invalidValue: ({ field, value }) => {
    if (field.key === "ttl") return new EngineError("InvalidInput", `Invalid request: TTL ${String(value)} must be between 0 and 2147483647`);
    if (field.key === "weight") return new EngineError("InvalidInput", `Invalid request: Weight ${String(value)} must be between 0 and 255`);
    return new EngineError("InvalidInput", `Invalid request: ${field.param ?? field.key} '${String(value ?? "")}' is not valid.`);
  },
  canDelete: (r) => {
    if (r.attributes.system && (r.attributes.system as { ownedBy?: string }).ownedBy) {
      return batchError(r.config.type === "SOA" ? "A HostedZone must contain exactly one SOA record." : "A HostedZone must contain at least one NS record for the zone itself.");
    }
    return undefined;
  },
  async normalize({ config, ctx }) {
    const zone = await zoneOf(ctx, String(config.zoneId ?? ""));
    const c = { ...config } as Record<string, unknown>;
    if (zone) c.name = fqdnFor(typeof c.name === "string" ? c.name : "", zone.name);
    const alias = c.alias === true && (c.type === "A" || c.type === "AAAA");
    c.alias = alias;
    if (alias) {
      c.aliasTarget = typeof c.aliasTarget === "string" ? normalizeName(c.aliasTarget).replace(/^dualstack\./, "") : c.aliasTarget;
      c.values = [];
      c.ttl = undefined;
    } else {
      c.aliasTarget = undefined;
      c.evaluateTargetHealth = undefined;
      c.values = ((c.values as { value: string }[] | undefined) ?? []).map((v) => ({ value: String(v.value).trim() }));
    }
    const policy = c.routingPolicy ?? "simple";
    if (policy === "simple") {
      c.setIdentifier = undefined;
      c.weight = undefined;
      c.failover = undefined;
    } else if (policy === "weighted") c.failover = undefined;
    else c.weight = undefined;
    return c;
  },
  async validate({ config, existing, ctx }) {
    const c = config as unknown as RecordConfig;
    const zone = await zoneOf(ctx, c.zoneId);
    if (!zone) throw new EngineError("NoSuchHostedZone", `No hosted zone found with ID: ${c.zoneId}`);
    const fqdn = c.name;
    const action = existing ? "UPSERT" : "CREATE";
    const where = `Change with [Action=${action}, Name=${fqdn}., Type=${c.type}, SetIdentifier=${c.setIdentifier ?? "null"}]`;
    if (!inZone(fqdn, zone.name)) throw batchError(`RRSet with DNS name ${fqdn}. is not permitted in zone ${zone.name}.`);
    if (!isDomainName(fqdn)) throw batchError(`${fqdn}. is not a valid DNS name`);

    // Either an alias, or a TTL and values: never both, never neither.
    if (!c.alias) {
      const values = (c.values ?? []).map((v) => v.value);
      if (values.length === 0 || c.ttl === undefined || c.ttl === null) {
        throw new EngineError("InvalidInput", `Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found none in ${where}`);
      }
      for (const v of values) checkValue(c.type, v);
      if (c.type === "CNAME" && values.length > 1) throw batchError(`RRSet of type CNAME with DNS name ${fqdn}. contains more than one value.`);
      if (c.type === "SOA" && values.length > 1) throw batchError("A HostedZone must contain exactly one SOA record.");
    } else if (!c.aliasTarget) {
      throw new EngineError("InvalidInput", `Invalid request: Missing field 'DNSName' in AliasTarget in ${where}`);
    }

    if (c.routingPolicy && c.routingPolicy !== "simple") {
      if (!c.setIdentifier) throw new EngineError("InvalidInput", `Invalid request: Missing field 'SetIdentifier' in ${where}`);
      if (c.routingPolicy === "weighted" && (c.weight === undefined || c.weight === null)) throw new EngineError("InvalidInput", `Invalid request: Missing field 'Weight' in ${where}`);
      if (c.routingPolicy === "failover" && !c.failover) throw new EngineError("InvalidInput", `Invalid request: Missing field 'Failover' in ${where}`);
    }

    const others = (await ctx.list("route53", "record-set")).filter((r) => r.config.zoneId === zone.id && r.name === fqdn && r.id !== existing?.id);
    const sameType = others.filter((r) => r.config.type === c.type);

    if (c.type === "CNAME" && fqdn === zone.name) throw batchError(`RRSet of type CNAME with DNS name ${fqdn}. is not permitted at apex in zone ${zone.name}.`);
    if (c.type === "CNAME" && others.some((r) => r.config.type !== "CNAME")) {
      throw batchError(`RRSet of type CNAME with DNS name ${fqdn}. is not permitted as it conflicts with other records with the same DNS name in zone ${zone.name}.`);
    }
    if (c.type !== "CNAME" && others.some((r) => r.config.type === "CNAME")) {
      throw batchError(`RRSet of type ${c.type} with DNS name ${fqdn}. is not permitted because a conflicting RRSet of type CNAME with the same DNS name already exists in zone ${zone.name}.`);
    }

    const policy = c.routingPolicy ?? "simple";
    if (sameType.some((r) => (r.config.setIdentifier ?? null) === (c.setIdentifier ?? null))) {
      throw batchError(`Tried to create resource record set ${setLabel(c, fqdn)} but it already exists`);
    }
    if (policy === "simple" && sameType.length > 0) {
      throw batchError(`Tried to create resource record set ${setLabel(c, fqdn)} but it already exists`);
    }
    const otherPolicy = sameType.find((r) => (r.config.routingPolicy ?? "simple") !== policy);
    if (otherPolicy) {
      const theirs = String(otherPolicy.config.routingPolicy ?? "simple");
      throw batchError(
        theirs === "simple"
          ? `RRSet with DNS name ${fqdn}., type ${c.type}, SetIdentifier ${c.setIdentifier} cannot be created as a non-${policy} set exists with the same name and type.`
          : `RRSet with DNS name ${fqdn}., type ${c.type}${c.setIdentifier ? `, SetIdentifier ${c.setIdentifier}` : ""} cannot be created as ${theirs} sets exist with the same name and type.`,
      );
    }
    if (policy === "failover" && sameType.some((r) => r.config.failover === c.failover)) {
      throw batchError(`RRSet with DNS name ${fqdn}., type ${c.type}, SetIdentifier ${c.setIdentifier}, and failover ${c.failover} cannot be created because a set with the same name, type, and failover type already exists.`);
    }

    if (c.alias && c.aliasTarget) {
      const kind = await aliasTargetKind(c.aliasTarget, zone, ctx);
      const notInZone = batchError(`Tried to create an alias that targets ${c.aliasTarget}., type ${c.type} in zone ${zone.id}, but the alias target name does not lie within the target zone`);
      if (!kind) throw notInZone;
      if (kind.kind === "record") {
        if (c.aliasTarget === fqdn) throw batchError(`Tried to create an alias that targets ${c.aliasTarget}., type ${c.type} in zone ${zone.id}, but that target is the record itself`);
        const exists = (await ctx.list("route53", "record-set")).some((r) => r.config.zoneId === zone.id && r.name === c.aliasTarget && (r.config.type === c.type || r.config.type === "CNAME"));
        if (!exists) throw batchError(`Tried to create an alias that targets ${c.aliasTarget}., type ${c.type} in zone ${zone.id}, but that target was not found`);
      }
    }
  },
  async derive({ config }) {
    const c = config as unknown as RecordConfig;
    const summary = c.alias ? `ALIAS → ${c.aliasTarget}` : (c.values ?? []).map((v) => v.value).join(", ");
    return { fqdn: `${c.name}.`, valueSummary: summary.length > 120 ? `${summary.slice(0, 117)}…` : summary };
  },
  async afterCreate({ resource, system }) {
    await updateCount(system, String(resource.config.zoneId));
  },
  async afterDelete({ resource, system }) {
    if (await system.get(String(resource.config.zoneId))) await updateCount(system, String(resource.config.zoneId));
  },
};

// ---------- health checks ----------

const healthCheck: ResourceTypeDef = {
  service: "route53",
  type: "health-check",
  label: "Health check",
  pluralLabel: "Health checks",
  description:
    "Route 53 calls your server or website from around the world every 30 seconds. When it stops answering, failover and weighted records stop sending people there.",
  idPrefix: "healthcheck",
  global: true,
  makeId: () => crypto.randomUUID(),
  idPattern: HEALTH_CHECK_ID,
  notFoundCode: "NoSuchHealthCheck",
  notFoundMessage: (id) => `A health check with id ${id} does not exist.`,
  malformedCode: "NoSuchHealthCheck",
  malformedMessage: (id) => `A health check with id ${id} does not exist.`,
  apiNoun: "health check",
  fields: [
    { key: "name", label: "Name", type: "string", maxLength: 256, placeholder: "web-server", param: "Tags.Name" },
    {
      key: "type",
      label: "Protocol",
      type: "enum",
      required: true,
      immutable: true,
      default: "HTTP",
      param: "Type",
      options: [
        { value: "HTTP", label: "HTTP", hint: "Healthy when it answers with a 2xx or 3xx status" },
        { value: "HTTPS", label: "HTTPS", hint: "The same over TLS" },
        { value: "TCP", label: "TCP", hint: "Healthy when the port accepts a connection" },
      ],
    },
    { key: "ipAddress", label: "IP address", type: "string", maxLength: 45, placeholder: "3.91.12.7", param: "IPAddress", description: "Your server's public IP. Or give a domain name instead." },
    { key: "domainName", label: "Domain name", type: "string", maxLength: 255, placeholder: "www.myshop.com", param: "FullyQualifiedDomainName" },
    { key: "port", label: "Port", type: "number", required: true, default: 80, min: 1, max: 65535, param: "Port" },
    { key: "resourcePath", label: "Path", type: "string", default: "/", maxLength: 255, param: "ResourcePath", showWhen: { field: "type", in: ["HTTP", "HTTPS"] } },
    { key: "requestInterval", label: "Request interval (seconds)", type: "number", required: true, default: 30, min: 10, max: 30, immutable: true, param: "RequestInterval" },
    { key: "failureThreshold", label: "Failure threshold", type: "number", required: true, default: 3, min: 1, max: 10, param: "FailureThreshold", description: "Failed checks in a row before it counts as unhealthy." },
  ],
  columns: [
    { label: "Endpoint", path: "attributes.endpoint", mono: true },
    { label: "Protocol", path: "config.type" },
  ],
  iam: {
    create: "route53:CreateHealthCheck",
    read: "route53:GetHealthCheck",
    update: "route53:UpdateHealthCheck",
    delete: "route53:DeleteHealthCheck",
    arn: (r) => `arn:aws:route53:::healthcheck/${r.id}`,
  },
  invalidValue: ({ field, value }) => new EngineError("InvalidInput", `Invalid parameter : ${field.param ?? field.key} ${String(value ?? "")} is not valid.`),
  dependencyError: (id) => new EngineError("HealthCheckInUse", `The health check with id ${id} is still referenced from at least one resource record set.`),
  async normalize({ config }) {
    const c = { ...config };
    if (typeof c.domainName === "string") c.domainName = normalizeName(c.domainName) || undefined;
    if (typeof c.ipAddress === "string") c.ipAddress = c.ipAddress.trim() || undefined;
    if (c.type === "TCP") c.resourcePath = undefined;
    return c;
  },
  async validate({ config }) {
    const ip = config.ipAddress as string | undefined;
    const domain = config.domainName as string | undefined;
    if (!ip && !domain) throw new EngineError("InvalidInput", "Invalid parameter : Either IPAddress or FullyQualifiedDomainName must be specified.");
    if (ip && !isIPv4(ip) && !isIPv6(ip)) throw new EngineError("InvalidInput", `Invalid parameter : IP address ${ip} is not valid.`);
    if (ip && isIPv4(ip) && isPrivateIPv4(ip)) throw new EngineError("InvalidInput", `Invalid parameter : IP address ${ip} is not publicly routable. Health checkers run on the internet and can only reach public IPs.`);
    if (domain && !isDomainName(domain)) throw new EngineError("InvalidInput", `Invalid parameter : FullyQualifiedDomainName ${domain} is not valid.`);
    if (config.requestInterval !== 10 && config.requestInterval !== 30) throw new EngineError("InvalidInput", "Invalid parameter : RequestInterval must be 10 or 30.");
  },
  async derive({ config }) {
    const host = (config.domainName as string | undefined) ?? (config.ipAddress as string);
    const path = config.type === "TCP" ? "" : String(config.resourcePath || "/");
    return { endpoint: `${String(config.type).toLowerCase()}://${host}:${String(config.port)}${path}` };
  },
};

export const route53Service: ServiceDef = {
  id: "route53",
  label: "Route 53",
  modelledOn: "Route 53",
  description: "DNS: give your website, load balancer or API a real name like www.myshop.com.",
  category: "Networking",
  types: [hostedZone, recordSet, healthCheck],
};

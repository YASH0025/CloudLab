import { handleApiRequest } from "../apigw/handle";
import { targetHealth } from "../analysis/health";
import { testLoadBalancer } from "../analysis/loadtest";
import { analyzeReachability } from "../analysis/reachability";
import type { Engine } from "../engine";
import { listenersOf } from "../services/loadbalancing";
import { inZone, isIPv4, normalizeName, recordConfig, recordValues, type RecordConfig } from "../services/route53";
import type { Resource } from "../types";

/**
 * CloudLab's DNS resolver and web client. `resolve` answers a DNS question the
 * way a resolver on the internet would, from your hosted zones (CNAMEs are
 * followed, alias records become the target's addresses, weighted and failover
 * records consult health checks) and from the names AWS gives your resources.
 * `request` then sends an HTTP request to whatever the name led to, so `curl
 * http://www.myshop.com` reaches your server, load balancer, API or S3 website.
 */

export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  value: string;
}

/** What an HTTP request to a name would reach. */
export type Endpoint =
  | { kind: "ip"; ip: string }
  | { kind: "elb"; lb: Resource }
  | { kind: "apigateway"; api: Resource; ownHost: boolean }
  | { kind: "s3"; region: string };

export interface Resolution {
  question: { name: string; type: string };
  status: "NOERROR" | "NXDOMAIN" | "SERVFAIL";
  answers: DnsRecord[];
  /** The zone's SOA, sent back when a name or type doesn't exist. */
  authority: DnsRecord[];
  /** The hosted zone that answered first, if any. */
  zone?: Resource;
  endpoint?: Endpoint;
  /** How the answer was reached, in plain words, for the console. */
  steps: string[];
}

export interface ResolveOptions {
  /** For weighted records (tests pass a fixed value). */
  random?: () => number;
  /** Health checks resolving their own domain don't consult health checks again. */
  ignoreHealth?: boolean;
}

const MAX_DEPTH = 8;

/** A stable, made-up public address for something AWS runs (load balancer nodes, API Gateway, S3). */
function addressFor(seed: string, first: number): string {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `${first}.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${(h & 253) + 1}`;
}

const S3_WEBSITE = /^(?:.+\.)?s3-website[.-]([a-z]{2}-[a-z]+-\d)\.(?:cloudlab\.local|amazonaws\.com)$/;
const API_HOST = /^([a-z0-9]{10})\.execute-api\.([a-z0-9-]+)\.cloudlab\.local$/;

/** Names AWS itself answers for: load balancers, APIs and S3 website endpoints. */
async function awsName(engine: Engine, accountId: string, name: string): Promise<{ endpoint: Endpoint; addresses: string[]; what: string } | null> {
  const s3 = S3_WEBSITE.exec(name);
  if (s3) return { endpoint: { kind: "s3", region: s3[1] }, addresses: [addressFor(`s3-${s3[1]}`, 52)], what: `the S3 website endpoint in ${s3[1]}` };
  const api = API_HOST.exec(name);
  if (api) {
    const found = await engine.findAnywhere(api[1]);
    if (!found || found.type !== "api") return null;
    return { endpoint: { kind: "apigateway", api: found, ownHost: true }, addresses: [addressFor(found.id, 13), addressFor(`${found.id}-b`, 13)], what: `the API ${found.name}` };
  }
  if (name.endsWith(".elb.cloudlab.local")) {
    const lb = (await engine.list(accountId, { service: "loadbalancing", type: "load-balancer" })).find((l) => String(l.attributes.dnsName).toLowerCase() === name);
    if (!lb || lb.state !== "active") return null; // the name exists only once the load balancer is active
    const zones = (lb.attributes.availabilityZones as string[] | undefined) ?? [];
    const first = lb.config.scheme === "internal" ? 10 : 3;
    return { endpoint: { kind: "elb", lb }, addresses: zones.map((z) => addressFor(`${lb.id}-${z}`, first)), what: `the load balancer ${lb.name} (one address per Availability Zone)` };
  }
  return null;
}

/** Whether a health check currently passes. Kept simple: one round of checks, right now. */
export async function healthCheckStatus(engine: Engine, accountId: string, hc: Resource): Promise<{ healthy: boolean; report: string }> {
  const c = hc.config as { type: string; ipAddress?: string; domainName?: string; port: number; resourcePath?: string };
  const host = c.domainName ?? c.ipAddress ?? "";
  const res = await request(engine, accountId, `${c.type === "HTTPS" ? "https" : "http"}://${host}:${c.port}${c.resourcePath ?? "/"}`, {
    ignoreHealth: true,
    recordOn: false,
  });
  if (res.kind === "error") return { healthy: false, report: `Failure: ${res.reason}` };
  if (c.type === "TCP") return { healthy: true, report: "Success: TCP connection established" };
  if (res.status >= 200 && res.status < 400) return { healthy: true, report: `Success: HTTP Status Code ${res.status}, ${res.statusText}` };
  return { healthy: false, report: `Failure: HTTP Status Code ${res.status}, ${res.statusText}. Resolved IP: ${res.ip ?? host}` };
}

async function isHealthy(engine: Engine, accountId: string, rec: Resource, options: ResolveOptions, depth: number): Promise<{ healthy: boolean; why: string }> {
  if (options.ignoreHealth) return { healthy: true, why: "" };
  const c = recordConfig(rec);
  if (c.healthCheckId) {
    const hc = await engine.get(accountId, c.healthCheckId).catch(() => null);
    if (hc) {
      const s = await healthCheckStatus(engine, accountId, hc);
      return { healthy: s.healthy, why: `health check ${hc.name || hc.id}: ${s.report}` };
    }
  }
  if (c.alias && c.evaluateTargetHealth && c.aliasTarget) {
    const target = await resolve(engine, accountId, c.aliasTarget, c.type, { ...options }, depth + 1);
    if (target.endpoint?.kind === "elb") {
      const lb = target.endpoint.lb;
      const groups = listenersOf(lb).map((l) => l.targetGroupId).filter(Boolean);
      let any = false;
      for (const arn of groups) {
        const tg = await engine.get(accountId, arn).catch(() => null);
        if (tg && (await targetHealth(engine, accountId, tg, engine.now())).some((t) => t.state === "healthy")) any = true;
      }
      return { healthy: any, why: any ? `${lb.name} has healthy targets` : `${lb.name} has no healthy targets` };
    }
    return { healthy: target.status === "NOERROR" && target.answers.length > 0, why: "target health evaluated" };
  }
  return { healthy: true, why: "no health check, so always treated as healthy" };
}

/** Picks the record that answers among several with the same name and type. */
async function choose(engine: Engine, accountId: string, records: Resource[], options: ResolveOptions, depth: number, steps: string[]): Promise<Resource | null> {
  const policy = recordConfig(records[0]).routingPolicy ?? "simple";
  if (policy === "simple") return records[0];

  if (policy === "failover") {
    const primary = records.find((r) => recordConfig(r).failover === "PRIMARY");
    const secondary = records.find((r) => recordConfig(r).failover === "SECONDARY");
    if (primary) {
      const h = await isHealthy(engine, accountId, primary, options, depth);
      if (h.healthy || !secondary) {
        steps.push(`Failover: the primary record (${recordConfig(primary).setIdentifier}) is ${h.healthy ? "healthy" : "unhealthy, but there's no secondary"} (${h.why}).`);
        return primary;
      }
      steps.push(`Failover: the primary record (${recordConfig(primary).setIdentifier}) is unhealthy (${h.why}), so Route 53 answers with the secondary (${recordConfig(secondary).setIdentifier}).`);
      return secondary;
    }
    return secondary ?? null;
  }

  // Weighted: healthy records with weight > 0 share the traffic by weight.
  const states = await Promise.all(records.map(async (r) => ({ r, h: await isHealthy(engine, accountId, r, options, depth) })));
  let pool = states.filter((s) => s.h.healthy && (recordConfig(s.r).weight ?? 0) > 0);
  const skipped = states.filter((s) => !s.h.healthy).map((s) => recordConfig(s.r).setIdentifier);
  if (pool.length === 0) pool = states.filter((s) => s.h.healthy).length ? states.filter((s) => s.h.healthy) : states; // all zero or all unhealthy: answer anyway
  const total = pool.reduce((n, s) => n + (recordConfig(s.r).weight ?? 0), 0);
  let x = (options.random ?? Math.random)() * (total || pool.length);
  let pick = pool[pool.length - 1].r;
  for (const s of pool) {
    x -= total ? (recordConfig(s.r).weight ?? 0) : 1;
    if (x < 0) {
      pick = s.r;
      break;
    }
  }
  const share = total ? Math.round(((recordConfig(pick).weight ?? 0) / total) * 100) : Math.round(100 / pool.length);
  steps.push(
    `Weighted: picked ${recordConfig(pick).setIdentifier} (weight ${recordConfig(pick).weight}, about ${share}% of answers)${skipped.length ? `; skipped unhealthy ${skipped.join(", ")}` : ""}.`,
  );
  return pick;
}

export async function resolve(engine: Engine, accountId: string, rawName: string, rawType = "A", options: ResolveOptions = {}, depth = 0): Promise<Resolution> {
  const name = normalizeName(rawName);
  const type = rawType.toUpperCase();
  const out: Resolution = { question: { name, type }, status: "NOERROR", answers: [], authority: [], steps: [] };
  if (depth > MAX_DEPTH) {
    out.status = "SERVFAIL";
    out.steps.push("Too many CNAMEs or aliases in a row (a loop?), so the resolver gave up.");
    return out;
  }
  if (isIPv4(name)) {
    out.answers = [{ name, type: "A", ttl: 0, value: name }];
    out.endpoint = { kind: "ip", ip: name };
    return out;
  }

  const aws = await awsName(engine, accountId, name);
  if (aws) {
    if (type === "A") out.answers = aws.addresses.map((a) => ({ name, type: "A", ttl: 60, value: a }));
    out.endpoint = aws.endpoint;
    out.steps.push(`${name} is ${aws.what}; AWS answers for it.`);
    return out;
  }

  // The hosted zone with the longest matching name answers (www.shop.myshop.com prefers shop.myshop.com over myshop.com).
  const zones = (await engine.list(accountId, { service: "route53", type: "hosted-zone", region: "global" }))
    .filter((z) => inZone(name, z.name))
    .sort((a, b) => b.name.length - a.name.length || a.createdAt.localeCompare(b.createdAt));
  const zone = zones[0];
  if (!zone) {
    out.status = "NXDOMAIN";
    out.steps.push(`No hosted zone in your account covers ${name}, so nothing answers for it. (CloudLab's terminal has no internet, so other domains don't resolve.)`);
    return out;
  }
  out.zone = zone;
  const records = (await engine.list(accountId, { service: "route53", type: "record-set", region: "global" })).filter((r) => r.config.zoneId === zone.id);
  const soa = records.find((r) => r.config.type === "SOA" && r.name === zone.name);
  const soaAnswer = soa ? [{ name: zone.name, type: "SOA", ttl: Number(soa.config.ttl ?? 900), value: recordValues(soa)[0] }] : [];
  if (depth === 0) out.steps.push(`The hosted zone ${zone.name} (${zone.id}) answers for ${name}.`);

  let named = records.filter((r) => r.name === name);
  if (named.length === 0) {
    // A wildcard (*.myshop.com) matches names with no records of their own.
    for (let parent = name.split(".").slice(1).join("."); parent && inZone(parent, zone.name); parent = parent.split(".").slice(1).join(".")) {
      const wild = records.filter((r) => r.name === `*.${parent}`);
      if (wild.length) {
        named = wild;
        out.steps.push(`No record named ${name}, but the wildcard *.${parent} matches it.`);
        break;
      }
    }
  }
  if (named.length === 0) {
    const hasChildren = records.some((r) => r.name.endsWith(`.${name}`));
    out.status = hasChildren ? "NOERROR" : "NXDOMAIN";
    out.authority = soaAnswer;
    out.steps.push(`There's no record named ${name} in ${zone.name}${hasChildren ? " (only names below it)" : ""}, so the answer is ${out.status}.`);
    return out;
  }

  const cname = named.find((r) => r.config.type === "CNAME");
  if (cname && type !== "CNAME") {
    const target = normalizeName(recordValues(cname)[0]);
    out.answers.push({ name, type: "CNAME", ttl: Number(cname.config.ttl ?? 300), value: `${target}.` });
    out.steps.push(`${name} is a CNAME for ${target}, so the resolver looks that name up next.`);
    const next = await resolve(engine, accountId, target, type, options, depth + 1);
    out.answers.push(...next.answers);
    out.authority = next.authority;
    out.status = next.status;
    out.endpoint = next.endpoint;
    if (out.endpoint?.kind === "apigateway") out.endpoint = { ...out.endpoint, ownHost: false };
    out.steps.push(...next.steps);
    return out;
  }

  const candidates = named.filter((r) => r.config.type === type);
  if (candidates.length === 0) {
    out.authority = soaAnswer;
    out.steps.push(`${name} exists, but has no ${type} record (it has ${[...new Set(named.map((r) => r.config.type))].join(", ")}).`);
    return out;
  }
  const pick = await choose(engine, accountId, candidates, options, depth, out.steps);
  if (!pick) return out;
  const c: RecordConfig = recordConfig(pick);

  if (c.alias && c.aliasTarget) {
    const next = await resolve(engine, accountId, c.aliasTarget, type, options, depth + 1);
    // An alias answers with the target's addresses under the record's own name: no CNAME in sight.
    out.answers = next.answers.filter((a) => a.type === type).map((a) => ({ ...a, name, ttl: Math.min(a.ttl, 60) }));
    out.status = next.status === "SERVFAIL" ? "SERVFAIL" : "NOERROR";
    out.endpoint = next.endpoint;
    if (out.endpoint?.kind === "apigateway") out.endpoint = { ...out.endpoint, ownHost: false };
    out.steps.push(`${name} is an alias for ${c.aliasTarget}: Route 53 looks up the target itself and answers with its addresses.`);
    out.steps.push(...next.steps.filter((s) => !s.startsWith("The hosted zone")));
    if (out.answers.length === 0) {
      out.authority = soaAnswer;
      out.steps.push(`The alias target ${c.aliasTarget} has no ${type} addresses right now, so the answer is empty.`);
    }
    return out;
  }

  out.answers = recordValues(pick).map((v) => ({ name, type, ttl: Number(c.ttl ?? 300), value: type === "CNAME" || type === "NS" ? `${normalizeName(v)}.` : v }));
  if (type === "A" && out.answers[0]) out.endpoint = { kind: "ip", ip: out.answers[0].value };
  out.steps.push(`${name} ${type} → ${recordValues(pick).join(", ")} (TTL ${c.ttl} s).`);
  return out;
}

// ---------- HTTP ----------

export type WebResult =
  | {
      kind: "response";
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      isBase64?: boolean;
      /** The address the request went to. */
      ip?: string;
      /** What answered, in plain words. */
      servedBy: string;
      resolution?: Resolution;
    }
  | { kind: "error"; exitCode: number; message: string; reason: string; resolution?: Resolution };

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Temporarily Unavailable",
  504: "Gateway Time-out",
};

const albError = (status: number) => {
  const title = `${status} ${STATUS_TEXT[status] ?? ""}`.trim();
  return `<html>\r\n<head><title>${title}</title></head>\r\n<body>\r\n<center><h1>${title}</h1></center>\r\n</body>\r\n</html>\r\n`;
};

const helloPage = (instance: Resource, extra = "") =>
  `<!DOCTYPE html>\n<html><head><title>Hello</title></head><body><h1>Hello from ${instance.id}</h1><p>${instance.name ? `${instance.name}, ` : ""}${String(instance.config.availabilityZone ?? instance.region)}${extra}</p></body></html>\n`;

async function recordRequest(engine: Engine, accountId: string, zone: Resource, host: string, status: number | null) {
  const fresh = await engine.get(accountId, zone.id).catch(() => null);
  if (!fresh) return;
  const previous = (fresh.attributes.recentRequests as { at: string; host: string; status: number | null }[] | undefined) ?? [];
  await engine.setAttributes(accountId, zone.id, { recentRequests: [{ at: engine.now().toISOString(), host, status }, ...previous].slice(0, 20) });
}

/**
 * Sends an HTTP request as if from a computer on the internet: resolve the
 * host, then hand the request to whatever answered. Requests through your
 * hosted zones are remembered on the zone (tutorials and the console use it).
 */
export async function request(
  engine: Engine,
  accountId: string,
  url: string,
  options: ResolveOptions & { method?: string; headers?: Record<string, string>; body?: string; recordOn?: boolean } = {},
): Promise<WebResult> {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`);
  } catch {
    return { kind: "error", exitCode: 3, message: "curl: (3) URL rejected: Malformed input to a URL function", reason: "Malformed URL" };
  }
  const host = normalizeName(parsed.hostname);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const resolution = await resolve(engine, accountId, host, "A", options);
  const done = async (r: WebResult) => {
    if (options.recordOn !== false && resolution.zone) await recordRequest(engine, accountId, resolution.zone, host, r.kind === "response" ? r.status : null);
    return { ...r, resolution };
  };
  if (resolution.status !== "NOERROR" || !resolution.endpoint) {
    return done({ kind: "error", exitCode: 6, message: `curl: (6) Could not resolve host: ${host}`, reason: `DNS: ${resolution.status === "NOERROR" ? "no address" : resolution.status} for ${host}` });
  }
  const ep = resolution.endpoint;
  const ip = resolution.answers.find((a) => a.type === "A")?.value;
  const timeout = (why: string) => ({ kind: "error" as const, exitCode: 28, message: `curl: (28) Failed to connect to ${host} port ${port} after 10002 ms: Timeout was reached`, reason: why });

  if (ep.kind === "apigateway") {
    if (!ep.ownHost) {
      // API Gateway only answers for its own name, or a custom domain set up on it.
      return done({
        kind: "response",
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json" },
        body: '{"message":"Forbidden"}',
        ip,
        servedBy: `API Gateway (${ep.api.name}): it doesn't know the name ${host}. Real APIs need a custom domain name for that; call the API's own address instead.`,
      });
    }
    const res = await handleApiRequest(engine, {
      apiId: ep.api.id,
      method: options.method ?? "GET",
      path: parsed.pathname,
      query: parsed.search.replace(/^\?/, ""),
      headers: { host: parsed.host, ...(options.headers ?? {}) },
      body: options.body ?? "",
      sourceIp: "198.51.100.23",
    });
    return done({ kind: "response", status: res.status, statusText: STATUS_TEXT[res.status] ?? "", headers: res.headers, body: res.body, isBase64: res.isBase64, ip, servedBy: `the API ${ep.api.name}` });
  }

  if (ep.kind === "s3") {
    // S3 picks the bucket by the name in the request: www.myshop.com is served from the bucket named www.myshop.com.
    const m = /^(.+)\.s3-website[.-]/.exec(host);
    const bucket = m ? m[1] : host;
    if (port !== 80) return done(timeout("S3 website endpoints only answer on port 80 (HTTP)."));
    const res = await engine.objects.website(bucket, parsed.pathname.replace(/^\//, ""));
    const isText = /^text\/|json|xml|javascript/.test(res.contentType);
    return done({
      kind: "response",
      status: res.status,
      statusText: STATUS_TEXT[res.status] ?? "",
      headers: { "content-type": res.contentType, server: "AmazonS3", ...(res.location ? { location: res.location } : {}) },
      body: isText ? res.body.toString("utf8") : res.body.toString("base64"),
      isBase64: !isText,
      ip,
      servedBy: `the S3 website of the bucket named ${bucket}`,
    });
  }

  if (ep.kind === "elb") {
    const result = await testLoadBalancer(engine, accountId, ep.lb, { port, count: 1 });
    const r = result.responses[0];
    if (!r || r.status === null) {
      const failing = result.steps.find((s) => s.status === "fail");
      return done(timeout(failing ? `${failing.title}: ${failing.detail}` : result.summary));
    }
    if (r.status === 200) {
      const target = r.targetId ? await engine.get(accountId, r.targetId).catch(() => null) : null;
      const body = target ? helloPage(target, `, behind ${ep.lb.name}`) : "OK\n";
      return done({ kind: "response", status: 200, statusText: "OK", headers: { "content-type": "text/html", server: "CloudLab (simulated web server)" }, body, ip, servedBy: `${r.targetId ?? "a target"} behind ${ep.lb.name}` });
    }
    return done({ kind: "response", status: r.status, statusText: r.statusText, headers: { "content-type": "text/html", server: "awselb/2.0" }, body: albError(r.status), ip, servedBy: `${ep.lb.name}: ${result.summary}` });
  }

  // A plain IP address: one of your instances, or nothing.
  const instance = (await engine.list(accountId, { service: "compute", type: "instance" })).find((i) => i.attributes.publicIp === ep.ip && i.state !== "terminated");
  if (!instance) return done(timeout(`Nothing of yours has the address ${ep.ip}. If it was a server's public IP, the server may have been stopped (it gets a new IP when it starts again) or terminated.`));
  const check = await analyzeReachability(engine, accountId, instance.id, { protocol: "tcp", port, source: "0.0.0.0/0" });
  if (!check.reachable) {
    const failing = check.steps.find((s) => s.status === "fail");
    return done(timeout(failing ? `${failing.title}: ${failing.detail}` : check.summary));
  }
  return done({
    kind: "response",
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html", server: "CloudLab (simulated web server)" },
    body: helloPage(instance),
    ip: ep.ip,
    servedBy: `the instance ${instance.id}`,
  });
}

import { randomBytes } from "node:crypto";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import { allowsService, invokeFunction } from "../lambda/invoke";
import { API_ID, parseRouteKey } from "../services/apigateway";
import type { Resource } from "../types";

/**
 * Serves a request to an HTTP API, the way API Gateway does: pick the stage
 * from the path, match a route (exact, then path variables, then greedy
 * {proxy+}, then $default), check the Lambda function lets API Gateway call
 * it, build the 2.0 (or 1.0) event, run the function and turn its answer into
 * the HTTP response. Failures return API Gateway's own bodies:
 * {"message":"Not Found"}, {"message":"Internal Server Error"}…
 * Each request is logged on the API, with the reason when it failed, so the
 * console can explain a 500.
 */

export interface ApiRequest {
  apiId: string;
  method: string;
  /** Everything after /apigw/<api-id>, e.g. "/prod/hello". */
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  sourceIp: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isBase64?: boolean;
}

export interface RequestLog {
  at: string;
  requestId: string;
  method: string;
  path: string;
  routeKey: string | null;
  stage: string | null;
  status: number;
  latencyMs: number;
  /** Why it failed, in plain words (Nuvora's addition). */
  reason?: string;
  lambdaRequestId?: string;
  /** How long the function took (for IntegrationLatency). */
  integrationMs?: number;
}

/** Requests per API per minute. */
export const API_REQUESTS_PER_MINUTE = 60;
const KEEP_REQUESTS = 25;

const json = (status: number, message: string, extra: Record<string, string> = {}): ApiResponse => ({
  status,
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify({ message }),
});

const requestIdOf = () => `${randomBytes(4).toString("base64url").slice(0, 6)}${"EaAA"}=`;

interface Matched {
  route: Resource;
  pathParameters?: Record<string, string>;
}

/** Route matching in API Gateway's order of preference. */
export function matchRoute(routes: Resource[], method: string, path: string): Matched | null {
  const candidates = routes
    .map((r) => ({ route: r, key: parseRouteKey(String(r.config.routeKey)) }))
    .filter((c): c is { route: Resource; key: { method: string; path: string } } => !!c.key && c.key.path !== "$default");
  const segs = path.split("/").slice(1);
  let best: { m: Matched; score: number } | null = null;
  for (const { route, key } of candidates) {
    if (key.method !== method && key.method !== "ANY") continue;
    const parts = key.path.split("/").slice(1);
    const params: Record<string, string> = {};
    let score = key.method === method ? 1 : 0;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const greedy = /^\{(\w+)\+\}$/.exec(p);
      if (greedy) {
        if (i >= segs.length || segs.slice(i).join("/") === "") {
          ok = false;
          break;
        }
        params[greedy[1]] = segs.slice(i).map(decodeURIComponent).join("/");
        score += 1;
        i = parts.length;
        break;
      }
      if (i >= segs.length) {
        ok = false;
        break;
      }
      const variable = /^\{(\w+)\}$/.exec(p);
      if (variable) {
        if (!segs[i]) {
          ok = false;
          break;
        }
        params[variable[1]] = decodeURIComponent(segs[i]);
        score += 10;
      } else if (p === segs[i]) score += 100;
      else {
        ok = false;
        break;
      }
    }
    if (ok && !parts.some((p) => /\+\}$/.test(p)) && parts.length !== segs.length) ok = false;
    if (ok && (!best || score > best.score)) best = { m: { route, pathParameters: Object.keys(params).length ? params : undefined }, score };
  }
  if (best) return best.m;
  const fallback = routes.find((r) => r.config.routeKey === "$default");
  return fallback ? { route: fallback } : null;
}

export async function handleApiRequest(engine: Engine, req: ApiRequest): Promise<ApiResponse> {
  const started = Date.now();
  const requestId = requestIdOf();
  if (!API_ID.test(req.apiId)) return json(404, "Not Found");
  const api = await engine.findAnywhere(req.apiId);
  if (!api || api.type !== "api") return json(404, "Not Found");
  const accountId = api.accountId;
  const list = (type: string) => engine.list(accountId, { service: "apigateway", type, region: api.region });

  const log = async (entry: Omit<RequestLog, "at" | "requestId" | "method" | "path" | "latencyMs">, res: ApiResponse) => {
    const fresh = await engine.get(accountId, api.id).catch(() => null);
    if (!fresh) return res;
    const previous = (fresh.attributes.recentRequests as RequestLog[] | undefined) ?? [];
    const item: RequestLog = { at: engine.now().toISOString(), requestId, method: req.method, path: req.path || "/", latencyMs: Date.now() - started, ...entry };
    await engine.setAttributes(accountId, api.id, { recentRequests: [item, ...previous].slice(0, KEEP_REQUESTS) });
    await engine.metrics.apiRequest(fresh, entry.stage, { status: res.status, latencyMs: item.latencyMs, integrationMs: entry.integrationMs });
    res.headers["apigw-requestid"] = requestId;
    if (entry.reason) res.headers["x-cloudlab-reason"] = entry.reason.replace(/[^\x20-\x7e]/g, "");
    return res;
  };

  // CORS preflight and headers, when the API allows browser origins.
  const allowed = String(api.config.corsAllowOrigins ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers["origin"];
  const cors: Record<string, string> =
    origin && (allowed.includes("*") || allowed.includes(origin))
      ? { "access-control-allow-origin": allowed.includes("*") ? "*" : origin, vary: "origin" }
      : {};
  if (req.method === "OPTIONS" && Object.keys(cors).length && req.headers["access-control-request-method"]) {
    return { status: 204, headers: { ...cors, "access-control-allow-methods": "*", "access-control-allow-headers": "*", "access-control-max-age": "300" }, body: "" };
  }

  if ((await engine.countInWindow(`apigw:${api.id}`, 60_000)) > API_REQUESTS_PER_MINUTE) {
    return log({ routeKey: null, stage: null, status: 429, reason: `Nuvora allows ${API_REQUESTS_PER_MINUTE} requests a minute per API.` }, json(429, "Too Many Requests"));
  }

  // Stage: a named stage is the first path segment; otherwise $default.
  const stages = (await list("stage")).filter((s) => s.config.apiId === api.id);
  const first = req.path.split("/")[1] ?? "";
  const named = stages.find((s) => s.name !== "$default" && s.name === decodeURIComponent(first));
  const stage = named ?? stages.find((s) => s.name === "$default");
  if (!stage) {
    return log(
      { routeKey: null, stage: null, status: 404, reason: stages.length ? `No stage named '${first}'. Stages: ${stages.map((s) => s.name).join(", ")}.` : "The API has no stage, so nothing is deployed. Create the $default stage." },
      json(404, "Not Found"),
    );
  }
  const path = named ? req.path.slice(first.length + 1) || "/" : req.path || "/";

  const routes = (await list("route")).filter((r) => r.config.apiId === api.id);
  const match = matchRoute(routes, req.method, path);
  if (!match) {
    return log(
      { routeKey: null, stage: stage.name, status: 404, reason: `No route matches ${req.method} ${path}. Routes: ${routes.map((r) => r.config.routeKey).join(", ") || "none"}.` },
      json(404, "Not Found"),
    );
  }
  const routeKey = String(match.route.config.routeKey);
  const integration = match.route.config.integrationId ? await engine.get(accountId, String(match.route.config.integrationId)).catch(() => null) : null;
  if (!integration) {
    return log({ routeKey, stage: stage.name, status: 500, reason: `Route ${routeKey} has no integration attached.` }, json(500, "Internal Server Error"));
  }
  const fn = (await engine.list(accountId, { service: "lambda", type: "function", region: api.region })).find((f) => f.name === integration.config.functionName);
  if (!fn) {
    return log({ routeKey, stage: stage.name, status: 500, reason: `The integration's function ${integration.config.functionName} doesn't exist.` }, json(500, "Internal Server Error"));
  }

  // The function's resource-based policy must let API Gateway invoke it for this route.
  const resourcePath = (routeKey === "$default" ? path : String(parseRouteKey(routeKey)!.path)).replace(/^\//, "");
  const sourceArn = `arn:aws:execute-api:${api.region}:${accountNumber(accountId)}:${api.id}/${stage.name}/${req.method}/${resourcePath}`;
  if (!allowsService(fn, "apigateway.amazonaws.com", sourceArn)) {
    return log(
      {
        routeKey,
        stage: stage.name,
        status: 500,
        reason: `API Gateway isn't allowed to invoke ${fn.name}. Add a permission to the function for apigateway.amazonaws.com (aws lambda add-permission) with a source ARN matching ${sourceArn}.`,
      },
      json(500, "Internal Server Error"),
    );
  }

  const v2 = integration.config.payloadFormatVersion !== "1.0";
  const event = buildEvent(v2, req, { api, stage: stage.name, routeKey, path, pathParameters: match.pathParameters, requestId });
  let result;
  try {
    result = await invokeFunction(engine, accountId, fn, event, "apigateway");
  } catch (e) {
    const throttled = e instanceof EngineError && e.code === "TooManyRequestsException";
    const reason = e instanceof EngineError ? `${e.code}: ${e.message}` : String(e);
    return log({ routeKey, stage: stage.name, status: throttled ? 429 : 500, reason }, throttled ? json(429, "Too Many Requests") : json(500, "Internal Server Error"));
  }
  const timeoutMs = Number(integration.config.timeoutMs ?? 30000);
  if (result.timedOut || result.durationMs > timeoutMs) {
    return log(
      { routeKey, stage: stage.name, status: 503, reason: `The function timed out (${result.timedOut ? "its own timeout" : `the integration's ${timeoutMs} ms`}).`, lambdaRequestId: result.requestId },
      json(503, "Service Unavailable"),
    );
  }
  if (result.functionError) {
    const p = result.payload as { errorType?: string; errorMessage?: string };
    return log(
      { routeKey, stage: stage.name, status: 500, reason: `The function failed: ${p.errorType ?? "Error"}: ${p.errorMessage ?? ""}`, lambdaRequestId: result.requestId },
      json(500, "Internal Server Error"),
    );
  }

  const response = toResponse(v2, result.payload);
  if (!response) {
    return log(
      { routeKey, stage: stage.name, status: 500, reason: "Payload format 1.0 needs the function to return { statusCode, body }.", lambdaRequestId: result.requestId },
      json(500, "Internal Server Error"),
    );
  }
  response.headers = { ...cors, ...response.headers };
  return log({ routeKey, stage: stage.name, status: response.status, lambdaRequestId: result.requestId, integrationMs: Math.round(result.durationMs) }, response);
}

function buildEvent(
  v2: boolean,
  req: ApiRequest,
  r: { api: Resource; stage: string; routeKey: string; path: string; pathParameters?: Record<string, string>; requestId: string },
) {
  const query = new URLSearchParams(req.query);
  const queryStringParameters: Record<string, string> = {};
  for (const k of new Set(query.keys())) queryStringParameters[k] = query.getAll(k).join(",");
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const now = new Date();
  const fullPath = r.stage === "$default" ? r.path : `/${r.stage}${r.path}`;
  const textBody = req.body ? req.body : undefined;
  if (v2) {
    return {
      version: "2.0",
      routeKey: r.routeKey,
      rawPath: fullPath,
      rawQueryString: req.query,
      ...(headers.cookie ? { cookies: headers.cookie.split(/;\s*/) } : {}),
      headers,
      ...(Object.keys(queryStringParameters).length ? { queryStringParameters } : {}),
      requestContext: {
        accountId: accountNumber(r.api.accountId),
        apiId: r.api.id,
        domainName: `${r.api.id}.execute-api.${r.api.region}.cloudlab.local`,
        domainPrefix: r.api.id,
        http: { method: req.method, path: fullPath, protocol: "HTTP/1.1", sourceIp: req.sourceIp, userAgent: headers["user-agent"] ?? "" },
        requestId: r.requestId,
        routeKey: r.routeKey,
        stage: r.stage,
        time: now.toUTCString(),
        timeEpoch: now.getTime(),
      },
      ...(r.pathParameters ? { pathParameters: r.pathParameters } : {}),
      ...(textBody !== undefined ? { body: textBody } : {}),
      isBase64Encoded: false,
    };
  }
  return {
    version: "1.0",
    resource: r.routeKey === "$default" ? "$default" : parseRouteKey(r.routeKey)!.path,
    path: fullPath,
    httpMethod: req.method,
    headers,
    multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
    pathParameters: r.pathParameters ?? null,
    stageVariables: null,
    requestContext: {
      accountId: accountNumber(r.api.accountId),
      apiId: r.api.id,
      httpMethod: req.method,
      path: fullPath,
      requestId: r.requestId,
      stage: r.stage,
      identity: { sourceIp: req.sourceIp, userAgent: headers["user-agent"] ?? "" },
    },
    body: textBody ?? null,
    isBase64Encoded: false,
  };
}

/** The function's answer as an HTTP response (v2 guesses when there's no statusCode; v1 doesn't). */
function toResponse(v2: boolean, payload: unknown): ApiResponse | null {
  const p = payload as Record<string, unknown> | null;
  const structured = p && typeof p === "object" && !Array.isArray(p) && "statusCode" in p;
  if (!structured) {
    if (!v2) return null;
    return { status: 200, headers: { "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
  }
  const status = Number(p.statusCode);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((p.headers as Record<string, unknown>) ?? {})) headers[k.toLowerCase()] = String(v);
  if (Array.isArray(p.cookies) && p.cookies.length) headers["set-cookie"] = (p.cookies as string[]).join(", ");
  const body = p.body === undefined || p.body === null ? "" : typeof p.body === "string" ? p.body : JSON.stringify(p.body);
  headers["content-type"] ??= v2 ? "application/json" : "application/json";
  return { status, headers, body, isBase64: p.isBase64Encoded === true };
}

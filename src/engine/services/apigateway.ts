import { randomBytes } from "node:crypto";
import { EngineError } from "../errors";
import type { ResourceTypeDef, ServiceDef } from "../types";

/**
 * Amazon API Gateway, HTTP APIs (v2): a public HTTPS address whose routes
 * ("GET /hello") send each request to a Lambda function through an
 * integration. A stage ("$default", or "prod") is what's deployed at the
 * address; CloudLab stages always auto-deploy. Each API really answers at
 * /apigw/<api-id>/… on CloudLab, so you can call it from a browser or curl.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const shortId = (n: number) =>
  Array.from(randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join("");

export const API_ID = /^[a-z0-9]{10}$/;
const CHILD = (kind: string) => new RegExp(`^[a-z0-9]{10}/${kind}/[a-z0-9]{7}$`);

export const apiOf = (childId: string) => childId.split("/")[0];

/** "GET /orders/{id}" → method and path; "$default" matches anything no other route does. */
export function parseRouteKey(key: string): { method: string; path: string } | null {
  if (key === "$default") return { method: "ANY", path: "$default" };
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY) (\/[^\s]*)$/.exec(key);
  if (!m) return null;
  const segments = m[2].split("/").slice(1);
  const ok = segments.every((s, i) => {
    if (s === "" && i === segments.length - 1 && segments.length === 1) return true; // "GET /"
    if (/^\{[a-zA-Z0-9_]+\+\}$/.test(s)) return i === segments.length - 1; // greedy {proxy+} only last
    return /^(\{[a-zA-Z0-9_]+\}|[a-zA-Z0-9._~!$&'()*+,;=:@-]+)$/.test(s);
  });
  return ok ? { method: m[1], path: m[2] } : null;
}

const apiRef = { key: "apiId", label: "API", type: "ref" as const, required: true, immutable: true, ref: { service: "apigateway", type: "api" }, param: "ApiId" };

const notFound = (what: string) => (id: string) => `Invalid ${what} identifier specified ${id.split("/").pop()}`;

// ---------- APIs ----------

const api: ResourceTypeDef = {
  service: "apigateway",
  type: "api",
  label: "API",
  pluralLabel: "APIs",
  description:
    "A public web address for your backend. Routes like GET /hello send each request to a Lambda function, and its answer goes back to the caller. Works from a browser or curl.",
  idPrefix: "api",
  makeId: () => shortId(10),
  idPattern: API_ID,
  notFoundCode: "NotFoundException",
  notFoundMessage: (id) => `Invalid API identifier specified ${id}`,
  malformedCode: "NotFoundException",
  malformedMessage: (id) => `Invalid API identifier specified ${id}`,
  apiNoun: "API",
  panelAttributes: ["recentRequests"],
  fields: [
    { key: "name", label: "Name", type: "string", required: true, maxLength: 128, placeholder: "hello-api", param: "Name" },
    { key: "description", label: "Description", type: "string", maxLength: 1024, param: "Description" },
    {
      key: "protocolType",
      label: "Type",
      type: "enum",
      required: true,
      immutable: true,
      default: "HTTP",
      options: [{ value: "HTTP", label: "HTTP API", hint: "Simple, cheap and fast. REST and WebSocket APIs aren't simulated yet." }],
      param: "ProtocolType",
    },
    {
      key: "corsAllowOrigins",
      label: "CORS: allowed origins",
      type: "string",
      maxLength: 512,
      placeholder: "*",
      param: "CorsConfiguration",
      description: "Websites (origins) whose JavaScript may call this API, comma-separated, or * for any. Leave empty for none.",
    },
  ],
  columns: [
    { label: "API ID", path: "id", mono: true },
    { label: "Type", path: "config.protocolType" },
    { label: "Endpoint", path: "attributes.apiEndpoint", mono: true },
  ],
  iam: {
    create: "apigateway:POST",
    read: "apigateway:GET",
    update: "apigateway:PATCH",
    delete: "apigateway:DELETE",
    arn: (r) => `arn:aws:apigateway:${r.region}::/apis/${r.id}`,
  },
  async beforeDelete({ resource, system }) {
    // Deleting an API deletes everything under it.
    for (const type of ["route", "stage", "integration"]) {
      for (const child of (await system.list("apigateway", type)).filter((c) => c.config.apiId === resource.id)) await system.remove(child.id);
    }
  },
  async derive({ id, ctx, existing }) {
    return {
      ...(existing?.attributes ?? {}),
      apiId: id,
      apiEndpoint: `https://${id}.execute-api.${ctx.region}.cloudlab.local`,
      invokePath: `/apigw/${id}`,
    };
  },
};

// ---------- integrations ----------

const integration: ResourceTypeDef = {
  service: "apigateway",
  type: "integration",
  label: "Integration",
  pluralLabel: "Integrations",
  description: "Where an API sends requests: here, a Lambda function (a proxy integration passes the whole request in and the function's answer out).",
  idPrefix: "integration",
  // Child resources live under their API, as in AWS's paths: /apis/<api-id>/integrations/<id>.
  makeId: ({ config }) => `${config.apiId}/integrations/${shortId(7)}`,
  idPattern: CHILD("integrations"),
  notFoundCode: "NotFoundException",
  notFoundMessage: notFound("Integration"),
  malformedCode: "NotFoundException",
  malformedMessage: notFound("Integration"),
  apiNoun: "integration",
  fields: [
    apiRef,
    {
      key: "integrationType",
      label: "Type",
      type: "enum",
      required: true,
      immutable: true,
      default: "AWS_PROXY",
      options: [{ value: "AWS_PROXY", label: "Lambda function (proxy)" }],
      param: "IntegrationType",
    },
    {
      key: "functionName",
      label: "Lambda function",
      type: "ref",
      required: true,
      ref: { service: "lambda", type: "function", by: "name" },
      param: "IntegrationUri",
      refNotFound: (v) => ({ code: "BadRequestException", message: `Integration URI is invalid: function ${v} doesn't exist.` }),
    },
    {
      key: "payloadFormatVersion",
      label: "Payload format",
      type: "enum",
      required: true,
      default: "2.0",
      options: [
        { value: "2.0", label: "2.0", hint: "Simpler event; a plain return value becomes a 200 JSON response" },
        { value: "1.0", label: "1.0", hint: "REST-API style event; must return { statusCode, body }" },
      ],
      param: "PayloadFormatVersion",
    },
    { key: "timeoutMs", label: "Timeout (ms)", type: "number", required: true, default: 30000, min: 50, max: 30000, param: "TimeoutInMillis" },
  ],
  columns: [
    { label: "API", path: "config.apiId", mono: true },
    { label: "Function", path: "config.functionName" },
  ],
  iam: {
    create: "apigateway:POST",
    read: "apigateway:GET",
    update: "apigateway:PATCH",
    delete: "apigateway:DELETE",
    arn: (r) => `arn:aws:apigateway:${r.region}::/apis/${r.id}`,
  },
  async derive({ id, config, ctx }) {
    const fn = (await ctx.list("lambda", "function")).find((f) => f.name === config.functionName);
    return { integrationId: id.split("/").pop(), integrationUri: fn?.id ?? null, integrationMethod: "POST", connectionType: "INTERNET" };
  },
};

// ---------- routes ----------

const route: ResourceTypeDef = {
  service: "apigateway",
  type: "route",
  label: "Route",
  pluralLabel: "Routes",
  description: "A method and path, like GET /hello or POST /orders, and the integration that handles it. $default catches every request no other route matches.",
  idPrefix: "route",
  makeId: ({ config }) => `${config.apiId}/routes/${shortId(7)}`,
  idPattern: CHILD("routes"),
  notFoundCode: "NotFoundException",
  notFoundMessage: notFound("Route"),
  malformedCode: "NotFoundException",
  malformedMessage: notFound("Route"),
  apiNoun: "route",
  fields: [
    apiRef,
    {
      key: "routeKey",
      label: "Route",
      type: "string",
      required: true,
      maxLength: 512,
      placeholder: "GET /hello",
      param: "RouteKey",
      description: "METHOD /path, e.g. GET /hello, POST /orders, GET /orders/{id}, ANY /{proxy+}, or $default.",
    },
    {
      key: "integrationId",
      label: "Integration",
      type: "ref",
      ref: { service: "apigateway", type: "integration", weak: true },
      param: "Target",
      description: "Without one, requests to this route fail.",
    },
  ],
  columns: [
    { label: "Route", path: "config.routeKey", mono: true },
    { label: "API", path: "config.apiId", mono: true },
  ],
  iam: {
    create: "apigateway:POST",
    read: "apigateway:GET",
    update: "apigateway:PATCH",
    delete: "apigateway:DELETE",
    arn: (r) => `arn:aws:apigateway:${r.region}::/apis/${r.id}`,
  },
  async validate({ config, existing, ctx }) {
    const key = String(config.routeKey).trim();
    if (!parseRouteKey(key)) {
      throw new EngineError(
        "BadRequestException",
        `Unable to create route ${key}. Route keys must be $default or an HTTP method and a path, such as GET /pets or ANY /{proxy+}.`,
      );
    }
    const siblings = (await ctx.list("apigateway", "route")).filter((r) => r.config.apiId === config.apiId && r.id !== existing?.id);
    if (siblings.some((r) => r.config.routeKey === key)) {
      throw new EngineError("ConflictException", `Unable to create route ${key}. A route with this key already exists for the API.`);
    }
    if (config.integrationId && apiOf(String(config.integrationId)) !== config.apiId) {
      throw new EngineError("BadRequestException", `Invalid target specified: the integration belongs to another API.`);
    }
  },
  async derive({ id, config }) {
    return {
      routeId: id.split("/").pop(),
      target: config.integrationId ? `integrations/${String(config.integrationId).split("/").pop()}` : null,
      authorizationType: "NONE",
    };
  },
};

// ---------- stages ----------

const stage: ResourceTypeDef = {
  service: "apigateway",
  type: "stage",
  label: "Stage",
  pluralLabel: "Stages",
  description: "A deployed version of the API at its address. $default serves the API at the root; a named stage like prod serves it under /prod. Changes deploy automatically.",
  idPrefix: "stage",
  makeId: ({ name, config }) => `${config.apiId}/stages/${name}`,
  idPattern: /^[a-z0-9]{10}\/stages\/[\w$-]{1,128}$/,
  notFoundCode: "NotFoundException",
  notFoundMessage: (id) => `Invalid stage identifier specified ${id.split("/").pop()}`,
  malformedCode: "NotFoundException",
  malformedMessage: (id) => `Invalid stage identifier specified ${id}`,
  apiNoun: "stage",
  fields: [
    apiRef,
    {
      key: "name",
      label: "Stage name",
      type: "string",
      required: true,
      immutable: true,
      default: "$default",
      maxLength: 128,
      pattern: "^(\\$default|[a-zA-Z0-9_-]+)$",
      patternMessage: "$default, or letters, numbers, _ and -.",
      param: "StageName",
    },
  ],
  columns: [
    { label: "API", path: "config.apiId", mono: true },
    { label: "URL path", path: "attributes.basePath", mono: true },
  ],
  iam: {
    create: "apigateway:POST",
    read: "apigateway:GET",
    delete: "apigateway:DELETE",
    arn: (r) => `arn:aws:apigateway:${r.region}::/apis/${r.id}`,
  },
  async validate({ config, existing, ctx }) {
    if (existing) return;
    if ((await ctx.list("apigateway", "stage")).some((s) => s.config.apiId === config.apiId && s.name === config.name)) {
      throw new EngineError("ConflictException", `Stage ${config.name} already exists`);
    }
  },
  async derive({ config }) {
    return { autoDeploy: true, basePath: config.name === "$default" ? "/" : `/${config.name}` };
  },
};


export const apiGatewayService: ServiceDef = {
  id: "apigateway",
  label: "API Gateway",
  modelledOn: "API Gateway",
  description: "Public HTTP APIs whose routes call your Lambda functions.",
  category: "Networking",
  types: [api, route, integration, stage],
};

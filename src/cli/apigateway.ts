import { EngineError } from "@/engine/errors";
import { accountNumber } from "@/engine/ids";
import { LAMBDA_ARN } from "@/engine/services/lambda";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { parseShorthand, UsageError } from "./parse";

/**
 * `aws apigatewayv2` (HTTP APIs): APIs, integrations, routes and stages.
 * IAM checks use API Gateway's own scheme: the HTTP verb as the action
 * (apigateway:POST) on the resource path (arn:aws:apigateway:<region>::/apis/<id>).
 */

const cmd = (c: Command) => c;

const list = (ctx: CliContext, type: string) => ctx.engine.list(ctx.accountId, { service: "apigateway", type, region: ctx.region });
const create = (ctx: CliContext, type: string, config: Record<string, unknown>) =>
  ctx.engine.create(ctx.accountId, { service: "apigateway", type, region: ctx.region, config });

async function apiById(ctx: CliContext, id: string): Promise<Resource> {
  const api = (await list(ctx, "api")).find((a) => a.id === id);
  if (!api) throw new EngineError("NotFoundException", `Invalid API identifier specified ${accountNumber(ctx.accountId)}:${id}`, 404);
  return api;
}

async function childOf(ctx: CliContext, type: string, apiId: string, childId: string, what: string): Promise<Resource> {
  const found = (await list(ctx, type)).find((r) => r.config.apiId === apiId && r.id.split("/").pop() === childId);
  if (!found) throw new EngineError("NotFoundException", `Invalid ${what} identifier specified ${childId}`, 404);
  return found;
}

/** apigateway:<VERB> on /apis[/<id>[/<kind>[/<child>]]]. */
const perm = (verb: string, kind?: string, childOption?: string) => (args: Args, ctx: CliContext) => {
  const api = args.one("api-id");
  const child = childOption ? args.one(childOption) : undefined;
  const path = `/apis${api ? `/${api}` : ""}${kind ? `/${kind}` : ""}${child ? `/${child}` : ""}`;
  return [{ action: `apigateway:${verb}`, resource: `arn:aws:apigateway:${ctx.region}::${path}` }];
};

/** --target / --integration-uri: a Lambda function ARN → its name. */
function functionFromArn(ctx: CliContext, uri: string): string {
  const arn = uri.replace(/^arn:aws:apigateway:[a-z0-9-]+:lambda:path\/2015-03-31\/functions\/(.+)\/invocations$/, "$1");
  if (!LAMBDA_ARN.test(arn)) {
    throw new EngineError("BadRequestException", `Invalid integration URI specified. Use a Lambda function ARN, e.g. arn:aws:lambda:${ctx.region}:<account>:function:<name>`);
  }
  return arn.split(":").pop()!;
}

function corsArg(args: Args): string | undefined {
  const raw = args.raw("cors-configuration").join(" ");
  if (!raw) return undefined;
  const v = parseShorthand(raw) as Record<string, string | string[]>;
  return [v.AllowOrigins ?? []].flat().join(",");
}

// ---------- output shapes ----------

function apiOut(api: Resource) {
  const origins = String(api.config.corsAllowOrigins ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ApiEndpoint: api.attributes.apiEndpoint,
    ApiId: api.id,
    ApiKeySelectionExpression: "$request.header.x-api-key",
    CreatedDate: api.createdAt,
    ...(origins.length ? { CorsConfiguration: { AllowOrigins: origins, AllowMethods: ["*"], AllowHeaders: ["*"] } } : {}),
    ...(api.config.description ? { Description: api.config.description } : {}),
    DisableExecuteApiEndpoint: false,
    Name: api.name,
    ProtocolType: "HTTP",
    RouteSelectionExpression: "$request.method $request.path",
    Tags: {},
  };
}

function integrationOut(i: Resource) {
  return {
    ConnectionType: "INTERNET",
    IntegrationId: i.id.split("/").pop(),
    IntegrationMethod: "POST",
    IntegrationType: "AWS_PROXY",
    IntegrationUri: i.attributes.integrationUri,
    PayloadFormatVersion: i.config.payloadFormatVersion,
    TimeoutInMillis: i.config.timeoutMs,
  };
}

function routeOut(r: Resource) {
  return {
    ApiKeyRequired: false,
    AuthorizationType: "NONE",
    RouteId: r.id.split("/").pop(),
    RouteKey: r.config.routeKey,
    ...(r.attributes.target ? { Target: r.attributes.target } : {}),
  };
}

function stageOut(s: Resource) {
  return {
    AutoDeploy: true,
    CreatedDate: s.createdAt,
    DefaultRouteSettings: { DetailedMetricsEnabled: false },
    LastUpdatedDate: s.updatedAt,
    RouteSettings: {},
    StageName: s.name,
    StageVariables: {},
    Tags: {},
  };
}

/** --target integrations/<id> → the integration's resource ID. */
async function targetArg(ctx: CliContext, apiId: string, value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const m = /^integrations\/([a-z0-9]{7})$/.exec(value);
  if (!m) throw new EngineError("BadRequestException", `Invalid target specified: ${value}. Use integrations/<integration-id>.`);
  return (await childOf(ctx, "integration", apiId, m[1], "Integration")).id;
}

export const APIGATEWAY_COMMANDS: Command[] = [
  // --- APIs ---
  cmd({
    service: "apigatewayv2",
    operation: "create-api",
    apiName: "CreateApi",
    summary: "Create an HTTP API (with --target: also a route and stage that call your function)",
    usage: "--name <name> --protocol-type HTTP [--target <function-arn>] [--description <text>] [--cors-configuration AllowOrigins=*]",
    mutates: true,
    permissions: perm("POST"),
    async run(args, ctx) {
      const protocol = args.required("protocol-type");
      if (protocol !== "HTTP") throw new EngineError("BadRequestException", `CloudLab simulates HTTP APIs only, not ${protocol}.`);
      const target = args.one("target");
      const functionName = target ? functionFromArn(ctx, target) : undefined;
      const api = await create(ctx, "api", {
        name: args.required("name"),
        description: args.one("description"),
        protocolType: "HTTP",
        corsAllowOrigins: corsArg(args),
      });
      if (functionName) {
        // Quick create: an integration, a $default route and an auto-deploying $default stage.
        const integration = await create(ctx, "integration", { apiId: api.id, functionName, payloadFormatVersion: "2.0" });
        await create(ctx, "route", { apiId: api.id, routeKey: "$default", integrationId: integration.id });
        await create(ctx, "stage", { apiId: api.id, name: "$default" });
      }
      return apiOut(api);
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "get-apis",
    apiName: "GetApis",
    summary: "List HTTP APIs",
    mutates: false,
    permissions: perm("GET"),
    async run(_args, ctx) {
      return { Items: (await list(ctx, "api")).map(apiOut) };
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "get-api",
    apiName: "GetApi",
    summary: "Show an API and its endpoint",
    usage: "--api-id <id>",
    mutates: false,
    permissions: perm("GET"),
    async run(args, ctx) {
      return apiOut(await apiById(ctx, args.required("api-id")));
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "update-api",
    apiName: "UpdateApi",
    summary: "Rename an API or change its CORS settings",
    usage: "--api-id <id> [--name <name>] [--description <text>] [--cors-configuration AllowOrigins=*]",
    mutates: true,
    permissions: perm("PATCH"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      const patch: Record<string, unknown> = {};
      if (args.one("name")) patch.name = args.one("name");
      if (args.one("description") !== undefined) patch.description = args.one("description");
      const cors = corsArg(args);
      if (cors !== undefined) patch.corsAllowOrigins = cors;
      return apiOut(await ctx.engine.update(ctx.accountId, api.id, patch));
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "delete-api",
    apiName: "DeleteApi",
    summary: "Delete an API with its routes, integrations and stages",
    usage: "--api-id <id>",
    mutates: true,
    permissions: perm("DELETE"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      await ctx.engine.remove(ctx.accountId, api.id);
    },
  }),

  // --- integrations ---
  cmd({
    service: "apigatewayv2",
    operation: "create-integration",
    apiName: "CreateIntegration",
    summary: "Connect an API to a Lambda function",
    usage:
      "--api-id <id> --integration-type AWS_PROXY --integration-uri <function-arn> --payload-format-version 2.0 [--timeout-in-millis <ms>]",
    mutates: true,
    permissions: perm("POST", "integrations"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      const type = args.required("integration-type");
      if (type !== "AWS_PROXY") throw new EngineError("BadRequestException", `CloudLab supports AWS_PROXY (Lambda) integrations only, not ${type}.`);
      const uri = args.one("integration-uri");
      if (!uri) throw new EngineError("BadRequestException", "IntegrationUri is required for AWS_PROXY integrations.");
      const version = args.one("payload-format-version");
      if (!version) throw new EngineError("BadRequestException", "PayloadFormatVersion is required for AWS_PROXY integrations. Use 2.0 (or 1.0).");
      const timeout = args.one("timeout-in-millis");
      const i = await create(ctx, "integration", {
        apiId: api.id,
        functionName: functionFromArn(ctx, uri),
        payloadFormatVersion: version,
        timeoutMs: timeout ? Number(timeout) : 30000,
      });
      return integrationOut(i);
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "get-integrations",
    apiName: "GetIntegrations",
    summary: "List an API's integrations",
    usage: "--api-id <id>",
    mutates: false,
    permissions: perm("GET", "integrations"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      return { Items: (await list(ctx, "integration")).filter((i) => i.config.apiId === api.id).map(integrationOut) };
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "delete-integration",
    apiName: "DeleteIntegration",
    summary: "Delete an integration",
    usage: "--api-id <id> --integration-id <id>",
    mutates: true,
    permissions: perm("DELETE", "integrations", "integration-id"),
    async run(args, ctx) {
      const i = await childOf(ctx, "integration", args.required("api-id"), args.required("integration-id"), "Integration");
      await ctx.engine.remove(ctx.accountId, i.id);
    },
  }),

  // --- routes ---
  cmd({
    service: "apigatewayv2",
    operation: "create-route",
    apiName: "CreateRoute",
    summary: "Add a route like 'GET /hello' that sends requests to an integration",
    usage: "--api-id <id> --route-key <\"GET /hello\"> [--target integrations/<integration-id>]",
    mutates: true,
    permissions: perm("POST", "routes"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      const routeKey = args.one("route-key");
      if (!routeKey) throw new UsageError("the following arguments are required: --route-key");
      const r = await create(ctx, "route", { apiId: api.id, routeKey, integrationId: await targetArg(ctx, api.id, args.one("target")) });
      return routeOut(r);
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "get-routes",
    apiName: "GetRoutes",
    summary: "List an API's routes",
    usage: "--api-id <id>",
    mutates: false,
    permissions: perm("GET", "routes"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      return { Items: (await list(ctx, "route")).filter((r) => r.config.apiId === api.id).map(routeOut) };
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "update-route",
    apiName: "UpdateRoute",
    summary: "Change a route's key or target",
    usage: "--api-id <id> --route-id <id> [--route-key <key>] [--target integrations/<integration-id>]",
    mutates: true,
    permissions: perm("PATCH", "routes", "route-id"),
    async run(args, ctx) {
      const apiId = args.required("api-id");
      const r = await childOf(ctx, "route", apiId, args.required("route-id"), "Route");
      const patch: Record<string, unknown> = {};
      if (args.one("route-key")) patch.routeKey = args.one("route-key");
      if (args.has("target")) patch.integrationId = await targetArg(ctx, apiId, args.one("target"));
      return routeOut(await ctx.engine.update(ctx.accountId, r.id, patch));
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "delete-route",
    apiName: "DeleteRoute",
    summary: "Delete a route",
    usage: "--api-id <id> --route-id <id>",
    mutates: true,
    permissions: perm("DELETE", "routes", "route-id"),
    async run(args, ctx) {
      const r = await childOf(ctx, "route", args.required("api-id"), args.required("route-id"), "Route");
      await ctx.engine.remove(ctx.accountId, r.id);
    },
  }),

  // --- stages and deployments ---
  cmd({
    service: "apigatewayv2",
    operation: "create-stage",
    apiName: "CreateStage",
    summary: "Deploy the API at its address ($default) or under a name (/prod)",
    usage: "--api-id <id> --stage-name <$default|name> [--auto-deploy]",
    mutates: true,
    permissions: perm("POST", "stages"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      return stageOut(await create(ctx, "stage", { apiId: api.id, name: args.required("stage-name") }));
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "get-stages",
    apiName: "GetStages",
    summary: "List an API's stages",
    usage: "--api-id <id>",
    mutates: false,
    permissions: perm("GET", "stages"),
    async run(args, ctx) {
      const api = await apiById(ctx, args.required("api-id"));
      return { Items: (await list(ctx, "stage")).filter((s) => s.config.apiId === api.id).map(stageOut) };
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "delete-stage",
    apiName: "DeleteStage",
    summary: "Delete a stage",
    usage: "--api-id <id> --stage-name <name>",
    mutates: true,
    permissions: perm("DELETE", "stages", "stage-name"),
    async run(args, ctx) {
      const s = await childOf(ctx, "stage", args.required("api-id"), args.required("stage-name"), "Stage");
      await ctx.engine.remove(ctx.accountId, s.id);
    },
  }),
  cmd({
    service: "apigatewayv2",
    operation: "create-deployment",
    apiName: "CreateDeployment",
    summary: "Deploy the API's current routes (CloudLab stages already auto-deploy)",
    usage: "--api-id <id> [--stage-name <name>]",
    mutates: true,
    permissions: perm("POST", "deployments"),
    async run(args, ctx) {
      await apiById(ctx, args.required("api-id"));
      const id = Math.random().toString(36).slice(2, 8);
      return { AutoDeployed: false, CreatedDate: ctx.engine.now().toISOString(), DeploymentId: id, DeploymentStatus: "DEPLOYED" };
    },
  }),
];

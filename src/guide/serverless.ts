import type { Engine } from "@/engine/engine";
import { accountNumber } from "@/engine/ids";
import { allowsService } from "@/engine/lambda/invoke";
import { trustedPrincipals } from "@/engine/services/iam";
import type { Resource } from "@/engine/types";

/** What the serverless tutorial looks at: a Lambda role, a function and an HTTP API that calls it. */
export interface ServerlessState {
  role?: Resource;
  fn?: Resource;
  api?: Resource;
  stage?: Resource;
  integration?: Resource;
  route?: Resource;
  requests: { status: number; reason?: string; routeKey: string | null }[];
  /** Whether the function's policy lets this API call GET /hello. */
  permitted: boolean;
}

export async function loadServerless(engine: Engine, accountId: string, region: string): Promise<ServerlessState> {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region: service === "iam" ? "global" : region });
  const [roles, fns, apis, stages, integrations, routes] = await Promise.all([
    list("iam", "role"),
    list("lambda", "function"),
    list("apigateway", "api"),
    list("apigateway", "stage"),
    list("apigateway", "integration"),
    list("apigateway", "route"),
  ]);
  const trustsLambda = (r: Resource) => {
    try {
      return trustedPrincipals(String(r.config.trustPolicy ?? "{}")).services.includes("lambda.amazonaws.com");
    } catch {
      return false;
    }
  };
  const role = roles.find((r) => r.name === "lambda-basic" && trustsLambda(r)) ?? roles.find(trustsLambda);
  const fn = fns.find((f) => f.name === "hello") ?? fns[0];
  // The API whose integration calls the function, else the newest one.
  const integration = integrations.find((i) => fn && i.config.functionName === fn.name);
  const api = apis.find((a) => a.id === integration?.config.apiId) ?? apis[0];
  const stage = api ? (stages.find((s) => s.config.apiId === api.id && s.name === "$default") ?? stages.find((s) => s.config.apiId === api.id)) : undefined;
  const route = api ? routes.find((r) => r.config.apiId === api.id && r.config.integrationId && /^GET \/hello$/.test(String(r.config.routeKey))) : undefined;
  const requests = ((api?.attributes.recentRequests as ServerlessState["requests"] | undefined) ?? []).slice();
  const permitted =
    !!fn && !!api && allowsService(fn, "apigateway.amazonaws.com", `arn:aws:execute-api:${region}:${accountNumber(accountId)}:${api.id}/${stage?.name ?? "$default"}/GET/hello`);
  return { role, fn, api, stage, integration: api && integration?.config.apiId === api.id ? integration : undefined, route, requests, permitted };
}

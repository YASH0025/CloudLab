import type { Engine } from "@/engine/engine";
import type { Suggestion } from "./types";

/**
 * Advisor rules for Lambda and API Gateway: an API whose calls fail because
 * the function doesn't allow API Gateway, an API with nothing deployed, and a
 * function whose latest run failed.
 */
export async function serverlessAdvice(engine: Engine, accountId: string, region: string) {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [fns, apis, stages] = await Promise.all([list("lambda", "function"), list("apigateway", "api"), list("apigateway", "stage")]);
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];

  for (const api of apis) {
    const last = ((api.attributes.recentRequests as { status: number; reason?: string }[] | undefined) ?? [])[0];
    const link = { service: "apigateway", type: "api", mode: "detail" as const, id: api.id };
    if (last?.status === 500 && last.reason?.includes("isn't allowed to invoke")) {
      const fnName = /invoke (\S+)\./.exec(last.reason)?.[1];
      const fn = fns.find((f) => f.name === fnName);
      problems.push({
        id: `api-permission-${api.id}`,
        level: "intermediate",
        title: `${api.name} can't call ${fnName ?? "its function"} (500 errors)`,
        why: "API Gateway may only invoke a function whose resource-based policy allows it. Without that statement, every request returns Internal Server Error.",
        steps: [`Open ${fnName ?? "the function"}. Under Resource-based policy, choose ${api.name} and click Add permission.`, "Send the request again: 200."],
        link: fn ? { service: "lambda", type: "function", mode: "detail", id: fn.id } : link,
        cli: `aws lambda add-permission --function-name ${fnName ?? "<function>"} --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com`,
      });
    } else if (!stages.some((s) => s.config.apiId === api.id)) {
      problems.push({
        id: `api-no-stage-${api.id}`,
        level: "intermediate",
        title: `${api.name} isn't deployed`,
        why: "An HTTP API answers only through a stage. With none, every request is 404 Not Found.",
        steps: [`Open ${api.name} and click Create $default stage.`],
        link,
        cli: `aws apigatewayv2 create-stage --api-id ${api.id} --stage-name '$default'`,
      });
    }
  }

  for (const fn of fns) {
    const last = ((fn.attributes.invocations as { status: string; errorType?: string }[] | undefined) ?? [])[0];
    if (last && last.status !== "Succeeded") {
      suggestions.push({
        id: `fn-failing-${fn.id}`,
        level: "intermediate",
        title: `${fn.name}'s last run ${last.status === "Timed out" ? "timed out" : `failed (${last.errorType})`}`,
        why:
          last.status === "Timed out"
            ? `It ran longer than its ${String(fn.config.timeout)} s timeout. Raise the timeout or make the code faster (and check for promises that never resolve).`
            : "Open the function and expand the failed invocation under Recent invocations: the log shows the error and where it happened.",
        steps: [`Open ${fn.name}, read the failed invocation's log, fix the code and Deploy.`, "Run Test again."],
        link: { service: "lambda", type: "function", mode: "detail", id: fn.id },
      });
    }
  }
  return { problems, suggestions, hasFunction: fns.length > 0 };
}

import type { NextRequest } from "next/server";
import { EngineError } from "@/engine/errors";
import { confirmSubscription } from "@/engine/sns/publish";
import { getCaller, getEngine, handle } from "@/server/api";

/**
 * The "Confirm subscription" link in a confirmation email. Like the real link, it
 * needs no AWS permission: having the email is the proof.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/resources/[id]/confirm">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const caller = await getCaller();
    const engine = getEngine();
    const sub = await engine.get(caller.accountId, id);
    if (sub.service !== "sns" || sub.type !== "subscription") throw new EngineError("ValidationError", "Only SNS subscriptions can be confirmed.");
    const topic = await engine.get(caller.accountId, String(sub.config.topicArn));
    const confirmed = await confirmSubscription(engine, caller.accountId, topic, String(sub.attributes.token));
    return Response.json({ subscriptionArn: confirmed.id });
  });
}

import type { Engine } from "@/engine/engine";
import { allowsService } from "@/engine/lambda/invoke";
import type { Delivery } from "@/engine/sns/publish";
import { functionArnOf } from "@/engine/services/sns";
import { systemOf } from "@/engine/types";
import type { Suggestion } from "./types";

/**
 * Advisor rules for SNS: messages that aren't reaching anyone (unconfirmed
 * email, a Lambda subscriber SNS may not invoke, failed deliveries), alarms
 * that tell nobody, and topics with no subscribers.
 */
export async function snsAdvice(engine: Engine, accountId: string, region: string) {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [topics, subs, alarms, fns] = await Promise.all([list("sns", "topic"), list("sns", "subscription"), list("cloudwatch", "alarm"), list("lambda", "function")]);
  const problems: Suggestion[] = [];
  const suggestions: Suggestion[] = [];
  const topicName = (arn: unknown) => String(arn).split(":").pop();

  for (const s of subs) {
    if (s.state !== "confirmed") {
      problems.push({
        id: `sns-unconfirmed-${s.id}`,
        level: "beginner",
        title: `${String(s.config.endpoint)} isn't receiving ${topicName(s.config.topicArn)}'s messages`,
        why: "An email subscription gets nothing until it's confirmed from the confirmation email. SNS skips it silently: publishing still succeeds.",
        steps: ["Open the subscription.", "In its inbox, open the confirmation email and click Confirm subscription."],
        link: { service: "sns", type: "subscription", mode: "detail", id: s.id },
      });
      continue;
    }
    if (s.config.protocol !== "lambda") continue;
    const fnArn = functionArnOf(String(s.config.endpoint));
    const fn = fns.find((f) => f.id === fnArn);
    if (fn && !allowsService(fn, "sns.amazonaws.com", String(s.config.topicArn))) {
      problems.push({
        id: `sns-lambda-permission-${s.id}`,
        level: "intermediate",
        title: `SNS can't invoke ${fn.name}`,
        why: `${fn.name} is subscribed to ${topicName(s.config.topicArn)}, but its resource-based policy doesn't let sns.amazonaws.com invoke it, so every delivery fails.`,
        steps: ["Open the subscription and click Allow this topic to invoke the function.", "Publish a test message: Recent deliveries should say Delivered."],
        link: { service: "sns", type: "subscription", mode: "detail", id: s.id },
        cli: `aws lambda add-permission --function-name ${fn.name} --statement-id sns-${topicName(s.config.topicArn)} --action lambda:InvokeFunction --principal sns.amazonaws.com --source-arn ${String(s.config.topicArn)}`,
      });
    }
  }

  for (const t of topics) {
    const mine = subs.filter((s) => s.config.topicArn === t.id);
    const recent = ((t.attributes.deliveries as Delivery[] | undefined) ?? []).slice(0, 10);
    const failed = recent.find((d) => d.status === "failed" && mine.some((s) => s.id === d.subscriptionArn && !problems.some((p) => p.id.endsWith(s.id))));
    if (failed) {
      problems.push({
        id: `sns-failed-${t.id}`,
        level: "intermediate",
        title: `Messages to ${t.name} are failing for ${failed.endpoint.split(":").pop()}`,
        why: failed.reason ?? "A recent delivery failed.",
        steps: ["Open the topic and read Recent deliveries.", "Fix the cause, then publish a test message."],
        link: { service: "sns", type: "topic", mode: "detail", id: t.id },
      });
    }
    const users = alarms.some((a) => [...((a.config.alarmActions as string[] | undefined) ?? []), ...((a.config.okActions as string[] | undefined) ?? [])].includes(t.id));
    if (mine.length === 0 && users) {
      problems.push({
        id: `sns-no-subscribers-${t.id}`,
        level: "beginner",
        title: `Alarms notify ${t.name}, but nobody is subscribed`,
        why: "When an alarm goes off it publishes to the topic, and with no subscribers the message goes nowhere.",
        steps: ["Open the topic and click Create subscription.", "Subscribe your email and confirm it from the inbox."],
        link: { service: "sns", type: "subscription", mode: "create", prefill: { topicArn: t.id, protocol: "email" } },
      });
    }
  }

  // An alarm that tells nobody: suggest wiring it to a topic.
  const silent = alarms.find((a) => !systemOf(a).managedBy && ((a.config.alarmActions as string[] | undefined) ?? []).length === 0);
  if (silent) {
    suggestions.push({
      id: "get-alerted",
      level: "intermediate",
      title: `Get an email when ${silent.name} goes off`,
      why: "An alarm only changes colour on a page nobody is watching. Give it an action: publish to an SNS topic you've subscribed your email to.",
      steps: ["Open Guide me → Tutorials and start 'Get alerted: SNS topics and email'.", "Or create a topic, subscribe your email, then edit the alarm and pick the topic under When it goes into ALARM, notify."],
      link: topics[0] ? { service: "cloudwatch", type: "alarm", mode: "detail", id: silent.id } : { service: "sns", type: "topic", mode: "create", prefill: { name: "alerts" } },
    });
  }
  return { problems, suggestions };
}

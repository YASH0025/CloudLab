import type { Engine } from "@/engine/engine";
import type { Delivery } from "@/engine/sns/publish";
import type { InboxEmail } from "@/engine/services/sns";
import type { Resource } from "@/engine/types";

/** The topic the SNS tutorial suggests. */
export const ALERTS_TOPIC = "alerts";
export const ALERTS_EMAIL = "me@example.com";

/** What the SNS tutorial looks at: a topic, an email subscription, an alarm that notifies it, and a filtered subscriber. */
export interface AlertsState {
  topic?: Resource;
  /** An email subscription to the topic. */
  email?: Resource;
  confirmed: boolean;
  /** A message has reached the email subscription. */
  delivered: boolean;
  /** An alarm (not one Auto Scaling made) that publishes to the topic when it goes off. */
  alarm?: Resource;
  /** Any alarm, to suggest adding the action to. */
  anyAlarm?: Resource;
  /** An alarm email in the inbox. */
  alarmEmail: boolean;
  /** A subscription to the topic with a filter policy. */
  filtered?: Resource;
  /** That subscription has both received and skipped a message. */
  filterSeen: boolean;
}

export async function loadAlerts(engine: Engine, accountId: string, region: string): Promise<AlertsState> {
  const list = (service: string, type: string) => engine.list(accountId, { service, type, region });
  const [topics, subs, alarms] = await Promise.all([list("sns", "topic"), list("sns", "subscription"), list("cloudwatch", "alarm")]);
  const topic = topics.find((t) => t.name === ALERTS_TOPIC) ?? topics[0];
  const mine = topic ? subs.filter((s) => s.config.topicArn === topic.id) : [];
  const email = mine.find((s) => s.config.protocol === "email" && !s.config.filterPolicy) ?? mine.find((s) => s.config.protocol === "email");
  const inbox = (email?.attributes.inbox as InboxEmail[] | undefined) ?? [];
  const deliveries = (topic?.attributes.deliveries as Delivery[] | undefined) ?? [];
  const own = alarms.filter((a) => !(a.attributes.system as { managedBy?: string } | undefined)?.managedBy);
  const alarm = topic ? own.find((a) => ((a.config.alarmActions as string[] | undefined) ?? []).includes(topic.id)) : undefined;
  const filtered = mine.find((s) => !!s.config.filterPolicy);
  const forFiltered = filtered ? deliveries.filter((d) => d.subscriptionArn === filtered.id) : [];
  return {
    topic,
    email,
    confirmed: email?.state === "confirmed",
    delivered: inbox.some((m) => m.kind === "notification"),
    alarm,
    anyAlarm: own.find((a) => a.config.namespace === "AWS/Lambda" && a.config.metricName === "Errors") ?? own[0],
    alarmEmail: inbox.some((m) => m.kind === "notification" && m.subject.startsWith("ALARM:")),
    filtered,
    filterSeen: forFiltered.some((d) => d.status === "delivered") && forFiltered.some((d) => d.status === "filtered"),
  };
}

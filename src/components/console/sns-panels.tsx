"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, InboxIcon, Loader2Icon, MailIcon, PlusIcon, SendIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Delivery, DeliveryStatus } from "@/engine/sns/publish";
import type { InboxEmail } from "@/engine/services/sns";
import type { ResourceDTO } from "@/engine/types";
import { useConfirmSubscription, usePermission, usePublish, useQueueAction, useResource, useResources } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

const STATUS: Record<DeliveryStatus, { label: string; variant: "success" | "destructive" | "secondary" | "warning" }> = {
  delivered: { label: "Delivered", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  filtered: { label: "Filtered out", variant: "secondary" },
  "pending-confirmation": { label: "Not confirmed", variant: "warning" },
  sending: { label: "Sending", variant: "secondary" },
};

export function SubscriptionState({ state }: { state: string | null }) {
  return state === "confirmed" ? <Badge variant="success">Confirmed</Badge> : <Badge variant="warning">Pending confirmation</Badge>;
}

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

interface AttrRow {
  name: string;
  type: string;
  value: string;
}

function PublishCard({ topic }: { topic: ResourceDTO }) {
  const publish = usePublish(topic);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("Hello from CloudLab!");
  const [perProtocol, setPerProtocol] = useState(false);
  const [attrs, setAttrs] = useState<AttrRow[]>([]);
  const result = publish.data;
  const error = publish.error instanceof ApiError ? publish.error : null;

  const send = () =>
    publish.mutate({
      message,
      subject: subject || undefined,
      messageStructure: perProtocol ? "json" : undefined,
      attributes: Object.fromEntries(attrs.filter((a) => a.name).map((a) => [a.name, { DataType: a.type, StringValue: a.value }])),
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SendIcon className="size-4" /> Publish message
        </CardTitle>
        <CardDescription>Every confirmed subscriber whose filter policy matches gets a copy. Below, you&apos;ll see what happened to each one.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-1.5">
            <Label htmlFor="sns-subject">Subject (optional)</Label>
            <Input id="sns-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="New order" maxLength={100} />
            <p className="text-xs text-muted-foreground">Used as the email subject. Up to 100 plain characters.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Message structure</Label>
            <Select value={perProtocol ? "json" : "same"} onValueChange={(v) => setPerProtocol(v === "json")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">Identical payload for all protocols</SelectItem>
                <SelectItem value="json">Custom payload for each protocol (JSON)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sns-message">Message body</Label>
          <textarea
            id="sns-message"
            className={textareaClass}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={perProtocol ? '{ "default": "for programs", "email": "for people" }' : "Order 42 was placed"}
          />
          {perProtocol && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              A JSON object: &quot;default&quot; is required, plus optional &quot;email&quot;, &quot;email-json&quot;, &quot;lambda&quot;.
              <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setMessage('{\n  "default": "Order 42 placed",\n  "email": "Hi! Order 42 was just placed."\n}')}>
                Insert example
              </Button>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <div>
            <Label>Message attributes</Label>
            <p className="text-xs text-muted-foreground">Labels on the message (e.g. type = order). Filter policies decide using these, never the body.</p>
          </div>
          {attrs.map((a, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1fr)_auto] items-center gap-2">
              <Input aria-label="Attribute name" placeholder="type" value={a.name} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Select value={a.type} onValueChange={(v) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, type: v } : x)))}>
                <SelectTrigger aria-label="Attribute type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="String">String</SelectItem>
                  <SelectItem value="Number">Number</SelectItem>
                  <SelectItem value="String.Array">String.Array</SelectItem>
                </SelectContent>
              </Select>
              <Input aria-label="Attribute value" placeholder={a.type === "String.Array" ? '["a","b"]' : a.type === "Number" ? "120" : "order"} value={a.value} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Button type="button" size="icon" variant="ghost" aria-label="Remove attribute" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => setAttrs([...attrs, { name: "", type: "String", value: "" }])} disabled={attrs.length >= 10}>
            <PlusIcon /> Add attribute
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={send} disabled={publish.isPending || !message}>
            {publish.isPending ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Publish message
          </Button>
          {result && (
            <span className="text-sm text-muted-foreground">
              Message <span className="font-mono text-xs">{result.messageId}</span> published:{" "}
              {result.deliveries.length === 0 ? "nobody is subscribed yet." : `${result.deliveries.filter((d) => d.status === "delivered").length} of ${result.deliveries.length} delivered.`}
            </span>
          )}
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            <span className="font-mono">{error.code}</span>: {error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DeliveryLog({ topic }: { topic: ResourceDTO }) {
  const deliveries = (topic.attributes.deliveries as Delivery[] | undefined) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent deliveries</CardTitle>
        <CardDescription>
          What happened to each copy of the last messages. On AWS you&apos;d piece this together from CloudWatch metrics (NumberOfNotificationsFailed…) and delivery logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-5">
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing published yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d, i) => (
                <TableRow key={`${d.messageId}-${d.subscriptionArn}-${i}`}>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{ago(d.at)}</TableCell>
                  <TableCell className="max-w-56">
                    <Link href={routes.detail("sns", "subscription", d.subscriptionArn)} className="block truncate font-mono text-xs text-primary hover:underline" title={d.endpoint}>
                      {d.protocol}: {d.protocol === "lambda" ? d.endpoint.split(":function:")[1] : d.endpoint}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
                  </TableCell>
                  <TableCell className="min-w-48 text-xs whitespace-normal text-muted-foreground">{d.reason ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** A topic's page: who's subscribed, a way to publish, and what happened to recent messages. */
export function TopicPanel({ topic }: { topic: ResourceDTO }) {
  const subs = useResources("sns", "subscription");
  const mine = (subs.data ?? []).filter((s) => s.config.topicArn === topic.id);
  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>Subscriptions</CardTitle>
            <CardDescription>Who receives this topic&apos;s messages. Email subscriptions must be confirmed before they get anything.</CardDescription>
          </div>
          <Button asChild size="sm">
            <Link href={routes.createPrefilled("sns", "subscription", { topicArn: topic.id })}>
              <PlusIcon /> Create subscription
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="pb-5">
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscriptions. Publishing now would reach nobody.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Filter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mine.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-72">
                      <Link href={routes.detail("sns", "subscription", s.id)} className="block truncate font-mono text-xs text-primary hover:underline">
                        {String(s.config.endpoint)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">{String(s.config.protocol)}</TableCell>
                    <TableCell>
                      <SubscriptionState state={s.state} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.config.filterPolicy ? "Yes" : "All messages"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <PublishCard topic={topic} />
      <DeliveryLog topic={topic} />
    </>
  );
}

function Email({ email, sub }: { email: InboxEmail; sub: ResourceDTO }) {
  const [open, setOpen] = useState(email.kind === "confirmation" && sub.state !== "confirmed");
  const confirm = useConfirmSubscription(sub.id);
  const confirmLink = "Confirm subscription";
  return (
    <li className="rounded-md border">
      <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDownIcon className="mt-0.5 size-4 shrink-0" /> : <ChevronRightIcon className="mt-0.5 size-4 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{email.subject}</span>
          <span className="block truncate text-xs text-muted-foreground">{email.from}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{ago(email.at)}</span>
      </button>
      {open && (
        <div className="border-t px-3 py-3">
          <pre className="font-mono text-xs break-words whitespace-pre-wrap">
            {email.kind === "confirmation"
              ? email.body.split("\n").map((line, i) =>
                  line === confirmLink ? (
                    <span key={i} className="block py-1">
                      {sub.state === "confirmed" ? (
                        <span className="inline-flex items-center gap-1 font-sans text-success">
                          <CheckCircle2Icon className="size-4" /> Subscription confirmed!
                        </span>
                      ) : (
                        <Button size="sm" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
                          {confirm.isPending ? <Loader2Icon className="animate-spin" /> : <CheckCircle2Icon />} Confirm subscription
                        </Button>
                      )}
                    </span>
                  ) : (
                    <span key={i} className="block">
                      {line || " "}
                    </span>
                  ),
                )
              : email.body}
          </pre>
        </div>
      )}
    </li>
  );
}

function LambdaAccess({ sub }: { sub: ResourceDTO }) {
  const fnArn = String(sub.config.endpoint).split(":").slice(0, 7).join(":");
  const fn = useResource(fnArn);
  const { add } = usePermission(fnArn);
  if (fn.isLoading) return null;
  const fnItem = fn.data?.item;
  if (!fnItem) {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" /> The function {fnArn.split(":").pop()} doesn&apos;t exist, so every delivery will fail.
      </p>
    );
  }
  const statements = (fnItem.attributes.permissions as { Principal: { Service?: string }; Condition?: { ArnLike?: Record<string, string> } }[] | undefined) ?? [];
  const topic = String(sub.config.topicArn);
  const allowed = statements.some((s) => s.Principal.Service === "sns.amazonaws.com" && (!s.Condition?.ArnLike?.["AWS:SourceArn"] || topic.startsWith(s.Condition.ArnLike["AWS:SourceArn"].replace(/\*$/, ""))));
  return allowed ? (
    <p className="flex items-center gap-2 text-sm">
      <CheckCircle2Icon className="size-4 text-success" /> SNS may invoke{" "}
      <Link href={routes.detail("lambda", "function", fnArn)} className="font-mono text-xs text-primary hover:underline">
        {fnItem.name}
      </Link>{" "}
      for this topic.
    </p>
  ) : (
    <div className="space-y-2">
      <p className="flex items-start gap-2 text-sm">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          SNS isn&apos;t allowed to invoke <span className="font-mono text-xs">{fnItem.name}</span>, so deliveries fail. A function decides who may call it in its resource-based policy. Subscribing from
          the Lambda console adds this for you; the CLI&apos;s <span className="font-mono text-xs">sns subscribe</span> doesn&apos;t.
        </span>
      </p>
      <Button size="sm" variant="outline" disabled={add.isPending} onClick={() => add.mutate({ statementId: `sns-${topic.split(":").pop()}`.slice(0, 100), principal: "sns.amazonaws.com", sourceArn: topic })}>
        Allow this topic to invoke the function
      </Button>
    </div>
  );
}

function QueueAccess({ sub }: { sub: ResourceDTO }) {
  const arn = String(sub.config.endpoint);
  const [, , , region, account, name] = arn.split(":");
  const url = `https://sqs.${region}.amazonaws.com/${account}/${name}`;
  const q = useResource(url);
  const { mutate, isPending } = useQueueAction(url);
  if (q.isLoading) return null;
  const queue = q.data?.item;
  if (!queue) {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" /> The queue {name} doesn&apos;t exist, so every delivery will fail.
      </p>
    );
  }
  const topic = String(sub.config.topicArn);
  let allowed = false;
  try {
    const doc = JSON.parse(String(queue.config.policy ?? "{}")) as { Statement?: unknown };
    const statements = (Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : []) as { Effect?: string; Principal?: unknown; Condition?: Record<string, Record<string, string>> }[];
    allowed = statements.some((s) => {
      if (s.Effect !== "Allow" || !JSON.stringify(s.Principal ?? "").includes("sns.amazonaws.com")) return false;
      const src = Object.values(s.Condition ?? {}).map((c) => c["aws:SourceArn"] ?? c["aws:sourcearn"] ?? c["AWS:SourceArn"]).find(Boolean);
      return !src || src === topic || (src.endsWith("*") && topic.startsWith(src.slice(0, -1)));
    });
  } catch {
    allowed = false;
  }
  return allowed ? (
    <p className="flex items-center gap-2 text-sm">
      <CheckCircle2Icon className="size-4 text-success" /> The queue&apos;s access policy lets this topic send to{" "}
      <Link href={routes.detail("sqs", "queue", url)} className="font-mono text-xs text-primary hover:underline">
        {name}
      </Link>
      .
    </p>
  ) : (
    <div className="space-y-2">
      <p className="flex items-start gap-2 text-sm">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          The queue <span className="font-mono text-xs">{name}</span> doesn&apos;t let SNS send to it, so deliveries fail. A queue decides who may send in its access policy: it needs to allow
          sns.amazonaws.com to sqs:SendMessage, with this topic as aws:SourceArn.
        </span>
      </p>
      <Button size="sm" variant="outline" disabled={isPending} onClick={() => mutate({ action: "subscribe", topicArn: topic })}>
        Allow this topic to send to the queue
      </Button>
    </div>
  );
}

/** A subscription's page: the simulated inbox (email) or whether SNS can reach the function (Lambda). */
export function SubscriptionPanel({ sub }: { sub: ResourceDTO }) {
  const inbox = (sub.attributes.inbox as InboxEmail[] | undefined) ?? [];
  const protocol = String(sub.config.protocol);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {protocol === "lambda" ? (
            "Delivery to the function"
          ) : protocol === "sqs" ? (
            "Delivery to the queue"
          ) : (
            <>
              <InboxIcon className="size-4" /> Inbox of {String(sub.config.endpoint)}
            </>
          )}
        </CardTitle>
        <CardDescription>
          {protocol === "lambda"
            ? "Each message runs the function with an event holding it (event.Records[0].Sns.Message)."
            : protocol === "sqs"
              ? sub.config.rawMessageDelivery
                ? "Raw message delivery is on: the queue gets just the message text."
                : "Each message arrives in the queue wrapped in SNS's JSON envelope (Type, MessageId, TopicArn, Message…). Turn on raw message delivery to get just the text."
            : "A pretend mailbox: CloudLab doesn't send real email, so messages for this address land here."}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-5">
        {protocol === "lambda" ? (
          <LambdaAccess sub={sub} />
        ) : protocol === "sqs" ? (
          <QueueAccess sub={sub} />
        ) : inbox.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <MailIcon className="size-4" /> No email yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {inbox.map((e) => (
              <Email key={e.id} email={e} sub={sub} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

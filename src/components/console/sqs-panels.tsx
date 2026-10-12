"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { BellRingIcon, DownloadIcon, Loader2Icon, PlusIcon, SendIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReceivedMessage } from "@/engine/sqs/queue";
import type { ResourceDTO } from "@/engine/types";
import { useQueueAction, useQueueCounts, useResources } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";

const textareaClass =
  "min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function ErrorLine({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      <span className="font-mono">{error.code}</span>: {error.message}
    </p>
  );
}

function Count({ label, value, hint }: { label: string; value: number | undefined; hint: string }) {
  return (
    <div className="rounded-md border p-3" title={hint}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value ?? "–"}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

interface AttrRow {
  name: string;
  type: string;
  value: string;
}

/** A queue's page: what's in it, send a message, poll like a consumer would, delete what's done. */
export function QueuePanel({ queue }: { queue: ResourceDTO }) {
  const counts = useQueueCounts(queue.id);
  const send = useQueueAction(queue.id);
  const poll = useQueueAction(queue.id);
  const del = useQueueAction(queue.id);
  const purge = useQueueAction(queue.id);
  const [body, setBody] = useState('{ "orderId": 1042, "item": "book" }');
  const [delay, setDelay] = useState("");
  const [attrs, setAttrs] = useState<AttrRow[]>([]);
  const [received, setReceived] = useState<(ReceivedMessage & { at: number; deleted?: boolean })[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // A clock for "back in the queue": the visibility timeout runs out while you watch.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const vt = Number(queue.config.visibilityTimeout);
  const dlq = queue.config.deadLetterQueue ? String(queue.config.deadLetterQueue) : null;

  const doPoll = () =>
    poll.mutate(
      { action: "receive", maxNumberOfMessages: 10 },
      { onSuccess: (r) => setReceived((prev) => [...(r.messages ?? []).map((m) => ({ ...m, at: Date.now() })), ...prev.filter((p) => !r.messages?.some((m) => m.MessageId === p.MessageId))].slice(0, 20)) },
    );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
          <CardDescription>Counts are approximate on AWS (a queue is spread over many servers); here they&apos;re exact. Refreshes every few seconds.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pb-5 sm:grid-cols-3">
          <Count label="Available" value={counts.data?.available} hint="Waiting to be received" />
          <Count label="In flight" value={counts.data?.inFlight} hint={`Received, not deleted yet: back in ≤ ${vt}s`} />
          <Count label="Delayed" value={counts.data?.delayed} hint="Sent with a delay, not visible yet" />
          {dlq && (
            <p className="text-sm text-muted-foreground sm:col-span-3">
              Messages received more than {String(queue.config.maxReceiveCount ?? 10)} times move to the dead-letter queue{" "}
              <Link href={routes.detail("sqs", "queue", dlq)} className="font-mono text-xs text-primary hover:underline">
                {dlq.split("/").pop()}
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SendIcon className="size-4" /> Send message
          </CardTitle>
          <CardDescription>What a producer (your web app, an SNS topic…) does. Usually the body is JSON describing a job.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pb-5">
          <div className="space-y-1.5">
            <Label htmlFor="sqs-body">Message body</Label>
            <textarea id="sqs-body" className={textareaClass} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
            <div className="space-y-1.5">
              <Label htmlFor="sqs-delay">Delivery delay (seconds, optional)</Label>
              <Input id="sqs-delay" inputMode="numeric" placeholder={String(queue.config.delaySeconds ?? 0)} value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Message attributes</Label>
            {attrs.map((a, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto] items-center gap-2">
                <Input aria-label="Attribute name" placeholder="type" value={a.name} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Select value={a.type} onValueChange={(v) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, type: v } : x)))}>
                  <SelectTrigger aria-label="Attribute type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="String">String</SelectItem>
                    <SelectItem value="Number">Number</SelectItem>
                  </SelectContent>
                </Select>
                <Input aria-label="Attribute value" placeholder="order" value={a.value} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <Button type="button" size="icon" variant="ghost" aria-label="Remove attribute" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" disabled={attrs.length >= 10} onClick={() => setAttrs([...attrs, { name: "", type: "String", value: "" }])}>
              <PlusIcon /> Add attribute
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={send.isPending || !body}
              onClick={() =>
                send.mutate({
                  action: "send",
                  body,
                  delaySeconds: delay ? Number(delay) : undefined,
                  attributes: Object.fromEntries(attrs.filter((a) => a.name).map((a) => [a.name, { DataType: a.type, StringValue: a.value }])),
                })
              }
            >
              {send.isPending ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Send message
            </Button>
            {send.data?.sent && (
              <span className="text-sm text-muted-foreground">
                Sent: <span className="font-mono text-xs">{send.data.sent.MessageId}</span>
              </span>
            )}
          </div>
          <ErrorLine error={send.error} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <DownloadIcon className="size-4" /> Receive messages
            </CardTitle>
            <CardDescription>
              What a consumer (a worker) does: poll, process, then delete. A message you don&apos;t delete becomes visible again after {vt} seconds and is received again.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={doPoll} disabled={poll.isPending}>
              {poll.isPending ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />} Poll for messages
            </Button>
            <Button variant="outline" disabled={purge.isPending} onClick={() => purge.mutate({ action: "purge" }, { onSuccess: () => setReceived([]) })}>
              Purge
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pb-5">
          <ErrorLine error={poll.error ?? purge.error ?? del.error} />
          {poll.data && poll.data.messages?.length === 0 && <p className="text-sm text-muted-foreground">No messages available right now (the CLI prints nothing in this case).</p>}
          {poll.data?.movedToDlq ? <p className="text-sm text-warning">{poll.data.movedToDlq} message(s) had been received too many times and moved to the dead-letter queue.</p> : null}
          {received.length > 0 && (
            <ul className="space-y-2">
              {received.map((m) => {
                const count = Number(m.Attributes?.ApproximateReceiveCount ?? 1);
                const expired = now - m.at > vt * 1000;
                return (
                  <li key={m.MessageId + m.ReceiptHandle} className="rounded-md border">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline" onClick={() => setOpen(open === m.MessageId ? null : m.MessageId)}>
                        {m.Body}
                      </button>
                      <Badge variant={count > 1 ? "warning" : "secondary"} title="ApproximateReceiveCount">
                        received {count}×
                      </Badge>
                      {m.deleted ? (
                        <Badge variant="success">Deleted</Badge>
                      ) : expired ? (
                        <Badge variant="secondary" title="The visibility timeout ran out: this receipt handle can't delete it any more. Poll again.">
                          Back in the queue
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={del.isPending}
                          onClick={() => del.mutate({ action: "delete", receiptHandle: m.ReceiptHandle }, { onSuccess: () => setReceived((prev) => prev.map((p) => (p === m ? { ...p, deleted: true } : p))) })}
                        >
                          <Trash2Icon /> Delete
                        </Button>
                      )}
                    </div>
                    {open === m.MessageId && (
                      <div className="space-y-2 border-t px-3 py-2 text-xs">
                        <pre className="font-mono break-words whitespace-pre-wrap">{m.Body}</pre>
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-muted-foreground">
                          <dt>Message ID</dt>
                          <dd className="font-mono break-all">{m.MessageId}</dd>
                          {Object.entries(m.Attributes ?? {}).map(([k, v]) => (
                            <div key={k} className="contents">
                              <dt>{k}</dt>
                              <dd className="font-mono break-all">{/Timestamp$/.test(k) && v ? `${v} (${formatDistanceToNowStrict(new Date(Number(v)), { addSuffix: true })})` : v}</dd>
                            </div>
                          ))}
                          {Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => (
                            <div key={k} className="contents">
                              <dt>{k}</dt>
                              <dd className="font-mono break-all">
                                {v.StringValue} ({v.DataType})
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <SubscribeCard queue={queue} />
    </>
  );
}

/** "Subscribe to Amazon SNS topic", as in the SQS console: it also lets the topic send to the queue. */
function SubscribeCard({ queue }: { queue: ResourceDTO }) {
  const topics = useResources("sns", "topic");
  const subs = useResources("sns", "subscription");
  const action = useQueueAction(queue.id);
  const [topic, setTopic] = useState("");
  const arn = String(queue.attributes.arn);
  const mine = (subs.data ?? []).filter((s) => s.config.protocol === "sqs" && s.config.endpoint === arn);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRingIcon className="size-4" /> SNS subscriptions
        </CardTitle>
        <CardDescription>
          A topic can put a copy of every message in this queue (fan-out). From here, the console also adds the access-policy statement that lets the topic send; with the CLI you add it yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        {mine.length > 0 && (
          <ul className="space-y-1 text-sm">
            {mine.map((s) => (
              <li key={s.id}>
                <Link href={routes.detail("sns", "subscription", s.id)} className="font-mono text-xs text-primary hover:underline">
                  {String(s.config.topicArn).split(":").pop()}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(topics.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No SNS topics in this region.{" "}
            <Link href={routes.create("sns", "topic")} className="text-primary hover:underline">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={topic} onValueChange={setTopic}>
              <SelectTrigger className="w-64 max-w-full" aria-label="Topic">
                <SelectValue placeholder="Choose a topic" />
              </SelectTrigger>
              <SelectContent>
                {(topics.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={!topic || action.isPending} onClick={() => action.mutate({ action: "subscribe", topicArn: topic })}>
              Subscribe to topic
            </Button>
          </div>
        )}
        <ErrorLine error={action.error} />
      </CardContent>
    </Card>
  );
}

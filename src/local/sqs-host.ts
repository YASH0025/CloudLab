import type { Resource } from "@/engine/types";
import { NON_EXISTENT } from "@/engine/services/sqs";
import { arnFromUrl } from "@/engine/sqs/attributes";
import { countsOf, statsOf } from "@/engine/sqs/queue";
import { FileResourceHost, type ResourceSpec } from "./file-host";

/**
 * SQS queues on the learner's computer: one JSON file per queue, holding its
 * settings and messages. The agent runs CloudLab's own SQS code against this.
 */
export class FileQueueHost extends FileResourceHost {
  constructor(dir: string, onChange: (q: Resource) => void = () => undefined, now: () => Date = () => new Date()) {
    super(dir, "sqs", "queue", () => NON_EXISTENT(), onChange, now);
  }

  protected initialAttributes() {
    return { messages: [] };
  }

  /** Receiving edits messages in place (receive count, visibility), so each message is copied; their bodies are shared strings. */
  protected copy(q: Resource): Resource {
    const a = q.attributes;
    const messages = ((a.messages as Record<string, unknown>[] | undefined) ?? []).map((m) => ({ ...m }));
    return { ...q, config: structuredClone(q.config), refs: [...q.refs], attributes: { ...a, messages, stats: { ...(a.stats as object) } } };
  }

  protected specAttributes(spec: ResourceSpec) {
    return {
      queueUrl: spec.id,
      arn: arnFromUrl(spec.id),
      deadLetterName: spec.config.deadLetterQueue ? String(spec.config.deadLetterQueue).split("/").pop() : null,
    };
  }

  /** What CloudLab shows about a queue on this computer: counts, never the messages. */
  report(name: string) {
    const q = this.peek(name);
    if (!q) return null;
    const c = countsOf(q, this.now().getTime());
    return {
      approximateMessages: c.available,
      approximateInFlight: c.inFlight,
      approximateDelayed: c.delayed,
      stats: statsOf(q),
      ...(q.attributes.lastPurgeAt ? { lastPurgeAt: q.attributes.lastPurgeAt } : {}),
    };
  }
}

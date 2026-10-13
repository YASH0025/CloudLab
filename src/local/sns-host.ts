import { EngineError } from "@/engine/errors";
import type { ServiceHost } from "@/engine/host";
import type { Resource } from "@/engine/types";
import { FileResourceHost, type ResourceSpec } from "./file-host";

const notFound = (what: string) => () => new EngineError("NotFound", `${what} does not exist`, 404);

/** SNS topics on the learner's computer: settings, recent deliveries and publish counts. */
export class FileTopicHost extends FileResourceHost {
  constructor(dir: string, onChange: (t: Resource) => void = () => undefined, now: () => Date = () => new Date()) {
    super(dir, "sns", "topic", notFound("Topic"), onChange, now);
  }

  /** What CloudLab shows on the topic's page: the delivery log (who got what, no message bodies) and counts. */
  report(name: string) {
    const t = this.peek(name);
    return t ? { deliveries: t.attributes.deliveries ?? [], published: t.attributes.published ?? null } : null;
  }
}

/**
 * SNS subscriptions on the learner's computer. Email ones keep their simulated
 * inbox here; it's reported to CloudLab, since real email leaves your computer anyway.
 */
export class FileSubscriptionHost extends FileResourceHost {
  constructor(dir: string, onChange: (s: Resource) => void = () => undefined, now: () => Date = () => new Date()) {
    super(dir, "sns", "subscription", notFound("Subscription"), onChange, now);
  }

  protected specAttributes(spec: ResourceSpec) {
    // The token never changes; keep it even when an update leaves it out.
    return spec.attributes?.token ? { token: spec.attributes.token, topicName: spec.attributes.topicName } : {};
  }

  report(name: string) {
    const s = this.peek(name);
    return s ? { inbox: s.attributes.inbox ?? [] } : null;
  }
}

/**
 * All of a computer's local stores as one ServiceHost, so code that crosses
 * services (SNS publishing to an SQS queue) finds each resource where it lives.
 */
export class LocalHosts implements ServiceHost {
  readonly holdsLocalItems = true;
  readonly metrics = { record: async () => undefined };

  constructor(
    private hosts: FileResourceHost[],
    readonly now: () => Date = () => new Date(),
    readonly deliverHttp?: ServiceHost["deliverHttp"],
    readonly snsEndpoint?: string,
  ) {}

  private owner(id: string) {
    const h = this.hosts.find((x) => x.owns(id));
    if (!h) throw new EngineError("NotFound", `${id.split(/[/:]/).pop()} does not exist`, 404);
    return h;
  }

  get(accountId: string, id: string) {
    return this.owner(id).get(accountId, id);
  }

  async list(accountId: string, filter: { service?: string; type?: string; region?: string }) {
    const all = await Promise.all(this.hosts.filter((h) => (!filter.service || h.service === filter.service) && (!filter.type || h.type === filter.type)).map((h) => h.list(accountId, filter)));
    return all.flat();
  }

  async setAttributes(accountId: string, id: string, patch: Record<string, unknown>) {
    const h = this.hosts.find((x) => x.owns(id));
    if (h) await h.setAttributes(accountId, id, patch);
  }

  countInWindow(key: string, windowMs: number) {
    return this.hosts[0].countInWindow(key, windowMs);
  }
}

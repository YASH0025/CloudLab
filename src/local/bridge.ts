import { IMAGES, INSTANCE_TYPES } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { EngineError } from "@/engine/errors";
import { getTypeDef } from "@/engine/registry";
import type { LocalBridge, Resource } from "@/engine/types";
import type { LocalService } from "./service";
import type { LocalResourceSpec, Ec2Spec, ResourceTask, S3BucketSpec } from "./types";

/** What each machine image runs as on the learner's computer. */
export const LOCAL_IMAGES: Record<string, string> = {
  "ami-0ubuntu24040lts01": "ubuntu:24.04",
  "ami-0debian120000001": "debian:12",
  "ami-0lab2023linux0001": "amazonlinux:2023",
};

/**
 * Types that run for real on the learner's computer. EC2 joins once it's been
 * tried on real Docker; until then the local region refuses it like other services.
 */
export const REAL = new Set(["storage/bucket", "dynamodb/table", "sqs/queue", "sns/topic", "sns/subscription"]);

export function bucketSpec(r: Resource): S3BucketSpec {
  const c = r.config;
  return {
    name: r.id,
    versioning: String(c.versioning ?? "Disabled"),
    blockPublicAccess: c.blockPublicAccess !== false,
    publicRead: c.publicRead === true,
    websiteEnabled: c.websiteEnabled === true,
    indexDocument: c.indexDocument ? String(c.indexDocument) : null,
    errorDocument: c.errorDocument ? String(c.errorDocument) : null,
  };
}

export const localSpec = (r: Resource): LocalResourceSpec => ({
  id: r.id,
  name: r.name,
  config: r.config,
  createdAt: r.createdAt,
  state: r.state,
  // A subscription's token (to build its SubscribeURL) and the inbox it starts with.
  ...(r.service === "sns" && r.type === "subscription" ? { attributes: { token: r.attributes.token, inbox: r.attributes.inbox ?? [], topicName: r.attributes.topicName } } : {}),
});

/** A type the agent may create through CloudLab: one that really runs on the learner's computer. */
export function localType(service: string, type: string) {
  if (!REAL.has(`${service}/${type}`)) throw new EngineError("NotAvailableLocally", `${service}/${type} doesn't run on My computer (local).`, 400);
}

/** Ports opened when a rule allows all traffic (a container can't publish every port). */
export const ALL_TRAFFIC_PORTS = [22, 80, 443, 3000, 5000, 8000, 8080];
const MAX_RANGE = 20;

interface SgRule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
}

/** TCP ports a set of security groups opens to an address range. Ranges are capped, since each port is published on the computer. */
export function openPorts(groups: Resource[]): number[] {
  const ports = new Set<number>();
  for (const g of groups) {
    for (const r of (g.config.inboundRules as SgRule[] | undefined) ?? []) {
      // Rules naming another security group are about instances talking to each other, which they
      // already can on CloudLab's Docker network; only address ranges open a port to the network.
      if (!r.cidr) continue;
      if (r.protocol === "all") ALL_TRAFFIC_PORTS.forEach((p) => ports.add(p));
      else if (r.protocol === "tcp" && r.fromPort !== undefined) {
        const to = Math.min(r.toPort ?? r.fromPort, r.fromPort + MAX_RANGE - 1);
        for (let p = r.fromPort; p <= to; p++) ports.add(p);
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Turns local-region changes into work for the account's agent: an EC2 instance
 * becomes a Linux container, and its security groups decide which ports it opens.
 */
export class AgentBridge implements LocalBridge {
  constructor(
    private local: LocalService,
    private engine: Engine,
  ) {}

  /** Every type in the local region comes through here: some run for real, some are just records, the rest aren't there yet. */
  handles() {
    return true;
  }

  realizes(service: string, type: string) {
    return service === "compute" && type === "instance";
  }

  async ready(accountId: string, r: { service: string; type: string; config: Record<string, unknown> }) {
    // Networks are bookkeeping that real services build on (and every region gets a default VPC).
    if (r.service === "networking") return;
    if (REAL.has(`${r.service}/${r.type}`)) {
      await this.local.requireAgent(accountId);
      return;
    }
    if (!REAL.has(`${r.service}/${r.type}`)) {
      const def = getTypeDef(r.service, r.type);
      throw new EngineError(
        "NotAvailableLocally",
        `${def.pluralLabel} don't run on My computer (local) yet. There, today: S3 buckets, DynamoDB tables, SQS queues and SNS topics, for real, with their data on your computer. Use another region to practise with simulated ${def.pluralLabel.toLowerCase()}.`,
        400,
      );
    }
    const imageId = String(r.config.imageId ?? "");
    if (imageId && !LOCAL_IMAGES[imageId] && IMAGES.some((i) => i.id === imageId)) {
      const name = IMAGES.find((i) => i.id === imageId)?.name;
      throw new EngineError("Unsupported", `${name} can't run on your computer (it would need a Windows virtual machine). Pick a Linux image: Ubuntu, Debian or Lab Linux.`);
    }
    await this.local.requireAgent(accountId);
  }

  private async spec(r: Resource): Promise<Ec2Spec> {
    const groups = (
      await Promise.all(((r.config.securityGroupIds as string[]) ?? []).map((id) => this.engine.get(r.accountId, id).catch(() => null)))
    ).filter((g): g is Resource => !!g);
    const type = INSTANCE_TYPES.find((t) => t.name === r.config.instanceType) ?? INSTANCE_TYPES[1];
    const image = IMAGES.find((i) => i.id === r.config.imageId);
    const privateIp = String(r.attributes.privateIp ?? "10.0.0.10");
    return {
      id: r.id,
      name: r.name || r.id,
      image: LOCAL_IMAGES[String(r.config.imageId)] ?? "ubuntu:24.04",
      imageName: image?.name ?? "Linux",
      cpus: type.vcpus,
      memoryMb: Math.round(type.memoryGiB * 1024),
      userData: typeof r.config.userData === "string" && r.config.userData.trim() ? r.config.userData : null,
      ports: openPorts(groups),
      hostname: `ip-${privateIp.replace(/\./g, "-")}`,
    };
  }

  private async send(r: Resource, op: ResourceTask["op"]) {
    await this.local.queueResource(r.accountId, { kind: "ec2", op, id: r.id, spec: await this.spec(r) });
  }

  async notify(e: { kind: "create" | "update" | "action" | "delete"; resource: Resource; previous?: Resource; action?: string }) {
    // Tasks carry the resource as it is now: hooks may have moved it on already (a queue
    // subscription is confirmed while it's being created), and an older picture arriving
    // later would undo that on the computer.
    const r = e.kind === "delete" || e.resource.service === "compute" ? e.resource : await this.engine.get(e.resource.accountId, e.resource.id).catch(() => e.resource);
    if (r.service === "storage" && r.type === "bucket") {
      const op = e.kind === "create" ? "create-bucket" : e.kind === "delete" ? "delete-bucket" : "configure-bucket";
      try {
        await this.local.queueResource(r.accountId, { kind: "s3", op, id: r.id, bucket: bucketSpec(r) });
      } catch (err) {
        // A bucket deleted with no computer connected has nothing left to clean up there.
        if (e.kind !== "delete") throw err;
      }
      return;
    }
    if (r.service === "dynamodb" && r.type === "table") {
      const op = e.kind === "create" ? "create-table" : e.kind === "delete" ? "delete-table" : "configure-table";
      try {
        await this.local.queueResource(r.accountId, { kind: "dynamodb", op, id: r.id, table: localSpec(r) });
      } catch (err) {
        if (e.kind !== "delete") throw err;
      }
      return;
    }
    if (r.service === "sqs" && r.type === "queue") {
      const op = e.kind === "create" ? "create-queue" : e.kind === "delete" ? "delete-queue" : "configure-queue";
      try {
        await this.local.queueResource(r.accountId, { kind: "sqs", op, id: r.id, queue: localSpec(r) });
      } catch (err) {
        if (e.kind !== "delete") throw err;
      }
      return;
    }
    if (r.service === "sns") {
      // Topics and subscriptions; confirming a subscription is an action, sent as its new settings and state.
      const op = `${e.kind === "create" ? "create" : e.kind === "delete" ? "delete" : "configure"}-${r.type}` as ResourceTask["op"];
      try {
        await this.local.queueResource(r.accountId, { kind: "sns", op, id: r.id, resource: localSpec(r) });
      } catch (err) {
        if (e.kind !== "delete") throw err;
      }
      return;
    }
    if (r.service === "compute" && r.type === "instance") {
      if (e.kind === "create") return this.send(r, "launch");
      if (e.kind === "action" && e.action) return this.send(r, e.action as ResourceTask["op"]);
      if (e.kind === "update") {
        const before = JSON.stringify(e.previous?.config.securityGroupIds ?? []);
        if (before !== JSON.stringify(r.config.securityGroupIds ?? []) && r.state !== "terminated") return this.send(r, "ports");
      }
      return;
    }
    // A security group's rules changed: its instances open or close ports.
    if (r.service === "networking" && r.type === "security-group" && e.kind === "update") {
      if (JSON.stringify(e.previous?.config.inboundRules ?? []) === JSON.stringify(r.config.inboundRules ?? [])) return;
      const instances = await this.engine.list(r.accountId, { service: "compute", type: "instance", region: r.region });
      for (const i of instances) {
        if (i.state === "terminated" || !((i.config.securityGroupIds as string[]) ?? []).includes(r.id)) continue;
        await this.send(i, "ports");
      }
    }
  }

  /** Runs a command on an instance (like SSM Run Command). The result arrives on the instance as lastCommand. */
  async exec(r: Resource, command: string, execId: string) {
    await this.local.queueResource(r.accountId, { kind: "ec2", op: "exec", id: r.id, command, execId });
  }
}

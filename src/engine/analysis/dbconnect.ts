import { z } from "zod";
import { parseCidr } from "../cidr";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import type { Resource } from "../types";
import { analyzeBetween, analyzeInbound, type ReachabilityResult, type ReachabilityStep } from "./reachability";

/**
 * "Can this connect to my database?" The same network checks as for an
 * instance (route tables, internet gateway, security groups and chaining), run
 * against the database's endpoint, plus what's special about RDS: the
 * database must be in a state that accepts connections, and it only has a
 * public address if it's publicly accessible. A passing check comes with the
 * command an app or a person would use to connect.
 */

export const dbConnectInput = z
  .object({
    /** "internet" (e.g. your laptop), or the ID of an instance in the database's VPC. */
    from: z.string().default("internet"),
    /** For "internet": the address range the connection comes from. */
    source: z.string().default("198.51.100.23/32"),
  })
  .superRefine((v, ctx) => {
    if (!parseCidr(v.source)) ctx.addIssue({ code: "custom", path: ["source"], message: "Enter an address range as a CIDR, e.g. 198.51.100.23/32." });
  });

export type DbConnectInput = z.input<typeof dbConnectInput>;

export interface DbConnectResult extends ReachabilityResult {
  endpoint: string;
  port: number;
  /** How to connect: psql or mysql, filled in for this database. */
  command: string;
}

/** States in which RDS accepts connections. */
const ACCEPTING = ["available", "modifying", "backing-up"];

export function connectCommand(db: Resource): string {
  const host = String(db.attributes.endpoint);
  const port = Number(db.attributes.port);
  const user = String(db.config.masterUsername);
  if (db.config.engine === "postgres") {
    return `psql "host=${host} port=${port} user=${user} dbname=${db.config.dbName || "postgres"}"`;
  }
  return `mysql -h ${host} -P ${port} -u ${user} -p${db.config.dbName ? ` ${db.config.dbName}` : ""}`;
}

export async function analyzeDbConnection(engine: Engine, accountId: string, db: Resource, raw: DbConnectInput): Promise<DbConnectResult> {
  const input = dbConnectInput.parse(raw);
  const port = Number(db.attributes.port);
  const endpoint = String(db.attributes.endpoint);

  // The database looks like a server in its subnet, with its security groups.
  const asServer: Resource = {
    ...db,
    id: db.name,
    state: ACCEPTING.includes(db.state ?? "") ? "running" : db.state,
    config: { subnetId: db.attributes.subnetId, securityGroupIds: db.config.vpcSecurityGroupIds },
  };
  const traffic = { direction: "inbound" as const, protocol: "tcp" as const, port, source: input.source, from: input.from };

  let result: ReachabilityResult;
  if (input.from === "internet") {
    result = await analyzeInbound(engine, accountId, asServer, traffic);
  } else {
    const source = await engine.get(accountId, input.from);
    if (source.type !== "instance") throw new EngineError("InvalidParameterValue", "Pick an instance as the source.");
    result = await analyzeBetween(engine, accountId, source, asServer, traffic);
  }

  const steps = result.steps.map((s): ReachabilityStep => {
    if (s.id === "state") return stateStep(db);
    if (s.id === "public-ip") return publicStep(db);
    if (s.id === "security-group") {
      return { ...s, title: s.title.replace(/^Target's security group|^Security group/, "Database's security group") };
    }
    if (s.id === "return-traffic") {
      return { ...s, detail: "Security groups are stateful, so the database's replies go back automatically. Network ACLs aren't simulated yet." };
    }
    return s;
  });
  const failures = steps.filter((s) => s.status === "fail").length;
  const who = input.from === "internet" ? `A connection from ${input.source}` : `${input.from}`;
  return {
    ...result,
    steps,
    reachable: failures === 0,
    target: `${endpoint}:${port}`,
    summary:
      failures === 0
        ? `${who} can reach ${db.name} on port ${port}.`
        : `${who} cannot reach ${db.name} on port ${port}. ${failures} problem${failures > 1 ? "s" : ""} to fix.`,
    endpoint,
    port,
    command: connectCommand(db),
  };
}

const dbLink = (db: Resource) => ({ id: db.id, service: "rds", type: "db-instance" });

function stateStep(db: Resource): ReachabilityStep {
  if (ACCEPTING.includes(db.state ?? "")) {
    return { id: "state", title: "Database accepts connections", status: "pass", detail: `${db.name} is ${db.state}.` };
  }
  return {
    id: "state",
    title: "Database accepts connections",
    status: "fail",
    detail: `${db.name} is ${db.state}. A database only accepts connections when it's available.`,
    fix: db.state === "stopped" ? "Start the database." : "Wait until it's available.",
    resource: dbLink(db),
  };
}

function publicStep(db: Resource): ReachabilityStep {
  if (db.config.publiclyAccessible && db.attributes.publicIp) {
    return {
      id: "public-ip",
      title: "Database is publicly accessible",
      status: "pass",
      detail: `From outside the VPC, ${db.attributes.endpoint} resolves to the public address ${db.attributes.publicIp}.`,
    };
  }
  return {
    id: "public-ip",
    title: "Database is publicly accessible",
    status: "fail",
    detail: `Publicly accessible is off, so ${db.attributes.endpoint} resolves to the private address ${db.attributes.privateIp}, which only works inside the VPC. This is the safe setting.`,
    fix: "Connect from a server in the same VPC instead (an app server, or a bastion host you SSH to). Only turn on Publicly accessible for a throwaway test database, and then allow just your own IP.",
    resource: dbLink(db),
  };
}

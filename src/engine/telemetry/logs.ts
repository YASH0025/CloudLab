import { randomBytes } from "node:crypto";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { check, rolePrincipal } from "../iam/authorize";
import { logGroupArn } from "../services/logs";
import type { ResourceStore } from "../store";
import type { Resource } from "../types";
import { compileFilter } from "./filter";
import type { LogEvent, LogStreamInfo } from "./types";

/**
 * CloudWatch Logs events: writing them (Lambda does, if its execution role
 * allows), reading a stream, searching a group with a filter pattern, and
 * dropping events older than the group's retention.
 */

export interface EventsPage {
  events: LogEvent[];
  /** Pass back to continue (newer events when reading oldest first). */
  nextToken?: string;
}

const DAY = 24 * 60 * 60_000;

export class Logs {
  constructor(
    private engine: Engine,
    private store: ResourceStore,
    private now: () => Date,
  ) {}

  async group(accountId: string, region: string, name: string): Promise<Resource> {
    const g = (await this.engine.list(accountId, { service: "logs", type: "log-group", region })).find((x) => x.name === name);
    if (!g) throw new EngineError("ResourceNotFoundException", "The specified log group does not exist.", 400);
    return g;
  }

  /** Drops events older than the group's retention (no background jobs: done when the group is read). */
  private async applyRetention(g: Resource) {
    const days = g.config.retentionInDays;
    if (!days || days === "never") return;
    await this.store.deleteLogEvents(g.accountId, g.region, g.name, this.now().getTime() - Number(days) * DAY);
  }

  async put(accountId: string, region: string, groupName: string, stream: string, events: { timestamp: number; message: string }[]) {
    await this.group(accountId, region, groupName);
    if (!/^[^:*]{1,512}$/.test(stream)) throw new EngineError("InvalidParameterException", "Invalid log stream name.");
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    await this.store.putLogEvents(accountId, region, groupName, stream, sorted.map((e) => ({ timestamp: e.timestamp, message: e.message.slice(0, 256 * 1024) })));
  }

  async streams(accountId: string, region: string, groupName: string): Promise<LogStreamInfo[]> {
    const g = await this.group(accountId, region, groupName);
    await this.applyRetention(g);
    return this.store.logStreams(accountId, region, groupName);
  }

  /** GetLogEvents for one stream, or the newest events of the whole group. */
  async events(
    accountId: string,
    region: string,
    groupName: string,
    q: { streams?: string[]; from?: number; to?: number; limit?: number; startFromHead?: boolean; nextToken?: string } = {},
  ): Promise<EventsPage> {
    const g = await this.group(accountId, region, groupName);
    await this.applyRetention(g);
    const limit = Math.min(Math.max(q.limit ?? 1000, 1), 10_000);
    const afterId = q.nextToken ? Number(q.nextToken.replace(/^[fb]\//, "")) : undefined;
    const ascending = q.startFromHead ?? true;
    const events = await this.store.queryLogEvents({ accountId, region, group: groupName, streams: q.streams, from: q.from, to: q.to, afterId, limit, ascending });
    const last = events.at(-1);
    return { events, nextToken: last && events.length === limit ? `${ascending ? "f" : "b"}/${last.id}` : undefined };
  }

  /** FilterLogEvents: events matching a pattern, oldest first. */
  async filter(
    accountId: string,
    region: string,
    groupName: string,
    q: { pattern?: string; streams?: string[]; from?: number; to?: number; limit?: number },
  ): Promise<LogEvent[]> {
    const match = compileFilter(q.pattern);
    const g = await this.group(accountId, region, groupName);
    await this.applyRetention(g);
    const all = await this.store.queryLogEvents({ accountId, region, group: groupName, streams: q.streams, from: q.from, to: q.to, limit: 2_000, ascending: true });
    return all.filter((e) => match(e.message)).slice(0, q.limit ?? 10_000);
  }

  /**
   * Writes a Lambda invocation's log, as the Lambda service does: into
   * /aws/lambda/<function>, a new stream per execution environment (cold
   * start). Only if the execution role allows it; otherwise the logs are
   * lost, which is how "my function has no logs" happens on AWS.
   */
  async fromLambda(fn: Resource, lines: string[], cold: boolean): Promise<{ written: boolean; stream?: string; reason?: string }> {
    const { accountId, region } = fn;
    const name = `/aws/lambda/${fn.name}`;
    const groupArn = logGroupArn(region, accountId, name);
    const now = this.now();
    let stream = fn.attributes.logStream as string | undefined;
    if (cold || !stream) {
      const d = now.toISOString().slice(0, 10).replace(/-/g, "/");
      stream = `${d}/[$LATEST]${randomBytes(16).toString("hex")}`;
    }

    const role = (await this.engine.list(accountId, { service: "iam", type: "role", region: "global" })).find((r) => r.name === fn.config.role);
    if (!role) return { written: false, reason: `The execution role ${String(fn.config.role)} no longer exists.` };
    const principal = await rolePrincipal(this.engine, accountId, role);
    const existing = (await this.engine.list(accountId, { service: "logs", type: "log-group", region })).find((g) => g.name === name);
    const missing = [
      ...(existing ? [] : [["logs:CreateLogGroup", groupArn]]),
      ["logs:CreateLogStream", `${groupArn}:log-stream:${stream}`],
      ["logs:PutLogEvents", `${groupArn}:log-stream:${stream}`],
    ].filter(([action, resource]) => check(principal, action, resource).decision !== "allowed");
    if (missing.length) {
      return {
        written: false,
        reason: `The execution role ${role.name} isn't allowed ${missing.map(([a]) => a).join(", ")}, so Lambda couldn't write this function's logs. Attach AWSLambdaBasicExecutionRole to the role.`,
      };
    }
    if (!existing) await this.engine.create(accountId, { service: "logs", type: "log-group", region, config: { name } });
    const base = now.getTime();
    await this.store.putLogEvents(
      accountId,
      region,
      name,
      stream,
      lines.map((message, i) => ({ timestamp: base + i, message })),
    );
    return { written: true, stream };
  }
}

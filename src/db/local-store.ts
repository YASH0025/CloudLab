import { and, asc, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { AgentRecord, AppRecord, LocalStore, TaskRecord } from "@/local/store";
import type { AgentInfo, AgentTask } from "@/local/types";
import { agents, agentTasks, localApps } from "./schema";

type AgentRow = typeof agents.$inferSelect;
type TaskRow = typeof agentTasks.$inferSelect;
type AppRow = typeof localApps.$inferSelect;

const toAgent = (r: AgentRow): AgentRecord => ({
  id: r.id,
  accountId: r.accountId,
  name: r.name,
  tokenHash: r.tokenHash,
  createdAt: r.createdAt.toISOString(),
  lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
  info: (r.info as AgentInfo | null) ?? null,
});

const toTask = (r: TaskRow): TaskRecord => ({
  id: r.id,
  agentId: r.agentId,
  accountId: r.accountId,
  type: r.type as TaskRecord["type"],
  payload: r.payload as AgentTask["payload"],
  status: r.status as TaskRecord["status"],
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toApp = (r: AppRow): AppRecord =>
  ({ ...(r.data as object), id: r.id, accountId: r.accountId, agentId: r.agentId }) as AppRecord;

/** Local mode on Postgres (Neon in production, PGlite in tests). */
export class PostgresLocalStore implements LocalStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private db: PgDatabase<any, any, any>) {}

  async agentForAccount(accountId: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.accountId, accountId)).limit(1);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async agentByTokenHash(hash: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.tokenHash, hash)).limit(1);
    return rows[0] ? toAgent(rows[0]) : null;
  }

  async putAgent(agent: AgentRecord) {
    const old = await this.db.select({ id: agents.id }).from(agents).where(eq(agents.accountId, agent.accountId));
    for (const o of old) await this.deleteAgent(o.id);
    await this.db.insert(agents).values({
      id: agent.id,
      accountId: agent.accountId,
      name: agent.name,
      tokenHash: agent.tokenHash,
      info: agent.info as Record<string, unknown> | null,
      createdAt: new Date(agent.createdAt),
      lastSeenAt: agent.lastSeenAt ? new Date(agent.lastSeenAt) : null,
    });
  }

  async touchAgent(id: string, info: AgentInfo, at: string) {
    await this.db
      .update(agents)
      .set({ info: info as unknown as Record<string, unknown>, lastSeenAt: new Date(at) })
      .where(eq(agents.id, id));
  }

  async deleteAgent(id: string) {
    await this.db.delete(agentTasks).where(eq(agentTasks.agentId, id));
    await this.db.delete(agents).where(eq(agents.id, id));
  }

  async addTask(task: TaskRecord) {
    await this.db.insert(agentTasks).values({
      id: task.id,
      agentId: task.agentId,
      accountId: task.accountId,
      type: task.type,
      payload: task.payload as Record<string, unknown>,
      status: task.status,
      error: task.error,
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt),
    });
  }

  async takeTasks(agentId: string) {
    // Claim with a conditional update, so two overlapping polls never get the same task.
    const rows = await this.db
      .update(agentTasks)
      .set({ status: "sent", updatedAt: new Date() })
      .where(and(eq(agentTasks.agentId, agentId), eq(agentTasks.status, "queued")))
      .returning();
    return rows.map(toTask).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async finishTask(agentId: string, id: string, status: "done" | "failed", error: string | null, at: string) {
    await this.db
      .update(agentTasks)
      .set({ status, error, updatedAt: new Date(at) })
      .where(and(eq(agentTasks.agentId, agentId), eq(agentTasks.id, id)));
  }

  async listApps(accountId: string) {
    const rows = await this.db.select().from(localApps).where(eq(localApps.accountId, accountId)).orderBy(desc(localApps.createdAt), asc(localApps.id));
    return rows.map(toApp);
  }

  async getApp(accountId: string, id: string) {
    const rows = await this.db
      .select()
      .from(localApps)
      .where(and(eq(localApps.accountId, accountId), eq(localApps.id, id)))
      .limit(1);
    return rows[0] ? toApp(rows[0]) : null;
  }

  async putApp(app: AppRecord) {
    const { id, accountId, agentId, ...data } = app;
    const values = {
      id,
      accountId,
      agentId,
      data: data as unknown as Record<string, unknown>,
      createdAt: new Date(app.createdAt),
      updatedAt: new Date(app.updatedAt),
    };
    await this.db
      .insert(localApps)
      .values(values)
      .onConflictDoUpdate({ target: localApps.id, set: { agentId, data: values.data, updatedAt: values.updatedAt } });
  }

  async deleteApp(accountId: string, id: string) {
    await this.db.delete(localApps).where(and(eq(localApps.accountId, accountId), eq(localApps.id, id)));
  }

  async reassignApps(accountId: string, agentId: string) {
    await this.db.update(localApps).set({ agentId }).where(eq(localApps.accountId, accountId));
  }

  async transferAccount(from: string, to: string) {
    if (await this.agentForAccount(to)) return;
    await this.db.update(agents).set({ accountId: to }).where(eq(agents.accountId, from));
    await this.db.update(agentTasks).set({ accountId: to }).where(eq(agentTasks.accountId, from));
    await this.db.update(localApps).set({ accountId: to }).where(eq(localApps.accountId, from));
  }
}

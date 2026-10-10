import type { AgentInfo, AgentTask, LocalApp, TaskType } from "./types";

export interface AgentRecord {
  id: string;
  accountId: string;
  name: string;
  /** SHA-256 of the agent's secret token; the token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  info: AgentInfo | null;
}

export interface TaskRecord extends AgentTask {
  agentId: string;
  accountId: string;
  status: "queued" | "sent" | "done" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppRecord extends LocalApp {
  accountId: string;
  agentId: string;
}

/** Persistence for Local mode: paired computers, their task queue and the apps they run. */
export interface LocalStore {
  agentForAccount(accountId: string): Promise<AgentRecord | null>;
  agentByTokenHash(hash: string): Promise<AgentRecord | null>;
  /** Replaces any agent the account had (one computer per account for now). */
  putAgent(agent: AgentRecord): Promise<void>;
  touchAgent(id: string, info: AgentInfo, at: string): Promise<void>;
  deleteAgent(id: string): Promise<void>;

  addTask(task: TaskRecord): Promise<void>;
  /** Hands queued tasks to the agent (oldest first) and marks them sent. */
  takeTasks(agentId: string): Promise<TaskRecord[]>;
  finishTask(agentId: string, id: string, status: "done" | "failed", error: string | null, at: string): Promise<void>;

  listApps(accountId: string): Promise<AppRecord[]>;
  getApp(accountId: string, id: string): Promise<AppRecord | null>;
  putApp(app: AppRecord): Promise<void>;
  deleteApp(accountId: string, id: string): Promise<void>;
  /** Points every app of the account at a newly paired agent. */
  reassignApps(accountId: string, agentId: string): Promise<void>;

  /** Moves an anonymous visitor's computer and apps into their account when they sign in. */
  transferAccount(from: string, to: string): Promise<void>;
}

export class MemoryLocalStore implements LocalStore {
  private agents = new Map<string, AgentRecord>();
  private tasks = new Map<string, TaskRecord>();
  private apps = new Map<string, AppRecord>();

  async agentForAccount(accountId: string) {
    return structuredClone([...this.agents.values()].find((a) => a.accountId === accountId) ?? null);
  }

  async agentByTokenHash(hash: string) {
    return structuredClone([...this.agents.values()].find((a) => a.tokenHash === hash) ?? null);
  }

  async putAgent(agent: AgentRecord) {
    for (const a of this.agents.values()) if (a.accountId === agent.accountId) await this.deleteAgent(a.id);
    this.agents.set(agent.id, structuredClone(agent));
  }

  async touchAgent(id: string, info: AgentInfo, at: string) {
    const a = this.agents.get(id);
    if (a) Object.assign(a, { info: structuredClone(info), lastSeenAt: at });
  }

  async deleteAgent(id: string) {
    this.agents.delete(id);
    for (const [tid, t] of this.tasks) if (t.agentId === id) this.tasks.delete(tid);
  }

  async addTask(task: TaskRecord) {
    this.tasks.set(task.id, structuredClone(task));
  }

  async takeTasks(agentId: string) {
    const queued = [...this.tasks.values()]
      .filter((t) => t.agentId === agentId && t.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const t of queued) t.status = "sent";
    return structuredClone(queued);
  }

  async finishTask(agentId: string, id: string, status: "done" | "failed", error: string | null, at: string) {
    const t = this.tasks.get(id);
    if (t && t.agentId === agentId) Object.assign(t, { status, error, updatedAt: at });
  }

  async listApps(accountId: string) {
    return structuredClone(
      [...this.apps.values()].filter((a) => a.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async getApp(accountId: string, id: string) {
    const a = this.apps.get(id);
    return a && a.accountId === accountId ? structuredClone(a) : null;
  }

  async putApp(app: AppRecord) {
    this.apps.set(app.id, structuredClone(app));
  }

  async deleteApp(accountId: string, id: string) {
    if (this.apps.get(id)?.accountId === accountId) this.apps.delete(id);
  }

  async reassignApps(accountId: string, agentId: string) {
    for (const a of this.apps.values()) if (a.accountId === accountId) a.agentId = agentId;
  }

  async transferAccount(from: string, to: string) {
    if (await this.agentForAccount(to)) return;
    for (const a of this.agents.values()) if (a.accountId === from) a.accountId = to;
    for (const t of this.tasks.values()) if (t.accountId === from) t.accountId = to;
    for (const a of this.apps.values()) if (a.accountId === from) a.accountId = to;
  }
}

export type { TaskType };

import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { EngineError } from "@/engine/errors";
import type { AgentRecord, AppRecord, LocalStore, TaskRecord } from "./store";
import {
  ONLINE_WINDOW_MS,
  type AgentTask,
  type AgentView,
  type AppAction,
  type AppReport,
  type DeployInput,
  type LocalApp,
  type LocalStatus,
  type SyncBody,
  type TaskType,
} from "./types";

/** Apps per account while Local mode is a preview. */
export const MAX_APPS = 5;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const noAgent = () =>
  new EngineError("AgentNotConnected", "No computer is connected. Click Connect my computer and run the command it shows.", 409);

const notFound = (id: string) => new EngineError("AppNotFound", `The app '${id}' does not exist.`, 404);

const publicApp = (a: AppRecord): LocalApp => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { accountId, agentId, ...app } = a;
  return app;
};

/**
 * Local mode's server side: pairing computers, queueing work for their agents,
 * and recording what the agents report back. The agent connects out to CloudLab
 * and polls; CloudLab never connects in to the learner's computer.
 */
export class LocalService {
  constructor(
    private store: LocalStore,
    private now: () => Date = () => new Date(),
  ) {}

  private iso() {
    return this.now().toISOString();
  }

  private view(agent: AgentRecord): AgentView {
    const seen = agent.lastSeenAt ? new Date(agent.lastSeenAt).getTime() : 0;
    return {
      id: agent.id,
      name: agent.name,
      online: this.now().getTime() - seen < ONLINE_WINDOW_MS,
      createdAt: agent.createdAt,
      lastSeenAt: agent.lastSeenAt,
      info: agent.info,
    };
  }

  // ---------- for the learner (console) ----------

  async status(accountId: string): Promise<LocalStatus> {
    const agent = await this.store.agentForAccount(accountId);
    const apps = await this.store.listApps(accountId);
    return { agent: agent ? this.view(agent) : null, apps: apps.map(publicApp) };
  }

  /**
   * Creates a pairing for the account's computer and returns its secret token, shown
   * once. Pairing again replaces the previous computer; existing apps move to it.
   */
  async pair(accountId: string): Promise<{ agent: AgentView; token: string }> {
    const token = `cla_${randomBytes(24).toString("base64url")}`;
    const agent: AgentRecord = {
      id: `agent-${nanoid(12)}`,
      accountId,
      name: "My computer",
      tokenHash: hashToken(token),
      createdAt: this.iso(),
      lastSeenAt: null,
      info: null,
    };
    await this.store.putAgent(agent);
    await this.store.reassignApps(accountId, agent.id);
    return { agent: this.view(agent), token };
  }

  async disconnect(accountId: string): Promise<void> {
    const agent = await this.store.agentForAccount(accountId);
    if (agent) await this.store.deleteAgent(agent.id);
  }

  private async queue(agent: AgentRecord, type: TaskType, payload: AgentTask["payload"]) {
    const at = this.iso();
    const task: TaskRecord = { id: `task-${nanoid(12)}`, agentId: agent.id, accountId: agent.accountId, type, payload, status: "queued", error: null, createdAt: at, updatedAt: at };
    await this.store.addTask(task);
  }

  async deploy(accountId: string, input: DeployInput): Promise<LocalApp> {
    const agent = await this.store.agentForAccount(accountId);
    if (!agent) throw noAgent();
    const apps = await this.store.listApps(accountId);
    if (apps.some((a) => a.name === input.name)) {
      throw new EngineError("AppAlreadyExists", `You already have an app called '${input.name}'. Pick another name or redeploy that one.`, 409);
    }
    if (apps.length >= MAX_APPS) {
      throw new EngineError("AppLimitExceeded", `Local mode allows ${MAX_APPS} apps for now. Delete one first.`, 400);
    }
    if (input.hostPort && apps.some((a) => a.hostPort === input.hostPort)) {
      throw new EngineError("PortInUse", `Port ${input.hostPort} is already used by another of your apps.`, 409);
    }
    const at = this.iso();
    const source = input.source.type === "github" && !input.source.branch ? { type: "github" as const, repo: input.source.repo } : input.source;
    const app: AppRecord = {
      id: `app-${nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "x")}`,
      accountId,
      agentId: agent.id,
      name: input.name,
      source,
      status: "queued",
      detail: this.view(agent).online ? "Waiting for your computer to pick it up…" : "Queued. It starts when your computer's agent is running.",
      runtime: null,
      hostPort: input.hostPort ?? null,
      containerPort: null,
      url: null,
      buildLog: "",
      logs: "",
      createdAt: at,
      updatedAt: at,
    };
    await this.store.putApp(app);
    await this.queue(agent, "deploy", { appId: app.id, name: app.name, source, hostPort: input.hostPort });
    return publicApp(app);
  }

  async action(accountId: string, appId: string, action: AppAction): Promise<LocalApp | null> {
    const app = await this.store.getApp(accountId, appId);
    if (!app) throw notFound(appId);
    const agent = await this.store.agentForAccount(accountId);
    if (action === "delete") {
      // Remove the record now; the container is cleaned up when the agent next checks in.
      if (agent) await this.queue(agent, "remove", { appId });
      await this.store.deleteApp(accountId, appId);
      return null;
    }
    if (!agent) throw noAgent();
    const type: TaskType = action === "redeploy" ? "deploy" : action;
    const payload: AgentTask["payload"] =
      action === "redeploy" ? { appId, name: app.name, source: app.source, hostPort: app.hostPort ?? undefined } : { appId };
    await this.queue(agent, type, payload);
    const pending = { start: "Starting…", stop: "Stopping…", restart: "Restarting…", redeploy: "Waiting for your computer to pick it up…" }[action];
    const updated: AppRecord = { ...app, detail: pending, ...(action === "redeploy" ? { status: "queued" as const } : {}), updatedAt: this.iso() };
    await this.store.putApp(updated);
    return publicApp(updated);
  }

  // ---------- for the agent ----------

  /** The agent for a bearer token, or a 401. */
  async authenticate(authorization: string | null): Promise<AgentRecord> {
    const token = /^Bearer (cla_[\w-]{20,})$/.exec(authorization ?? "")?.[1];
    const agent = token ? await this.store.agentByTokenHash(hashToken(token)) : null;
    if (!agent) {
      throw new EngineError(
        "AgentUnauthorized",
        "This computer isn't connected to a CloudLab account (or was disconnected). Run the connect command from CloudLab again.",
        401,
      );
    }
    return agent;
  }

  /** The agent's regular check-in: what the computer looks like and what it's running. Returns new work. */
  async sync(agent: AgentRecord, body: SyncBody): Promise<AgentTask[]> {
    const at = this.iso();
    await this.store.touchAgent(agent.id, body.info, at);
    const reported = new Map(body.apps.map((a) => [a.id, a]));
    for (const app of await this.store.listApps(agent.accountId)) {
      const r = reported.get(app.id);
      if (r) await this.apply(app, r, at);
      else if (body.complete && (app.status === "running" || app.status === "stopped")) {
        await this.apply(app, { status: "missing", detail: "The app's container isn't on your computer any more. Redeploy it to bring it back." }, at);
      }
    }
    const tasks = await this.store.takeTasks(agent.id);
    return tasks.map(({ id, type, payload }) => ({ id, type, payload }));
  }

  /** Progress from the agent while it works on one app (downloading, building, starting…). */
  async report(agent: AgentRecord, appId: string, r: AppReport): Promise<void> {
    const app = await this.store.getApp(agent.accountId, appId);
    // The app may have been deleted while the agent was building it.
    if (app) await this.apply(app, r, this.iso());
  }

  async finishTask(agent: AgentRecord, taskId: string, status: "done" | "failed", error?: string): Promise<void> {
    await this.store.finishTask(agent.id, taskId, status, error ?? null, this.iso());
  }

  private async apply(app: AppRecord, r: AppReport, at: string) {
    const next: AppRecord = { ...app, updatedAt: at };
    if (r.status) next.status = r.status;
    if (r.detail !== undefined) next.detail = r.detail;
    if (r.runtime !== undefined) next.runtime = r.runtime;
    if (r.hostPort !== undefined) next.hostPort = r.hostPort;
    if (r.containerPort !== undefined) next.containerPort = r.containerPort;
    if (r.buildLog !== undefined) next.buildLog = r.buildLog.slice(-20_000);
    if (r.logs !== undefined) next.logs = r.logs.slice(-20_000);
    next.url = next.hostPort && next.status === "running" ? `http://localhost:${next.hostPort}` : null;
    const changed = JSON.stringify({ ...next, updatedAt: "" }) !== JSON.stringify({ ...app, updatedAt: "" });
    if (changed) await this.store.putApp(next);
  }
}

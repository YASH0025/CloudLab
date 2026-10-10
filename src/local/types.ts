import { z } from "zod";

/**
 * Local mode: real apps on the learner's own computer. CloudLab's website is the
 * remote control; a small agent the learner runs on their computer does the work
 * with Docker. These shapes are shared by the server, the console and the agent
 * protocol. Safe to import in the browser.
 */

/** Built-in sample apps the agent carries with it, so a first deploy needs nothing else. */
export const SAMPLES = [
  {
    id: "node-express",
    label: "Node.js + Express",
    description: "A small web server. The agent runs npm install, so you see dependencies installed for real.",
  },
  {
    id: "python-flask",
    label: "Python + Flask",
    description: "The same idea in Python: pip installs Flask, then the app starts.",
  },
  {
    id: "static-site",
    label: "Static website (nginx)",
    description: "Plain HTML served by nginx. The quickest one to try.",
  },
] as const;

export type SampleId = (typeof SAMPLES)[number]["id"];

export const appNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Use 1–31 lowercase letters, numbers and hyphens, starting with a letter or number.");

/** Public GitHub repositories only, as https://github.com/owner/repo. */
export const githubRepoSchema = z
  .string()
  .trim()
  .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/, "Use a public GitHub repository URL like https://github.com/owner/repo.");

export const deployInput = z.object({
  name: appNameSchema,
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("sample"), sample: z.enum(SAMPLES.map((s) => s.id) as [SampleId, ...SampleId[]]) }),
    z.object({
      type: z.literal("github"),
      repo: githubRepoSchema,
      branch: z
        .string()
        .trim()
        .regex(/^[\w./-]{1,100}$/, "Branch names may use letters, numbers, dots, slashes, hyphens and underscores.")
        .optional()
        .or(z.literal("")),
    }),
  ]),
  /** Port on the learner's computer (http://localhost:<port>). Picked automatically when empty. */
  hostPort: z.coerce.number().int().min(1024).max(65535).optional(),
});

export type DeployInput = z.infer<typeof deployInput>;
export type AppSource = DeployInput["source"];

export const APP_ACTIONS = ["start", "stop", "restart", "redeploy", "delete"] as const;
export type AppAction = (typeof APP_ACTIONS)[number];

export type AppStatus =
  | "queued"
  | "downloading"
  | "building"
  | "starting"
  | "running"
  | "stopped"
  | "failed"
  | "missing";

export interface AgentInfo {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  cpus: number;
  cpuModel: string;
  memTotal: number;
  memFree: number;
  docker: { ok: boolean; version?: string; error?: string };
  agentVersion: string;
}

export interface AgentView {
  id: string;
  name: string;
  online: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  info: AgentInfo | null;
}

export interface LocalApp {
  id: string;
  name: string;
  source: AppSource;
  status: AppStatus;
  /** One line about what's happening, e.g. "Installing dependencies…" or the failure reason. */
  detail: string;
  runtime: string | null;
  hostPort: number | null;
  containerPort: number | null;
  url: string | null;
  /** Last lines of the build output. */
  buildLog: string;
  /** Last lines of the running app's output. */
  logs: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalStatus {
  agent: AgentView | null;
  apps: LocalApp[];
}

// ---------- agent protocol ----------

export const TASK_TYPES = ["deploy", "start", "stop", "restart", "remove"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface AgentTask {
  id: string;
  type: TaskType;
  payload: { appId: string; name?: string; source?: AppSource; hostPort?: number };
}

const report = z.object({
  status: z.enum(["queued", "downloading", "building", "starting", "running", "stopped", "failed", "missing"]).optional(),
  detail: z.string().max(500).optional(),
  runtime: z.string().max(50).nullable().optional(),
  hostPort: z.number().int().min(1).max(65535).nullable().optional(),
  containerPort: z.number().int().min(1).max(65535).nullable().optional(),
  buildLog: z.string().max(40_000).optional(),
  logs: z.string().max(40_000).optional(),
});

export const appReport = report;
export type AppReport = z.infer<typeof report>;

export const syncBody = z.object({
  info: z.object({
    hostname: z.string().max(200),
    platform: z.string().max(50),
    release: z.string().max(100),
    arch: z.string().max(50),
    cpus: z.number().int().min(0).max(4096),
    cpuModel: z.string().max(200),
    memTotal: z.number().min(0),
    memFree: z.number().min(0),
    docker: z.object({ ok: z.boolean(), version: z.string().max(100).optional(), error: z.string().max(500).optional() }),
    agentVersion: z.string().max(20),
  }),
  /** Every CloudLab app container the agent found, with its state. Apps being deployed are left out. */
  apps: z.array(report.extend({ id: z.string().max(64) })).max(50),
  /** True when `apps` is the complete inventory, so apps missing from it can be marked missing. */
  complete: z.boolean().default(false),
});

export type SyncBody = z.infer<typeof syncBody>;

export const taskResult = z.object({ status: z.enum(["done", "failed"]), error: z.string().max(1000).optional() });

/** The agent counts as online if it checked in within this many milliseconds. */
export const ONLINE_WINDOW_MS = 20_000;

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

/**
 * A project folder inside the CloudLab folder on the learner's computer (~/CloudLab/<name>).
 * Only a folder name, never a path: the agent offers nothing outside that folder.
 */
export const folderNameSchema = z
  .string()
  .trim()
  .regex(/^[\w][\w .-]{0,63}$/, "Pick one of the folders inside the CloudLab folder on your computer.")
  .refine((v) => !v.includes(".."), "Pick one of the folders inside the CloudLab folder on your computer.");

/**
 * A name for an app on the learner's home network, like myshop.home. The agent's
 * DNS server answers it with the computer's address, for devices that use it.
 */
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253, "Domain names are at most 253 characters.")
  .regex(
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    "Use a name like myshop.home: letters, numbers and hyphens, with at least one dot.",
  )
  .refine((d) => !d.endsWith(".local"), "Names ending in .local are taken by your devices' own discovery (mDNS). Use .home or .lan instead.");

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
    z.object({ type: z.literal("folder"), folder: folderNameSchema }),
  ]),
  /** Optional name on the home network, e.g. myshop.home. */
  domain: domainSchema.optional().or(z.literal("").transform(() => undefined)),
  /** Port on the learner's computer (http://localhost:<port>). Picked automatically when empty. */
  hostPort: z.coerce.number().int().min(1024).max(65535).optional(),
  /** Docker, straight on the computer, or whichever is available (Docker first). */
  mode: z.enum(["auto", "docker", "native"]).default("auto"),
});

/** What a deploy asks for. `mode` may be left out, meaning auto. */
export type DeployInput = Omit<z.infer<typeof deployInput>, "mode"> & { mode?: RunMode };
export type RunMode = "auto" | "docker" | "native";
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
  /** The computer's address on its home network, which other devices use. */
  lanIp?: string | null;
  /** The agent's DNS server and web gateway for app domains, when any app has one. */
  gateway?: { running: boolean; dns: boolean; httpPort: number | null; error?: string | null } | null;
  /** Where the CloudLab folder is on the computer, and the project folders in it. */
  workspace?: string;
  folders?: string[];
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
  /** Name on the home network (myshop.home), served by the agent's gateway. */
  domain?: string | null;
  /** How it was asked to run: auto (Docker if available), docker, or native (without Docker). */
  mode?: RunMode;
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
  payload: { appId: string; name?: string; source?: AppSource; hostPort?: number; mode?: RunMode };
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
    workspace: z.string().max(500).optional(),
    lanIp: z.string().max(64).nullable().optional(),
    gateway: z
      .object({ running: z.boolean(), dns: z.boolean(), httpPort: z.number().int().nullable(), error: z.string().max(500).nullable().optional() })
      .nullable()
      .optional(),
    folders: z.array(z.string().max(64)).max(100).optional(),
  }),
  /** Every CloudLab app container the agent found, with its state. Apps being deployed are left out. */
  apps: z.array(report.extend({ id: z.string().max(64) })).max(50),
  /** True when `apps` is the complete inventory, so apps missing from it can be marked missing. */
  complete: z.boolean().default(false),
});

export type SyncBody = z.infer<typeof syncBody>;

/** What the agent's gateway should serve: each app's domain. */
export interface AgentRoute {
  appId: string;
  domain: string;
}

export const taskResult = z.object({ status: z.enum(["done", "failed"]), error: z.string().max(1000).optional() });

/** Where the agent downloads live (built by .github/workflows/agent.yml). */
export const AGENT_RELEASE = "https://github.com/YASH0025/CloudLab/releases/download/agent-latest";

export const AGENT_DOWNLOADS = [
  { os: "windows", label: "Windows", file: "cloudlab-agent-windows-x64.exe" },
  { os: "mac-arm", label: "macOS (Apple silicon)", file: "cloudlab-agent-darwin-arm64" },
  { os: "mac-intel", label: "macOS (Intel)", file: "cloudlab-agent-darwin-x64" },
  { os: "linux", label: "Linux (x64)", file: "cloudlab-agent-linux-x64" },
  { os: "linux-arm", label: "Linux (ARM)", file: "cloudlab-agent-linux-arm64" },
] as const;

/** The agent counts as online if it checked in within this many milliseconds. */
export const ONLINE_WINDOW_MS = 20_000;

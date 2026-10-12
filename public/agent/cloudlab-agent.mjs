#!/usr/bin/env node
/**
 * CloudLab agent: runs your Local mode apps on this computer with Docker.
 *
 *   node cloudlab-agent.mjs connect <token> [--server https://…]   connect this computer, then run
 *   node cloudlab-agent.mjs                                          run (after connecting once)
 *   node cloudlab-agent.mjs status                                   show what's running
 *   node cloudlab-agent.mjs disconnect                               forget the connection
 *
 * Your own projects: put a project folder inside the CloudLab folder in your home
 * folder (it's created for you) and pick it when you deploy from CloudLab.
 *
 * Names on your home network: give an app a domain (myshop.home) in CloudLab and
 * the agent runs a small gateway container: a DNS server that answers your
 * apps' names with this computer's address (and passes every other name on to
 * the internet's DNS), and a web proxy on port 80 that sends each name to its
 * app. Point another device's DNS at this computer and the names work there.
 *
 * How it works: every few seconds the agent tells CloudLab what this computer is
 * running and asks for work (deploy, start, stop, remove). CloudLab never
 * connects in to your computer. The agent only touches Docker containers and
 * images it created itself (labelled cloudlab.app), and its own folder ~/.cloudlab.
 *
 * Needs Node.js 20 or newer. Docker for apps that need it. No npm packages:
 * CloudLab's own service code (DynamoDB…) comes along in ./lib/core.mjs.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dynamodbApi, EngineError, explore, FileQueueHost, FileTableHost, QueueWaiters, queueConsole, sqsApi, sqsErrorNames } from "./lib/core.mjs";

export const AGENT_VERSION = "0.9.0";
const DEFAULT_SERVER = "https://cloud-lab-livid.vercel.app";
const HOME = path.join(os.homedir(), ".cloudlab");
const CONFIG = path.join(HOME, "agent.json");
const APPS_DIR = path.join(HOME, "apps");
/** Where learners put their own projects to deploy: ~/CloudLab/<project>. */
export const WORKSPACE = path.join(os.homedir(), "CloudLab");
const POLL_MS = 3000;
const LOGS_EVERY_MS = 15000;
const MAX_LOG = 20000;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const BRANCH = /^[\w./-]{1,100}$/;
const FOLDER = /^[\w][\w .-]{0,63}$/;

// ---------- small helpers ----------

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (text, n = MAX_LOG) => (text.length > n ? text.slice(-n) : text);

/** Runs a program without a shell (arguments are never interpreted), collecting its output. */
export function run(cmd, args, { cwd, onOutput, timeoutMs = 15 * 60_000, input, env, shell = false } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, shell, env: env ? { ...process.env, ...env } : process.env });
    } catch (e) {
      resolve({ code: -1, out: String(e.message ?? e) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const add = (d) => {
      out = tail(out + d.toString(), 200_000);
      onOutput?.(out);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.code === "ENOENT" ? `${cmd} isn't installed (or isn't on the PATH).` : String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const docker = (args, opts) => run("docker", args, opts);

// ---------- what this computer is ----------

const START_RETRY_MS = 3 * 60_000;
let dockerStartedAt = 0;

/** Where Docker Desktop is, to start it when it isn't running. */
export function dockerDesktopCommand(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    // Installed for everyone (Program Files) or just for this user (AppData).
    const roots = [env.ProgramFiles, env.ProgramW6432, "C:\\Program Files", env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")].filter(Boolean);
    for (const root of roots) {
      const exe = path.join(root, "Docker", "Docker", "Docker Desktop.exe");
      if (existsSync(exe)) return { cmd: exe, args: [] };
    }
    // Recent Docker Desktop versions can be started from the command line.
    return { cmd: "docker", args: ["desktop", "start", "--detach"] };
  }
  if (platform === "darwin") return { cmd: "open", args: ["-a", "Docker"] };
  // Docker Desktop for Linux runs as a user service; Docker Engine needs root, so it's left to the system.
  if (platform === "linux") return { cmd: "systemctl", args: ["--user", "start", "docker-desktop"] };
  return null;
}

let dockerGaveUp = false;

/**
 * Starts Docker Desktop in the background, once per run of the agent. True while it's
 * starting. If it isn't up within a few minutes (virtualization off, WSL broken…) the
 * agent stops trying, so Docker Desktop's error doesn't pop up again and again, and
 * apps run without Docker.
 */
function startDockerDesktop() {
  if (dockerGaveUp) return false;
  if (dockerStartedAt) {
    if (Date.now() - dockerStartedAt < START_RETRY_MS) return true;
    dockerGaveUp = true;
    log("Docker didn't start (Docker Desktop shows why). Apps will run without Docker.");
    return false;
  }
  const c = dockerDesktopCommand();
  if (!c) return false;
  try {
    const child = spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: true });
    // If the start command itself fails (no Docker Desktop to start), don't wait for it.
    child.on("error", () => (dockerGaveUp = true));
    child.on("exit", (code) => {
      if (code) dockerGaveUp = true;
    });
    child.unref();
    dockerStartedAt = Date.now();
    log("Docker isn't running: starting Docker Desktop. It takes a minute or two.");
    return true;
  } catch {
    return false;
  }
}

async function dockerInfo() {
  const r = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15000 });
  if (r.code === 0) {
    if (dockerStartedAt || dockerGaveUp) log("Docker is ready.");
    dockerStartedAt = 0;
    dockerGaveUp = false;
    return { ok: true, version: r.out.trim() };
  }
  if (/isn't installed/.test(r.out)) {
    return { ok: false, error: "Docker isn't installed, so apps run without Docker. Install Docker Desktop for the full Local mode (GitHub apps, your own Dockerfiles)." };
  }
  const starting = startDockerDesktop();
  const detail = tail(r.out.trim().split("\n").pop() ?? "", 200);
  return {
    ok: false,
    error: starting
      ? "Docker wasn't running, so the agent is starting Docker Desktop. Give it a minute or two."
      : dockerGaveUp
        ? "Docker Desktop didn't start (it says why: often virtualization is turned off). Apps run without Docker meanwhile."
        : `Docker is installed but not running. Start Docker Desktop (or the docker service) and wait until it's ready.${detail ? ` (Docker said: ${detail})` : ""}`,
  };
}

/** Whether Docker is up, without starting it. */
async function dockerInfoQuiet() {
  const r = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15000 });
  return r.code === 0 ? { ok: true, version: r.out.trim() } : { ok: false, error: "" };
}

/** Waits for Docker to be ready (after the agent started it), up to `ms`. */
async function waitForDocker(ms = 120_000) {
  const until = Date.now() + ms;
  let info = await dockerInfo();
  while (!info.ok && dockerStartedAt && !dockerGaveUp && Date.now() < until) {
    await sleep(5000);
    info = await dockerInfo();
  }
  return info;
}

export async function computerInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname().slice(0, 200),
    platform: os.platform(),
    release: os.release().slice(0, 100),
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: (cpus[0]?.model ?? "").trim().slice(0, 200),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    docker: await dockerInfo(),
    agentVersion: AGENT_VERSION,
    workspace: WORKSPACE,
    folders: projectFolders(),
  };
}

/** The project folders in ~/CloudLab, creating it (with a note) the first time. */
export function projectFolders(root = WORKSPACE) {
  try {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        path.join(root, "README.txt"),
        "Put each project you want to run with CloudLab in its own folder here, e.g. CloudLab/my-site.\n" +
          "Then open Local mode in CloudLab, choose 'A folder on my computer' and pick it.\n" +
          "A project needs a Dockerfile, or a package.json (Node.js), requirements.txt (Python) or index.html (static site) at its top.\n",
      );
    }
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && FOLDER.test(d.name) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort()
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** Copies a project out of ~/CloudLab to build it, leaving the original untouched (and skipping node_modules, .git). */
function copyProject(folder, dir, root = WORKSPACE) {
  if (!FOLDER.test(folder) || folder.includes("..")) throw new Error("Invalid folder name.");
  const src = path.join(root, folder);
  if (!existsSync(src) || !lstatSync(src).isDirectory()) throw new Error(`There's no folder ${folder} in ${root} any more.`);
  let size = 0;
  cpSync(src, dir, {
    recursive: true,
    dereference: false,
    filter: (from) => {
      const base = path.basename(from);
      if (base === "node_modules" || base === ".git" || base === "__pycache__" || base === ".venv") return false;
      try {
        // Links could point anywhere on the computer: they're left out.
        const st = lstatSync(from);
        if (st.isSymbolicLink()) return false;
        size += st.isFile() ? st.size : 0;
      } catch {
        return false;
      }
      if (size > MAX_DOWNLOAD_BYTES) throw new Error("The folder is over 200 MB (not counting node_modules and .git). Local mode keeps to smaller apps for now.");
      return true;
    },
  });
}

// ---------- talking to CloudLab ----------

class Api {
  constructor(server, token) {
    this.server = server.replace(/\/+$/, "");
    this.token = token;
  }

  async post(pathname, body, method = "POST") {
    const res = await fetch(this.server + pathname, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message ?? `CloudLab answered ${res.status}`);
      err.status = res.status;
      err.code = data?.error?.code;
      throw err;
    }
    return data;
  }

  sync(body) {
    return this.post("/api/agent/sync", body);
  }

  report(appId, r) {
    return this.post(`/api/agent/apps/${encodeURIComponent(appId)}/report`, r).catch((e) => log("Couldn't report progress:", e.message));
  }

  reportResource(id, r) {
    return this.post(`/api/agent/resources/${encodeURIComponent(id)}`, r).catch((e) => log("Couldn't report to CloudLab:", e.message));
  }

  finish(taskId, status, error) {
    return this.post(`/api/agent/tasks/${encodeURIComponent(taskId)}`, { status, ...(error ? { error: error.slice(0, 1000) } : {}) }).catch(() => undefined);
  }
}

// ---------- CloudLab's containers ----------

const NETWORK = "cloudlab";
const GATEWAY = "cloudlab-gateway";
let gatewayImage = null;
/** The gateway image is tagged with a hash of its code, so a new agent version rebuilds it. */
const GATEWAY_IMAGE = () => (gatewayImage ??= `cloudlab/gateway:${createHash("sha256").update(GATEWAY_JS).digest("hex").slice(0, 12)}`);
const GATEWAY_DIR = path.join(HOME, "gateway");
const containerName = (name) => `cloudlab-${name}`;
const imageName = (name) => `cloudlab/${name}:latest`;

/** Every container the agent made, from Docker's point of view. */
export async function inventory() {
  const r = await docker(["ps", "-a", "--filter", "label=cloudlab.app", "--format", "{{json .}}"], { timeoutMs: 20000 });
  if (r.code !== 0) return null;
  const out = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const c = JSON.parse(line);
      const labels = Object.fromEntries(
        String(c.Labels ?? "")
          .split(",")
          .map((kv) => kv.split("="))
          .filter((kv) => kv.length >= 2)
          .map(([k, ...v]) => [k, v.join("=")]),
      );
      if (!labels["cloudlab.app"]) continue;
      out.push({
        id: labels["cloudlab.app"],
        name: labels["cloudlab.name"] ?? "",
        container: c.Names,
        running: c.State === "running",
        state: c.State,
        exitCode: Number(/Exited \((\d+)\)/.exec(String(c.Status ?? ""))?.[1] ?? 0),
        hostPort: labels["cloudlab.port"] ? Number(labels["cloudlab.port"]) : null,
        containerPort: labels["cloudlab.containerPort"] ? Number(labels["cloudlab.containerPort"]) : null,
        runtime: labels["cloudlab.runtime"] ?? null,
      });
    } catch {
      // not one of ours, or Docker printed something unexpected
    }
  }
  return out;
}

async function containerFor(appId) {
  return (await inventory())?.find((c) => c.id === appId) ?? null;
}

async function containerLogs(container) {
  const r = await docker(["logs", "--tail", "200", container], { timeoutMs: 15000 });
  return tail(r.out);
}

// ---------- getting the code ----------

const SAMPLE_FILES = {
  "node-express": {
    "package.json": JSON.stringify({ name: "cloudlab-sample", version: "1.0.0", private: true, main: "server.js", scripts: { start: "node server.js" }, dependencies: { express: "^4.21.2" } }, null, 2) + "\n",
    "server.js": `const express = require("express");
const os = require("os");

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(\`<!doctype html><title>Hello from CloudLab</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
<h1>It works!</h1>
<p>This Node.js + Express app is running in a Docker container on <b>\${os.hostname()}</b>.</p>
<p>Edit <code>server.js</code>, redeploy, and refresh.</p>
</body>\`);
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 0.0.0.0, not localhost: inside a container, localhost is only reachable from the container itself.
app.listen(port, "0.0.0.0", () => console.log(\`Listening on port \${port}\`));
`,
  },
  "python-flask": {
    "requirements.txt": "flask>=3.0\n",
    "app.py": `import os
import socket

from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/")
def home():
    return f"""<!doctype html><title>Hello from CloudLab</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
<h1>It works!</h1>
<p>This Python + Flask app is running in a Docker container on <b>{socket.gethostname()}</b>.</p>
<p>Edit <code>app.py</code>, redeploy, and refresh.</p>
</body>"""


@app.get("/health")
def health():
    return jsonify(ok=True)


if __name__ == "__main__":
    # 0.0.0.0, not 127.0.0.1: inside a container, 127.0.0.1 is only reachable from the container itself.
    print(f"Listening on port {os.environ.get('PORT', 8000)}", flush=True)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
`,
  },
  "static-site": {
    "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello from CloudLab</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>It works!</h1>
    <p>This page is served by nginx, in a Docker container on your own computer.</p>
    <p>Edit <code>index.html</code>, redeploy, and refresh.</p>
  </main>
</body>
</html>
`,
    "style.css": "body { font-family: system-ui, sans-serif; background: #f5f7fb; color: #172033; }\nmain { max-width: 40rem; margin: 4rem auto; line-height: 1.6; }\nh1 { color: #1a73ff; }\n",
  },
};

function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** Downloads a public GitHub repository into `dir` (git if installed, else the tarball). */
async function fetchRepo(source, dir, progress) {
  const m = REPO.exec(source.repo);
  if (!m) throw new Error("That isn't a public GitHub repository URL.");
  if (source.branch && !BRANCH.test(source.branch)) throw new Error("That branch name isn't valid.");
  const [, owner, repo] = m;
  const url = `https://github.com/${owner}/${repo}.git`;

  const git = await run("git", ["--version"], { timeoutMs: 10000 });
  if (git.code === 0) {
    progress(`Cloning ${owner}/${repo}…`);
    const args = ["clone", "--depth", "1", ...(source.branch ? ["--branch", source.branch] : []), url, dir];
    const r = await run("git", args, { timeoutMs: 5 * 60_000, onOutput: (o) => progress(null, o) });
    if (r.code !== 0) {
      throw new Error(/not found|Repository not found|could not read Username/i.test(r.out) ? `GitHub has no public repository ${owner}/${repo}${source.branch ? ` with a branch ${source.branch}` : ""}.` : `git clone failed:\n${tail(r.out, 2000)}`);
    }
    return;
  }

  progress(`Downloading ${owner}/${repo}…`);
  const ref = source.branch ? `refs/heads/${source.branch}` : "HEAD";
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`);
  if (res.status === 404) throw new Error(`GitHub has no public repository ${owner}/${repo}${source.branch ? ` with a branch ${source.branch}` : ""}.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${owner}/${repo}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error("The repository is over 200 MB. Local mode keeps to smaller apps for now.");
  mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, "..", "source.tar.gz");
  writeFileSync(archive, buf);
  const r = await run("tar", ["-xzf", archive, "-C", dir, "--strip-components=1"]);
  rmSync(archive, { force: true });
  if (r.code !== 0) throw new Error(`Couldn't unpack the download:\n${tail(r.out, 1000)}`);
}

// ---------- how to run it ----------

/**
 * Works out how to build and run the code in `dir`: its own Dockerfile if it has one,
 * else a Dockerfile for Node.js (package.json), Python (requirements.txt) or a static
 * site (index.html). Returns null when it can't tell.
 */
export function detect(dir) {
  const has = (f) => existsSync(path.join(dir, f));
  if (has("Dockerfile")) {
    const text = readFileSync(path.join(dir, "Dockerfile"), "utf8");
    const port = /^\s*EXPOSE\s+(\d+)/im.exec(text)?.[1];
    return { runtime: "Dockerfile", containerPort: port ? Number(port) : 8080, dockerfile: null };
  }
  if (has("package.json")) {
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      // a broken package.json fails at npm install, with npm's own message
    }
    const start = pkg.scripts?.start ? ["npm", "start"] : ["node", pkg.main || "index.js"];
    const build = pkg.scripts?.build ? "RUN npm run build\n" : "";
    return {
      runtime: "Node.js 22",
      containerPort: 3000,
      dockerfile: `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
${build}ENV PORT=3000 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3000
CMD ${JSON.stringify(start)}
`,
    };
  }
  if (has("requirements.txt")) {
    const entry = ["app.py", "main.py", "server.py", "wsgi.py"].find(has) ?? "app.py";
    return {
      runtime: "Python 3.12",
      containerPort: 8000,
      dockerfile: `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8000 HOST=0.0.0.0 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", ${JSON.stringify(entry)}]
`,
    };
  }
  if (has("index.html")) {
    return { runtime: "nginx (static site)", containerPort: 80, dockerfile: "FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n" };
  }
  return null;
}

/** The first free port from `start`, on this computer. */
export function freePort(start = 8080, taken = []) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "0.0.0.0", () => s.close(() => resolve(true)));
    });
  return (async () => {
    for (let p = start; p < start + 200; p++) if (!taken.includes(p) && (await tryPort(p))) return p;
    throw new Error("Couldn't find a free port between 8080 and 8280.");
  })();
}

// ---------- names on the home network ----------

/** This computer's address on its home network: the first private IPv4 that isn't Docker's or a VPN's. */
export function lanAddress(interfaces = os.networkInterfaces()) {
  const skip = /^(docker|br-|veth|virbr|vEthernet|vmnet|vboxnet|utun|tun|tap|wg|zt|lo)/i;
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (skip.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      const rank = /^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      candidates.push({ rank, address: a.address });
    }
  }
  candidates.sort((x, y) => x.rank - y.rank);
  return candidates[0]?.address ?? null;
}

async function ensureNetwork() {
  const r = await docker(["network", "inspect", NETWORK]);
  if (r.code !== 0) await docker(["network", "create", NETWORK]);
}

/**
 * The gateway, which runs inside its own container. DNS on port 53: names of your
 * apps (and anything under them) get this computer's address; every other name is
 * passed to a public DNS server. HTTP on port 80: requests go to the app whose name
 * is in the Host header. Routes are re-read from /routes/routes.json every 2 seconds.
 */
export const GATEWAY_JS = String.raw`
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const net = require("net");

let config = { lanIp: null, routes: {} };
const load = () => {
  try { config = JSON.parse(fs.readFileSync(process.env.ROUTES_FILE || "/routes/routes.json", "utf8")); } catch {}
};
load();
setInterval(load, 2000);

const routeFor = (host) => {
  host = String(host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  for (const [domain, target] of Object.entries(config.routes)) {
    if (host === domain || host.endsWith("." + domain)) return { domain, target };
  }
  return null;
};

// ---- DNS ----
const UPSTREAMS = ["1.1.1.1", "8.8.8.8"];
function readName(buf, offset) {
  const labels = [];
  let jumped = false, end = offset, guard = 0;
  while (guard++ < 128) {
    const len = buf[offset];
    if (len === 0) { offset += 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = offset + 2; offset = ((len & 0x3f) << 8) | buf[offset + 1]; jumped = true; continue; }
    labels.push(buf.toString("ascii", offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return { name: labels.join(".").toLowerCase(), next: jumped ? end : offset };
}
function answer(query, qEnd, ip, withAnswer) {
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180 | (query.readUInt16BE(2) & 0x0100), 2); // response, authoritative-ish, recursion available
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(withAnswer ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = query.subarray(12, qEnd);
  if (!withAnswer) return Buffer.concat([header, question]);
  const rr = Buffer.alloc(16);
  rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(60, 6); rr.writeUInt16BE(4, 10);
  ip.split(".").forEach((p, i) => (rr[12 + i] = Number(p)));
  return Buffer.concat([header, question, rr]);
}
const dns = dgram.createSocket("udp4");
dns.on("message", (msg, rinfo) => {
  if (msg.length < 17) return;
  let q;
  try { q = readName(msg, 12); } catch { return; }
  const qtype = msg.readUInt16BE(q.next);
  const qEnd = q.next + 4;
  const route = routeFor(q.name);
  if (route && config.lanIp) {
    dns.send(answer(msg, qEnd, config.lanIp, qtype === 1 || qtype === 255), rinfo.port, rinfo.address);
    return;
  }
  // Everything else: ask a public DNS server and pass its answer back.
  const up = dgram.createSocket("udp4");
  let i = 0;
  const ask = () => up.send(msg, 53, UPSTREAMS[i]);
  const timer = setInterval(() => { if (++i >= UPSTREAMS.length) { clearInterval(timer); up.close(); } else ask(); }, 2000);
  up.on("message", (res) => { clearInterval(timer); dns.send(res, rinfo.port, rinfo.address); up.close(); });
  up.on("error", () => { clearInterval(timer); try { up.close(); } catch {} });
  ask();
});
let dnsUp = false;
dns.on("error", (e) => { console.error("DNS_FAILED " + (e.code || e.message)); try { dns.close(); } catch {} });
if (process.env.DNS !== "off") dns.bind({ port: 53, address: process.env.DNS_HOST || "0.0.0.0" }, () => { dnsUp = true; console.log("DNS on port 53"); });

// ---- HTTP ----
const page = (domains) =>
  '<!doctype html><title>CloudLab</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h1>No app has this name</h1><p>Names served by this computer:</p><ul>' +
  domains.map((d) => '<li><a href="http://' + d + '">' + d + "</a></li>").join("") +
  "</ul></body>";
const server = http.createServer((req, res) => {
  const route = routeFor(req.headers.host);
  if (!route) { res.writeHead(404, { "content-type": "text/html" }); res.end(page(Object.keys(config.routes))); return; }
  const [host, port] = route.target.split(":");
  const up = http.request({ host, port: Number(port), method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress, "x-forwarded-host": req.headers.host } }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end(route.domain + " isn't answering. Is the app running?\n"); });
  req.pipe(up);
  console.log(req.method, req.headers.host + req.url, "->", route.target);
});
server.on("upgrade", (req, socket, head) => {
  const route = routeFor(req.headers.host);
  if (!route) return socket.destroy();
  const [host, port] = route.target.split(":");
  const up = net.connect(Number(port), host, () => {
    const CRLF = String.fromCharCode(13, 10);
    up.write(req.method + " " + req.url + " HTTP/1.1" + CRLF + Object.entries(req.headers).map(([k, v]) => k + ": " + v).join(CRLF) + CRLF + CRLF);
    up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on("error", () => socket.destroy());
});
const httpPort = Number(process.env.HTTP_PORT || 80);
server.on("error", (e) => { console.error("HTTP_FAILED " + (e.code || e.message)); process.exit(3); });
server.listen(httpPort, () => {
  console.log("HTTP on port " + httpPort);
  // Give the DNS socket a moment, then say what's up (the agent reads this line).
  setTimeout(() => console.log("READY dns=" + dnsUp + " http=" + httpPort), 500);
});
`;

const GATEWAY_DOCKERFILE = `FROM node:22-alpine
COPY gateway.js /gateway/gateway.js
CMD ["node", "/gateway/gateway.js"]
`;

/**
 * Keeps the gateway in step with the app domains CloudLab sends: writes its routes,
 * starts it when the first domain appears and removes it (freeing ports 53 and 80)
 * when the last one goes. Remembers what it managed, for the computer's details.
 */
export class Gateway {
  constructor() {
    this.state = null;
    this.lastKey = null;
    this.retryAt = 0;
  }

  async update(routes, nativeTargets = {}) {
    const lanIp = lanAddress();
    const found = (await inventory()) ?? [];
    const table = {};
    for (const r of routes) {
      const c = found.find((x) => x.id === r.appId);
      if (c && c.containerPort) table[r.domain] = `${c.container}:${c.containerPort}`;
      // An app running without Docker is reached on this computer, from inside the gateway's container.
      else if (nativeTargets[r.appId]) table[r.domain] = nativeTargets[r.appId].replace("127.0.0.1", "host.docker.internal");
    }
    const key = JSON.stringify({ lanIp, table, names: routes.map((r) => r.domain) });
    mkdirSync(path.join(GATEWAY_DIR, "routes"), { recursive: true });
    writeFileSync(path.join(GATEWAY_DIR, "routes", "routes.json"), JSON.stringify({ lanIp, routes: table }, null, 2));

    if (routes.length === 0) {
      if (this.state) {
        await docker(["rm", "-f", GATEWAY]);
        log("No app has a domain any more: stopped the gateway.");
      }
      this.state = null;
      return;
    }
    // Containers made before the gateway existed join its network.
    await ensureNetwork();
    const routed = new Set(Object.values(table).map((t) => t.split(":")[0]));
    for (const container of routed) await docker(["network", "connect", NETWORK, container]); // fails harmlessly when already connected

    const running = (await docker(["inspect", "-f", "{{.State.Running}}", GATEWAY])).out.trim() === "true";
    if (running && this.state?.running && key === this.lastKey) return;
    if (running && this.state?.running) {
      this.lastKey = key;
      return; // routes are re-read by the gateway itself
    }
    if (Date.now() < this.retryAt) return;
    this.lastKey = key;
    this.state = await this.start(lanIp);
    if (!this.state.running) this.retryAt = Date.now() + 60_000;
  }

  async start(lanIp) {
    if (!lanIp) return { running: false, dns: false, httpPort: null, error: "This computer isn't on a network (no home network address found)." };
    // Build the gateway image once.
    if ((await docker(["image", "inspect", GATEWAY_IMAGE()])).code !== 0) {
      log("Building the gateway (once)…");
      const dir = path.join(GATEWAY_DIR, "image");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "gateway.js"), GATEWAY_JS);
      writeFileSync(path.join(dir, "Dockerfile"), GATEWAY_DOCKERFILE);
      const b = await docker(["build", "-t", GATEWAY_IMAGE(), dir]);
      if (b.code !== 0) return { running: false, dns: false, httpPort: null, error: `The gateway didn't build: ${tail(b.out, 300)}` };
    }
    const routesDir = path.join(GATEWAY_DIR, "routes");
    const attempts = [
      { dns: true, http: 80 },
      { dns: true, http: 8000 },
      { dns: false, http: 80 },
      { dns: false, http: 8000 },
    ];
    let lastError = "";
    for (const a of attempts) {
      await docker(["rm", "-f", GATEWAY]);
      const r = await docker([
        "run",
        "-d",
        "--name",
        GATEWAY,
        "--label",
        "cloudlab.gateway=1",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--network",
        NETWORK,
        "--restart",
        "unless-stopped",
        "--memory",
        "128m",
        "-v",
        `${routesDir}:/routes:ro`,
        ...(a.dns ? ["-p", `${lanIp}:53:53/udp`] : ["-e", "DNS=off"]),
        "-p",
        `${a.http}:80`,
        GATEWAY_IMAGE(),
      ]);
      if (r.code === 0) await sleep(1500);
      const up = r.code === 0 && (await docker(["inspect", "-f", "{{.State.Running}}", GATEWAY])).out.trim() === "true";
      if (r.code === 0 && !up) {
        const logs = await docker(["logs", "--tail", "20", GATEWAY]);
        await docker(["rm", "-f", GATEWAY]);
        return { running: false, dns: false, httpPort: null, error: `The gateway stopped right after starting: ${tail(logs.out, 300)}` };
      }
      if (up) {
        const notes = [];
        if (!a.dns) notes.push("Port 53 is already used by another program on this computer, so other devices can't use it for DNS (names only work where you add them to the hosts file).");
        if (a.http !== 80) notes.push(`Port 80 is busy, so the gateway uses ${a.http}: open http://<name>:${a.http}.`);
        log(`Gateway running: DNS ${a.dns ? `on ${lanIp}:53` : "off"}, web on port ${a.http}.`);
        return { running: true, dns: a.dns, httpPort: a.http, error: notes.join(" ") || null };
      }
      lastError = tail(r.out, 300);
    }
    await docker(["rm", "-f", GATEWAY]);
    return { running: false, dns: false, httpPort: null, error: `The gateway couldn't start: ${lastError}` };
  }
}

// ---------- without Docker ----------

const NATIVE_FILE = path.join(HOME, "native.json");
const IS_WINDOWS = process.platform === "win32";
/** The downloaded agent carries a JavaScript runtime (Bun) that can also install packages and run apps. */
const BUNDLED = typeof process.versions.bun === "string";

/** A JavaScript command: the agent's own runtime when it's the downloaded app, else Node.js and npm. */
export function jsCommand(kind, extra = [], bundled = BUNDLED) {
  if (bundled) {
    const args = kind === "install" ? ["install"] : kind === "script" ? ["run", "--bun", ...extra] : extra;
    return { cmd: process.execPath, args, env: { BUN_BE_BUN: "1" }, shell: false };
  }
  if (kind === "file") return { cmd: process.execPath, args: extra, env: {}, shell: false };
  // npm is a .cmd script on Windows, which Node can only start through a shell (the arguments are fixed, never user input).
  return { cmd: IS_WINDOWS ? "npm.cmd" : "npm", args: kind === "install" ? ["install"] : ["run", ...extra], env: {}, shell: IS_WINDOWS };
}

async function findPython() {
  for (const [cmd, args] of IS_WINDOWS ? [["python", []], ["py", ["-3"]], ["python3", []]] : [["python3", []], ["python", []]]) {
    const r = await run(cmd, [...args, "--version"], { timeoutMs: 10000 });
    if (r.code === 0 && /Python 3\./.test(r.out)) return { cmd, args };
  }
  return null;
}

/** Serves a folder's files, the way the nginx image would. Only files inside the folder. */
function staticServer(dir, port, onLog) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel;
      try {
        rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
      } catch {
        rel = "/";
      }
      let file = path.join(dir, path.normalize(rel).replace(/^([/\\])+/, ""));
      if (!file.startsWith(dir)) file = dir;
      try {
        if (lstatSync(file).isDirectory()) file = path.join(file, "index.html");
      } catch {
        // missing: 404 below
      }
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
        res.end(body);
        onLog(`${req.method} ${req.url} 200`);
      } catch {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<h1>404 Not Found</h1>");
        onLog(`${req.method} ${req.url} 404`);
      }
    });
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (IS_WINDOWS) {
    // taskkill also ends the app's own child processes (npm → node). Synchronous, so it works while the agent exits.
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Apps run straight on this computer, for when Docker isn't available: static sites
 * served by the agent itself, Node.js apps with the agent's own runtime, Python apps
 * with the computer's Python. They run as long as the agent does, and start again
 * with it. Remembered in ~/.cloudlab/native.json.
 */
export class NativeApps {
  constructor(file = NATIVE_FILE) {
    this.file = file;
    this.running = new Map();
    try {
      this.registry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.registry = {};
    }
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.registry, null, 2));
  }

  has(appId) {
    return !!this.registry[appId];
  }

  /** Sets an app up from its code in `dir` (install, build) and starts it. Returns the port. */
  async deploy(appId, name, plan, dir, hostPort, taken, progress) {
    await this.stop(appId);
    const port = hostPort ?? (await freePort(8080, taken));
    let start;
    if (plan.kind === "static") {
      start = { static: true };
    } else if (plan.kind === "node") {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
        progress("Installing dependencies…");
        const c = jsCommand("install");
        const r = await run(c.cmd, c.args, { cwd: dir, env: c.env, shell: c.shell, onOutput: (o) => progress(null, o) });
        if (r.code !== 0) throw new Error("Installing the dependencies failed. The build log says why.");
      }
      if (pkg.scripts?.build) {
        progress("Building…");
        const c = jsCommand("script", ["build"]);
        const r = await run(c.cmd, c.args, { cwd: dir, env: c.env, shell: c.shell, onOutput: (o) => progress(null, o) });
        if (r.code !== 0) throw new Error("npm run build failed. The build log says why.");
      }
      start = pkg.scripts?.start ? jsCommand("script", ["start"]) : jsCommand("file", [pkg.main || "index.js"]);
    } else if (plan.kind === "python") {
      const py = await findPython();
      if (!py) throw new Error("This is a Python app, and Python isn't installed on this computer. Install Python 3 (python.org), or use Docker.");
      progress("Creating a virtual environment…");
      let r = await run(py.cmd, [...py.args, "-m", "venv", ".venv"], { cwd: dir, onOutput: (o) => progress(null, o) });
      if (r.code !== 0) throw new Error("Couldn't create a Python virtual environment. The build log says why.");
      const venvPy = path.join(dir, ".venv", IS_WINDOWS ? "Scripts" : "bin", IS_WINDOWS ? "python.exe" : "python");
      progress("Installing requirements…");
      r = await run(venvPy, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: dir, onOutput: (o) => progress(null, o) });
      if (r.code !== 0) throw new Error("pip install failed. The build log says why.");
      start = { cmd: venvPy, args: [plan.entry], env: { PYTHONUNBUFFERED: "1" }, shell: false };
    } else {
      throw new Error("This project has its own Dockerfile, so it needs Docker to run.");
    }
    this.registry[appId] = { name, dir, port, runtime: plan.runtime, start, wanted: "running" };
    this.save();
    return port;
  }

  /** Starts a registered app. Resolves once it has had a moment to crash (or not). */
  async start(appId) {
    const app = this.registry[appId];
    if (!app) return false;
    await this.stop(appId, false);
    const entry = { logs: "", status: "running", exitCode: null, stopping: false };
    const add = (line) => (entry.logs = tail(entry.logs + line + (line.endsWith("\n") ? "" : "\n")));
    this.running.set(appId, entry);
    app.wanted = "running";
    this.save();
    if (app.start.static) {
      try {
        entry.server = await staticServer(app.dir, app.port, add);
        add(`Serving ${app.dir} on port ${app.port}`);
      } catch (e) {
        entry.status = "failed";
        add(e.code === "EADDRINUSE" ? `Port ${app.port} is already used by another program.` : String(e.message));
      }
      return entry.status === "running";
    }
    const { cmd, args, env, shell } = app.start;
    const child = spawn(cmd, args, {
      cwd: app.dir,
      env: { ...process.env, ...env, PORT: String(app.port), HOST: "0.0.0.0", NODE_ENV: "production" },
      shell,
      windowsHide: true,
      detached: !IS_WINDOWS,
    });
    entry.child = child;
    app.pid = child.pid ?? null;
    this.save();
    child.stdout.on("data", (d) => add(d.toString()));
    child.stderr.on("data", (d) => add(d.toString()));
    child.on("error", (e) => {
      entry.status = "failed";
      add(String(e.message));
    });
    child.on("exit", (code) => {
      entry.exitCode = code;
      entry.status = entry.stopping || code === 0 ? "stopped" : "failed";
    });
    await sleep(3000);
    return entry.status === "running";
  }

  async stop(appId, remember = true) {
    const entry = this.running.get(appId);
    if (entry) {
      entry.stopping = true;
      entry.status = "stopped";
      if (entry.server) await new Promise((r) => entry.server.close(() => r()));
      if (entry.child && entry.child.exitCode === null) killTree(entry.child);
    }
    if (remember && this.registry[appId]) {
      this.registry[appId].wanted = "stopped";
      this.save();
    }
  }

  async remove(appId) {
    await this.stop(appId, false);
    this.running.delete(appId);
    delete this.registry[appId];
    this.save();
    rmSync(path.join(APPS_DIR, appId), { recursive: true, force: true });
  }

  /** Ends every app the agent started (when the agent itself is closing). */
  stopAll() {
    for (const e of this.running.values()) {
      e.stopping = true;
      if (e.child && e.child.exitCode === null) killTree(e.child);
      e.server?.close();
    }
  }

  /** After the agent starts: clear out processes left from a previous run that ended abruptly, then bring back the apps that were running. */
  async restore() {
    for (const a of Object.values(this.registry)) {
      if (!a.pid) continue;
      try {
        process.kill(a.pid, 0);
        killTree({ pid: a.pid });
      } catch {
        // not running any more
      }
      a.pid = null;
    }
    this.save();
    await sleep(500);
    const wanted = Object.entries(this.registry).filter(([, a]) => a.wanted === "running");
    if (wanted.length) log(`Starting your apps again: ${wanted.map(([, a]) => a.name).join(", ")}`);
    for (const [id] of wanted) await this.start(id);
  }

  /** What CloudLab should show for each app. */
  report(withLogs) {
    return Object.entries(this.registry).map(([id, a]) => {
      const e = this.running.get(id);
      const status = e?.status ?? "stopped";
      return {
        id,
        status,
        detail:
          status === "running"
            ? `Running on port ${a.port}, without Docker.`
            : status === "failed"
              ? "The app stopped with an error. Its logs say why."
              : "Stopped. Start it again whenever you like.",
        hostPort: a.port,
        containerPort: null,
        runtime: a.runtime,
        ...(withLogs && e ? { logs: e.logs } : {}),
      };
    });
  }

  logs(appId) {
    return this.running.get(appId)?.logs ?? "";
  }

  ports() {
    return Object.values(this.registry).map((a) => a.port);
  }

  targets() {
    return Object.fromEntries(Object.entries(this.registry).map(([id, a]) => [id, `127.0.0.1:${a.port}`]));
  }
}

/** How to run a project without Docker, from what `detect` found. */
export function nativePlan(plan, dir) {
  if (!plan) return null;
  if (plan.runtime.startsWith("nginx")) return { kind: "static", runtime: "Static site (no Docker)" };
  if (plan.runtime.startsWith("Node")) return { kind: "node", runtime: "Node.js (no Docker)" };
  if (plan.runtime.startsWith("Python")) {
    const entry = ["app.py", "main.py", "server.py", "wsgi.py"].find((f) => existsSync(path.join(dir, f))) ?? "app.py";
    return { kind: "python", runtime: "Python (no Docker)", entry };
  }
  return { kind: "docker", runtime: plan.runtime };
}

/** The gateway as a plain process, for when Docker isn't there: same code, same routes file. */
export class NativeGateway {
  constructor() {
    this.state = null;
    this.child = null;
    this.retryAt = 0;
    // A gateway left running by an agent that ended abruptly would hold ports 53 and 80.
    try {
      const pid = Number(readFileSync(path.join(GATEWAY_DIR, "native", "pid"), "utf8"));
      if (pid) {
        process.kill(pid, 0);
        killTree({ pid });
      }
    } catch {
      // none left
    }
  }

  async update(routes, targets) {
    const lanIp = lanAddress();
    const table = {};
    for (const r of routes) if (targets[r.appId]) table[r.domain] = targets[r.appId];
    const dir = path.join(GATEWAY_DIR, "native");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "routes.json"), JSON.stringify({ lanIp, routes: table }, null, 2));
    if (routes.length === 0) {
      if (this.child) {
        killTree(this.child);
        this.child = null;
        log("No app has a domain any more: stopped the gateway.");
      }
      this.state = null;
      return;
    }
    if (this.child && this.child.exitCode === null) return;
    if (Date.now() < this.retryAt) return;
    writeFileSync(path.join(dir, "gateway.js"), GATEWAY_JS);
    for (const httpPort of [80, 8000]) {
      const r = await this.launch(dir, lanIp, httpPort);
      if (r) {
        this.state = r;
        return;
      }
    }
    this.state = { running: false, dns: false, httpPort: null, error: "The gateway couldn't start: ports 80 and 8000 are both in use." };
    this.retryAt = Date.now() + 60_000;
  }

  stop() {
    if (this.child) killTree(this.child);
    this.child = null;
  }

  launch(dir, lanIp, httpPort) {
    return new Promise((resolve) => {
      const c = jsCommand("file", [path.join(dir, "gateway.js")]);
      const child = spawn(c.cmd, c.args, {
        cwd: dir,
        env: { ...process.env, ...c.env, ROUTES_FILE: path.join(dir, "routes.json"), HTTP_PORT: String(httpPort), DNS_HOST: lanIp ?? "0.0.0.0" },
        windowsHide: true,
        detached: !IS_WINDOWS,
      });
      let out = "";
      const done = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(null), 8000);
      child.stdout.on("data", (d) => {
        out += d;
        const m = /READY dns=(true|false) http=(\d+)/.exec(out);
        if (!m) return;
        this.child = child;
        writeFileSync(path.join(dir, "pid"), String(child.pid ?? ""));
        const dns = m[1] === "true";
        const notes = [];
        if (!dns) notes.push("Port 53 is in use (or Windows asked to allow the agent through the firewall and it wasn't allowed), so other devices can't use this computer for DNS yet.");
        if (httpPort !== 80) notes.push(`Port 80 is busy, so the gateway uses ${httpPort}: open http://<name>:${httpPort}.`);
        log(`Gateway running without Docker: DNS ${dns ? `on ${lanIp}:53` : "off"}, web on port ${httpPort}.`);
        done({ running: true, dns, httpPort, error: notes.join(" ") || null });
      });
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", () => done(null));
      child.on("error", () => done(null));
    });
  }
}

// ---------- S3 on this computer ----------

/** Buckets are folders here, so you can see and change the files yourself. */
export const S3_ROOT = path.join(WORKSPACE, "s3");
const S3_META = path.join(HOME, "s3.json");
const MAX_OBJECT_BYTES = 5 * 1024 ** 3;
const WEBSITE_PORTS_FROM = 9100;

const S3_MIME = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", xml: "application/xml", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", pdf: "application/pdf",
  zip: "application/zip", woff2: "font/woff2", mp4: "video/mp4", mp3: "audio/mpeg",
};
const guessType = (key) => S3_MIME[key.toLowerCase().split(".").pop() ?? ""] ?? "binary/octet-stream";

export class S3Error extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const noSuchBucket = (b) => new S3Error("NoSuchBucket", `The specified bucket does not exist: ${b}`, 404);
const noSuchKey = () => new S3Error("NoSuchKey", "The specified key does not exist.", 404);

/**
 * CloudLab's own S3, on this computer. Each bucket is a folder under ~/CloudLab/s3,
 * each object a file (keys with slashes are subfolders). The bucket's settings come
 * from CloudLab; content types and ETags are remembered in ~/.cloudlab/s3.json.
 * Files added to the folder by hand are objects too.
 */
export class LocalS3 {
  constructor(root = S3_ROOT, metaFile = S3_META) {
    this.root = root;
    this.metaFile = metaFile;
    this.websites = new Map();
    try {
      this.meta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch {
      this.meta = {};
    }
    this.meta.buckets ??= {};
    this.meta.objects ??= {};
    this.meta.folders ??= {};
  }

  save() {
    mkdirSync(path.dirname(this.metaFile), { recursive: true });
    writeFileSync(this.metaFile, JSON.stringify(this.meta));
  }

  spec(bucket) {
    const s = this.meta.buckets[bucket];
    if (!s) throw noSuchBucket(bucket);
    return s;
  }

  dir(bucket) {
    this.spec(bucket);
    return path.join(this.root, bucket);
  }

  /** The file for a key. Keys that can't be a file inside the bucket's folder are refused. */
  file(bucket, key) {
    if (!key) throw new S3Error("InvalidArgument", "Object key must not be empty.", 400);
    if (Buffer.byteLength(key) > 1024) throw new S3Error("KeyTooLongError", "Your key is too long", 400);
    const parts = key.split("/");
    if (key.startsWith("/") || key.includes("\\") || key.includes("\0") || parts.some((p) => p === ".." || p === ".")) {
      throw new S3Error("InvalidArgument", "On your computer, keys can't contain '..', '.', backslashes or start with '/', since each key is a file path.", 400);
    }
    if (IS_WINDOWS && /[<>:"|?*]/.test(key)) {
      throw new S3Error("InvalidArgument", 'Windows can\'t store file names with < > : " | ? *, so these keys can\'t be used on this computer.', 400);
    }
    const dir = this.dir(bucket);
    const f = path.join(dir, ...parts.filter(Boolean));
    if (f !== dir && !f.startsWith(dir + path.sep)) throw new S3Error("InvalidArgument", "Invalid key.", 400);
    return f;
  }

  // ---- buckets (sent by CloudLab) ----

  createBucket(spec) {
    mkdirSync(path.join(this.root, spec.name), { recursive: true });
    this.meta.buckets[spec.name] = { ...this.meta.buckets[spec.name], ...spec };
    this.save();
  }

  configureBucket(spec) {
    if (!this.meta.buckets[spec.name]) return this.createBucket(spec);
    this.meta.buckets[spec.name] = { ...this.meta.buckets[spec.name], ...spec };
    this.save();
  }

  /** CloudLab only deletes empty buckets; a folder that still has files (added by hand) is kept. */
  deleteBucket(name) {
    const dir = path.join(this.root, name);
    let kept = false;
    try {
      rmdirSync(dir);
    } catch {
      kept = existsSync(dir) && this.walk(name).length > 0;
      if (!kept) rmSync(dir, { recursive: true, force: true });
    }
    delete this.meta.buckets[name];
    delete this.meta.objects[name];
    delete this.meta.folders[name];
    this.save();
    this.stopWebsite(name);
    return kept;
  }

  // ---- objects ----

  /** Every object: files, and folders created as objects (keys ending in "/"). */
  walk(bucket) {
    const dir = this.dir(bucket);
    const out = [];
    const visit = (d, prefix) => {
      let entries = [];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const key = prefix + e.name;
        if (e.isDirectory()) {
          if ((this.meta.folders[bucket] ?? []).includes(`${key}/`)) out.push({ key: `${key}/`, folder: true });
          visit(path.join(d, e.name), `${key}/`);
        } else if (e.isFile()) out.push({ key });
      }
    };
    visit(dir, "");
    return out;
  }

  info(bucket, key) {
    if (key.endsWith("/")) {
      return { key, size: 0, etag: "d41d8cd98f00b204e9800998ecf8427e", contentType: "application/x-directory", lastModified: new Date(lstatSync(this.file(bucket, key.slice(0, -1))).mtimeMs).toISOString() };
    }
    const f = this.file(bucket, key);
    let st;
    try {
      st = lstatSync(f);
    } catch {
      throw noSuchKey();
    }
    if (!st.isFile()) throw noSuchKey();
    const m = (this.meta.objects[bucket] ??= {})[key];
    let etag = m && m.size === st.size && m.mtime === st.mtimeMs ? m.etag : null;
    if (!etag) {
      // A file changed or added outside CloudLab: work its ETag out again.
      etag = createHash("md5").update(readFileSync(f)).digest("hex");
      this.meta.objects[bucket][key] = { ...m, etag, size: st.size, mtime: st.mtimeMs };
      this.dirty = true;
    }
    return { key, size: st.size, etag, contentType: m?.contentType ?? guessType(key), lastModified: new Date(st.mtimeMs).toISOString() };
  }

  list(bucket, prefix = "", delimiter = "") {
    const objects = [];
    const prefixes = new Set();
    for (const o of this.walk(bucket).sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (!o.key.startsWith(prefix)) continue;
      const rest = o.key.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (cut >= 0 && cut < rest.length - delimiter.length) prefixes.add(prefix + rest.slice(0, cut + delimiter.length));
      else if (cut >= 0 && o.folder) prefixes.add(o.key);
      else if (rest) objects.push(this.info(bucket, o.key));
    }
    if (this.dirty) {
      this.dirty = false;
      this.save();
    }
    return { objects, prefixes: [...prefixes].sort() };
  }

  /** Writes an object from a stream (an HTTP request), checking its size and working out its ETag on the way. */
  /** User metadata (x-amz-meta-*) of an object. */
  metadata(bucket, key) {
    return this.meta.objects[bucket]?.[key]?.metadata ?? {};
  }

  setEtag(bucket, key, etag) {
    const m = this.meta.objects[bucket]?.[key];
    if (m) {
      m.etag = etag;
      this.save();
    }
  }

  async put(bucket, key, stream, contentType, metadata) {
    if (key.endsWith("/")) {
      mkdirSync(this.file(bucket, key.slice(0, -1)), { recursive: true });
      const folders = (this.meta.folders[bucket] ??= []);
      if (!folders.includes(key)) folders.push(key);
      this.save();
      return this.info(bucket, key);
    }
    const f = this.file(bucket, key);
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.cloudlab-upload`;
    const hash = createHash("md5");
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = createWriteStream(tmp);
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_OBJECT_BYTES) {
          stream.destroy();
          out.destroy();
          reject(new S3Error("EntityTooLarge", "Your proposed upload exceeds the maximum allowed size", 400));
          return;
        }
        hash.update(chunk);
        out.write(chunk);
      });
      stream.on("end", () => out.end(resolve));
      stream.on("error", reject);
      out.on("error", reject);
    }).catch((e) => {
      rmSync(tmp, { force: true });
      throw e;
    });
    renameSync(tmp, f);
    const st = lstatSync(f);
    (this.meta.objects[bucket] ??= {})[key] = {
      etag: hash.digest("hex"),
      size: st.size,
      mtime: st.mtimeMs,
      contentType: contentType || guessType(key),
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    };
    this.save();
    return this.info(bucket, key);
  }

  delete(bucket, key) {
    if (key.endsWith("/")) {
      this.meta.folders[bucket] = (this.meta.folders[bucket] ?? []).filter((k) => k !== key);
      try {
        rmdirSync(this.file(bucket, key.slice(0, -1)));
      } catch {
        // not empty: other objects still live under it
      }
    } else {
      rmSync(this.file(bucket, key), { force: true });
      delete (this.meta.objects[bucket] ?? {})[key];
      this.prune(bucket, key);
    }
    this.save();
  }

  /** Folders exist only while something is in them, unless they were created as folders. */
  prune(bucket, key) {
    const folders = this.meta.folders[bucket] ?? [];
    const parts = key.split("/").slice(0, -1);
    while (parts.length) {
      const k = `${parts.join("/")}/`;
      if (folders.includes(k)) break;
      try {
        rmdirSync(this.file(bucket, parts.join("/")));
      } catch {
        break;
      }
      parts.pop();
    }
  }

  deletePrefix(bucket, prefix) {
    const keys = this.walk(bucket).map((o) => o.key).filter((k) => k.startsWith(prefix));
    for (const k of keys.filter((x) => !x.endsWith("/"))) this.delete(bucket, k);
    for (const k of keys.filter((x) => x.endsWith("/")).sort((a, b) => b.length - a.length)) this.delete(bucket, k);
    return keys;
  }

  stats(bucket) {
    let objectCount = 0;
    let totalBytes = 0;
    for (const o of this.walk(bucket)) {
      objectCount++;
      if (!o.folder) totalBytes += lstatSync(this.file(bucket, o.key)).size;
    }
    return { objectCount, totalBytes };
  }

  // ---- static website hosting ----

  /** Answers a website request the way S3 website endpoints do (index documents, the error document, 403 when not public). */
  website(bucket, urlPath) {
    const s = this.meta.buckets[bucket];
    const page = (status, code, message) => ({
      status,
      contentType: "text/html",
      body: Buffer.from(`<html><head><title>${status} ${status === 403 ? "Forbidden" : "Not Found"}</title></head><body><h1>${status} ${status === 403 ? "Forbidden" : "Not Found"}</h1><ul><li>Code: ${code}</li><li>Message: ${message}</li></ul><hr/></body></html>`),
    });
    if (!s) return page(404, "NoSuchBucket", "The specified bucket does not exist");
    if (!s.websiteEnabled) return page(404, "NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration");
    if (s.blockPublicAccess || !s.publicRead) return page(403, "AccessDenied", "Access Denied");
    const index = s.indexDocument || "index.html";
    const load = (key) => {
      try {
        const i = this.info(bucket, key);
        return { status: 200, contentType: i.contentType, body: readFileSync(this.file(bucket, key)) };
      } catch {
        return null;
      }
    };
    let p;
    try {
      p = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
    } catch {
      p = "";
    }
    const key = p === "" || p.endsWith("/") ? p + index : p;
    const found = load(key);
    if (found) return found;
    if (p && !p.endsWith("/") && load(`${p}/${index}`)) return { status: 302, contentType: "text/plain", body: Buffer.from(""), location: `/${p}/` };
    const custom = s.errorDocument ? load(s.errorDocument) : null;
    if (custom) return { ...custom, status: 404 };
    return page(404, "NoSuchKey", "The specified key does not exist.");
  }

  /** Each website bucket gets its own port, so the site works at http://<this computer>:<port>/ with its own paths. */
  async ensureWebsite(bucket) {
    const s = this.meta.buckets[bucket];
    if (!s?.websiteEnabled) return this.stopWebsite(bucket);
    if (this.websites.has(bucket)) return this.websites.get(bucket).port;
    const used = new Set(Object.values(this.meta.buckets).map((b) => b.websitePort).filter(Boolean));
    let port = s.websitePort;
    if (!port) {
      port = WEBSITE_PORTS_FROM;
      while (used.has(port)) port++;
    }
    const server = http.createServer((req, res) => {
      const r = this.website(bucket, req.url ?? "/");
      res.writeHead(r.status, { "content-type": r.contentType, server: "CloudLab S3", ...(r.location ? { location: r.location } : {}) });
      res.end(r.body);
    });
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "0.0.0.0", () => resolve(true));
    });
    if (!ok) {
      if (!s.websitePort) return null;
      return null;
    }
    s.websitePort = port;
    this.save();
    this.websites.set(bucket, { port, server });
    return port;
  }

  stopWebsite(bucket) {
    const w = this.websites.get(bucket);
    if (w) w.server.close();
    this.websites.delete(bucket);
    return null;
  }

  /** What CloudLab shows for a bucket: where its files are, how many, and its website's address. */
  async report(bucket) {
    if (!this.meta.buckets[bucket]) return null;
    const port = await this.ensureWebsite(bucket);
    const lan = lanAddress();
    return {
      ...this.stats(bucket),
      localPath: path.join(this.root, bucket),
      websiteUrl: port ? `http://${lan ?? "localhost"}:${port}/` : null,
      websiteLocalUrl: port ? `http://localhost:${port}/` : null,
    };
  }

  /** Work CloudLab sends about buckets. */
  async handle(task, api) {
    const spec = task.bucket;
    if (task.op === "create-bucket") this.createBucket(spec);
    else if (task.op === "configure-bucket") this.configureBucket(spec);
    else if (task.op === "delete-bucket") {
      const kept = this.deleteBucket(spec.name);
      log(kept ? `Bucket ${spec.name} deleted in CloudLab; its folder still has files, so it was kept: ${path.join(this.root, spec.name)}` : `Bucket ${spec.name} deleted.`);
      return;
    }
    await api.reportResource(spec.name, { attributes: await this.report(spec.name) });
  }

  /** After the agent starts: serve the website buckets again. */
  async restore() {
    for (const name of Object.keys(this.meta.buckets)) await this.ensureWebsite(name);
  }
}

/**
 * The agent's own API on this computer, for the CloudLab console in your browser:
 * S3 objects are listed, uploaded and downloaded here directly, so files never go
 * through CloudLab's servers. Only answers 127.0.0.1, only the CloudLab site, and
 * only with this agent's key.
 */
export class LocalApi {
  constructor(s3, { key, origin, onChange }) {
    this.s3 = s3;
    this.key = key;
    this.origin = origin;
    this.onChange = onChange;
    this.port = null;
  }

  cors(req) {
    const origin = req.headers.origin;
    return {
      ...(origin === this.origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
      "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, x-cloudlab-key",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "600",
    };
  }

  async start(from = 4510) {
    for (let port = from; port < from + 20; port++) {
      const server = http.createServer((req, res) => this.serve(req, res));
      const ok = await new Promise((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        this.port = port;
        this.server = server;
        return port;
      }
    }
    return null;
  }

  async serve(req, res) {
    const headers = this.cors(req);
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...headers, "content-type": "application/json", ...extra });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204);
    if (req.headers.origin && req.headers.origin !== this.origin) return send(403, { error: { code: "Forbidden", message: "Only the CloudLab console may use this." } });
    const given = Buffer.from(String(req.headers["x-cloudlab-key"] ?? ""));
    const want = Buffer.from(this.key);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: { code: "Unauthorized", message: "Wrong key." } });
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // The keys for AWS SDKs and the AWS CLI: only ever handed to the console on this computer.
      if (url.pathname === "/credentials" && req.method === "GET") return send(200, this.credentials?.() ?? null);
      // A queue's messages, for the console's "Send and receive messages".
      if (url.pathname === "/sqs/console" && req.method === "POST") {
        if (!this.sqs) return send(404, { error: { code: "NotFound", message: "SQS isn't running on this computer." } });
        const input = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
        return send(200, await this.sqs.console(input));
      }
      // A DynamoDB table's items, for the console's "Explore items".
      if (url.pathname === "/dynamodb/explore" && req.method === "POST") {
        if (!this.dynamodb) return send(404, { error: { code: "NotFound", message: "DynamoDB isn't running on this computer." } });
        const input = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
        return send(200, await this.dynamodb.explore(input));
      }
      const m = /^\/s3\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!m) return send(404, { error: { code: "NotFound", message: "Unknown path." } });
      const bucket = decodeURIComponent(m[1]);
      const key = m[2] !== undefined ? decodeURIComponent(m[2]) : "";
      if (!key) {
        if (req.method === "GET") return send(200, this.s3.list(bucket, url.searchParams.get("prefix") ?? "", url.searchParams.get("delimiter") ?? ""));
        if (req.method === "DELETE") {
          const deleted = this.s3.deletePrefix(bucket, url.searchParams.get("prefix") ?? "");
          this.onChange(bucket);
          return send(200, { deleted });
        }
      } else {
        if (req.method === "PUT") {
          const object = await this.s3.put(bucket, key, req, req.headers["content-type"]);
          this.onChange(bucket);
          return send(200, { object });
        }
        if (req.method === "GET") {
          const info = this.s3.info(bucket, key);
          res.writeHead(200, { ...headers, "content-type": info.contentType, "content-length": String(info.size), etag: `"${info.etag}"` });
          return createReadStream(this.s3.file(bucket, key)).pipe(res);
        }
        if (req.method === "DELETE") {
          this.s3.delete(bucket, key);
          this.onChange(bucket);
          return send(204);
        }
      }
      return send(405, { error: { code: "MethodNotAllowed", message: "The specified method is not allowed against this resource." } });
    } catch (e) {
      if (e instanceof S3Error || e instanceof EngineError) return send(e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof SyntaxError) return send(400, { error: { code: "BadRequest", message: "The request isn't valid JSON." } });
      return send(500, { error: { code: "InternalError", message: String(e.message ?? e) } });
    }
  }
}

// ---------- the AWS endpoint: AWS's own APIs, on this computer ----------

/**
 * One address for every service's API, like an AWS region's endpoints rolled into
 * one: http://localhost:4566 (and this computer's network address). Requests are
 * signed with AWS Signature Version 4 using this computer's CloudLab keys; the
 * signature also says which service a request is for (its credential scope), so
 * S3 today, and DynamoDB, SQS, SNS, Lambda… as they arrive, share the port.
 * Point an AWS SDK or the AWS CLI here with endpoint = http://localhost:4566.
 */
export const AWS_PORT = 4566;

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/";
const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const xml = (root, inner, ns = true) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root}${ns ? ` xmlns="${XMLNS}"` : ""}>${inner}</${root}>`;
const tag = (name, value) => `<${name}>${xmlEscape(value)}</${name}>`;

/** RFC 3986 encoding as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~). */
export const uriEncode = (s, keepSlash = false) => {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, "/") : out;
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

export class AwsError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Checks a request's AWS Signature Version 4 (an Authorization header, or a presigned
 * URL's query string). Returns who signed it and for which service, or null for an
 * unsigned request. Throws AWS's errors for a bad one.
 */
export function verifySigV4(req, url, keys, now = Date.now(), bodyHash = null) {
  const q = url.searchParams;
  const auth = req.headers.authorization;
  let accessKeyId, scope, signedHeaders, signature, amzDate, payloadHash, presigned = false;
  if (auth && auth.startsWith("AWS4-HMAC-SHA256")) {
    const m = /Credential=([^/]+)\/([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)/.exec(auth);
    if (!m) throw new AwsError("AuthorizationHeaderMalformed", "The authorization header is malformed.", 400);
    [, accessKeyId, scope, signedHeaders, signature] = m;
    amzDate = req.headers["x-amz-date"] ?? "";
    // S3 clients send the body's hash as a header; other services' clients sign the body itself.
    payloadHash = req.headers["x-amz-content-sha256"] ?? bodyHash ?? sha256("");
  } else if (q.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256") {
    presigned = true;
    const cred = q.get("X-Amz-Credential") ?? "";
    accessKeyId = cred.split("/")[0];
    scope = cred.split("/").slice(1).join("/");
    signedHeaders = q.get("X-Amz-SignedHeaders") ?? "host";
    signature = q.get("X-Amz-Signature") ?? "";
    amzDate = q.get("X-Amz-Date") ?? "";
    payloadHash = "UNSIGNED-PAYLOAD";
    const expires = Number(q.get("X-Amz-Expires") ?? 0);
    const at = Date.parse(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (!Number.isFinite(at) || now > at + expires * 1000) throw new AwsError("AccessDenied", "Request has expired", 403);
  } else if (auth) {
    throw new AwsError("InvalidRequest", "The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.", 400);
  } else return null;

  const secret = keys[accessKeyId];
  if (!secret) throw new AwsError("InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.", 403, { AWSAccessKeyId: accessKeyId });
  if (!presigned) {
    const at = Date.parse(String(amzDate).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (!Number.isFinite(at) || Math.abs(now - at) > 15 * 60_000) {
      throw new AwsError("RequestTimeTooSkewed", "The difference between the request time and the current time is too large.", 403);
    }
  }
  const [date, region, service] = scope.split("/");
  const queryOf = (entries) =>
    entries
      .filter(([k]) => k !== "X-Amz-Signature")
      .map(([k, v]) => [uriEncode(k), uriEncode(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
  // Sub-resources like ?uploads or ?delete have no value: some SDKs sign them as "uploads=", others leave them out.
  const entries = [...q.entries()];
  const queries = [...new Set([queryOf(entries), queryOf(entries.filter(([, v]) => v !== ""))])];
  const names = signedHeaders.split(";");
  const canonicalHeaders = names
    .map((h) => {
      const v = h === "host" ? (req.headers.host ?? "") : req.headers[h];
      return `${h}:${String(Array.isArray(v) ? v.join(",") : (v ?? "")).trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const rawPath = (req.url ?? "/").split("?")[0] || "/";
  // Clients sign the path as they encoded it; S3 encodes each segment once.
  const paths = [rawPath, rawPath.split("/").map((s) => uriEncode(decodeURIComponentSafe(s))).join("/")];
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
  for (const p of paths) {
    for (const canonicalQuery of queries) {
      const canonical = [req.method, p, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
      const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
      if (createHmac("sha256", key).update(toSign).digest("hex") === signature) return { accessKeyId, region, service, presigned };
    }
  }
  throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your key and signing method.", 403);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Reads a request body, decoding aws-chunked uploads (what SDKs send for streams, with checksums in trailers). */
export function readBody(req, limit = MAX_OBJECT_BYTES) {
  // Already read to check its signature.
  if (req.bufferedBody) return Promise.resolve(req.bufferedBody);
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit + 1024 * 1024) {
        req.destroy();
        reject(new AwsError("EntityTooLarge", "Your proposed upload exceeds the maximum allowed size", 400));
        return;
      }
      parts.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(parts);
      const chunked = /aws-chunked/.test(String(req.headers["content-encoding"] ?? "")) || String(req.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING-");
      resolve(chunked ? decodeAwsChunked(raw) : raw);
    });
    req.on("error", reject);
  });
}

export function decodeAwsChunked(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const lineEnd = raw.indexOf("\r\n", i);
    if (lineEnd < 0) break;
    const size = parseInt(raw.subarray(i, lineEnd).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size)) break;
    if (size === 0) break; // the trailer (checksums) follows
    out.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    i = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

const httpDate = (iso) => new Date(iso).toUTCString();

/**
 * S3's REST API over CloudLab's own S3 (the bucket folders). Path-style
 * (localhost:4566/bucket/key) and virtual-hosted style (bucket.localhost:4566/key).
 */
export class S3Api {
  constructor(s3, { createBucket, deleteBucket, onChange, owner }) {
    this.s3 = s3;
    this.createBucketRemote = createBucket;
    this.deleteBucketRemote = deleteBucket;
    this.onChange = onChange;
    this.owner = owner;
    this.uploads = new Map();
  }

  /** Bucket and key from the request: virtual-hosted (bucket.localhost) or path style. */
  target(req, url) {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    const vhost = /^(.+)\.(localhost|s3\.localhost|s3\.local-1\.localhost)$/.exec(host);
    const parts = url.pathname.split("/").slice(1);
    if (vhost) return { bucket: vhost[1], key: parts.map(decodeURIComponentSafe).join("/") };
    return { bucket: decodeURIComponentSafe(parts[0] ?? ""), key: parts.slice(1).map(decodeURIComponentSafe).join("/") };
  }

  /** Anonymous (unsigned) requests may only read objects of public buckets, like S3. */
  allowAnonymous(req, bucket) {
    const s = this.s3.meta.buckets[bucket];
    return (req.method === "GET" || req.method === "HEAD") && !!s && !s.blockPublicAccess && s.publicRead;
  }

  async handle(req, res, url, who) {
    const { bucket, key } = this.target(req, url);
    const q = url.searchParams;
    const send = (status, body = "", headers = {}) => {
      res.writeHead(status, { "content-type": "application/xml", "x-amz-request-id": randomBytes(8).toString("hex").toUpperCase(), ...headers });
      res.end(body);
    };
    if (!who && !(key && this.allowAnonymous(req, bucket))) throw new AwsError("AccessDenied", "Access Denied", 403);

    // ---- the service: list buckets ----
    if (!bucket) {
      if (req.method !== "GET") throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405);
      const buckets = Object.keys(this.s3.meta.buckets).sort();
      const items = buckets
        .map((b) => {
          let created = new Date().toISOString();
          try {
            created = new Date(lstatSync(path.join(this.s3.root, b)).birthtimeMs || Date.now()).toISOString();
          } catch {}
          return `<Bucket>${tag("Name", b)}${tag("CreationDate", created)}</Bucket>`;
        })
        .join("");
      return send(200, xml("ListAllMyBucketsResult", `<Owner>${tag("ID", this.owner)}${tag("DisplayName", "cloudlab")}</Owner><Buckets>${items}</Buckets>`));
    }

    // ---- buckets ----
    if (!key) {
      if (req.method === "PUT" && ![...q.keys()].length) {
        await this.createBucketRemote(bucket);
        return send(200, "", { location: `/${bucket}` });
      }
      if (req.method === "DELETE" && ![...q.keys()].length) {
        this.s3.spec(bucket);
        if (this.s3.stats(bucket).objectCount > 0) throw new AwsError("BucketNotEmpty", "The bucket you tried to delete is not empty", 409, { BucketName: bucket });
        await this.deleteBucketRemote(bucket);
        return send(204);
      }
      this.bucketOrThrow(bucket);
      if (req.method === "HEAD") return send(200, "", { "x-amz-bucket-region": "local-1" });
      if (req.method === "GET" && q.has("location")) return send(200, xml("LocationConstraint", "local-1"));
      if (req.method === "GET" && q.has("versioning")) {
        const v = this.s3.meta.buckets[bucket].versioning;
        return send(200, xml("VersioningConfiguration", v && v !== "Disabled" ? tag("Status", v) : ""));
      }
      if (req.method === "GET" && q.has("uploads")) return send(200, xml("ListMultipartUploadsResult", `${tag("Bucket", bucket)}<IsTruncated>false</IsTruncated>`));
      if (req.method === "GET") return send(200, this.listXml(bucket, q));
      if (req.method === "POST" && q.has("delete")) {
        const body = (await readBody(req, 5 * 1024 * 1024)).toString("utf8");
        const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(body);
        const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
        const done = [];
        const errors = [];
        for (const k of keys) {
          try {
            this.s3.delete(bucket, k);
            done.push(k);
          } catch (e) {
            errors.push(`<Error>${tag("Key", k)}${tag("Code", e.code ?? "InternalError")}${tag("Message", e.message)}</Error>`);
          }
        }
        this.onChange(bucket);
        return send(200, xml("DeleteResult", (quiet ? "" : done.map((k) => `<Deleted>${tag("Key", k)}</Deleted>`).join("")) + errors.join("")));
      }
      throw new AwsError("NotImplemented", "A header or query you provided requested a function that is not implemented in CloudLab's S3.", 501);
    }

    // ---- objects ----
    this.bucketOrThrow(bucket);
    if (req.method === "POST" && q.has("uploads")) {
      const uploadId = randomBytes(16).toString("hex");
      this.uploads.set(uploadId, { bucket, key, parts: new Map(), contentType: req.headers["content-type"], metadata: userMetadata(req) });
      return send(200, xml("InitiateMultipartUploadResult", tag("Bucket", bucket) + tag("Key", key) + tag("UploadId", uploadId)));
    }
    if (q.has("uploadId")) return this.multipart(req, send, bucket, key, q);
    if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
      const src = decodeURIComponentSafe(String(req.headers["x-amz-copy-source"]).split("?")[0]).replace(/^\//, "");
      const [sb, ...sk] = src.split("/");
      const from = this.s3.file(sb, sk.join("/"));
      const info = this.s3.info(sb, sk.join("/"));
      const replace = String(req.headers["x-amz-metadata-directive"] ?? "COPY").toUpperCase() === "REPLACE";
      const o = await this.s3.put(bucket, key, Readable.from([readFileSync(from)]), replace ? req.headers["content-type"] : info.contentType, replace ? userMetadata(req) : this.s3.metadata(sb, sk.join("/")));
      this.onChange(bucket);
      return send(200, xml("CopyObjectResult", tag("LastModified", o.lastModified) + tag("ETag", `"${o.etag}"`)));
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const o = await this.s3.put(bucket, key, Readable.from([body]), req.headers["content-type"], userMetadata(req));
      this.onChange(bucket);
      return send(200, "", { etag: `"${o.etag}"` });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const info = this.s3.info(bucket, key);
      const meta = this.s3.metadata(bucket, key);
      const headers = {
        "content-type": info.contentType,
        etag: `"${info.etag}"`,
        "last-modified": httpDate(info.lastModified),
        "accept-ranges": "bytes",
        ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`x-amz-meta-${k}`, v])),
      };
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
      if (range && info.size > 0) {
        let start = range[1] === "" ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
        let end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
        if (start > end || start >= info.size) throw new AwsError("InvalidRange", "The requested range is not satisfiable", 416);
        res.writeHead(206, { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${info.size}` });
        if (req.method === "HEAD") return res.end();
        return createReadStream(this.s3.file(bucket, key), { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, "content-length": String(info.size) });
      if (req.method === "HEAD") return res.end();
      if (key.endsWith("/")) return res.end();
      return createReadStream(this.s3.file(bucket, key)).pipe(res);
    }
    if (req.method === "DELETE") {
      this.s3.delete(bucket, key);
      this.onChange(bucket);
      return send(204);
    }
    throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405);
  }

  bucketOrThrow(bucket) {
    if (!this.s3.meta.buckets[bucket]) throw new AwsError("NoSuchBucket", "The specified bucket does not exist", 404, { BucketName: bucket });
  }

  listXml(bucket, q) {
    const v2 = q.get("list-type") === "2";
    const prefix = q.get("prefix") ?? "";
    const delimiter = q.get("delimiter") ?? "";
    const max = Math.min(Number(q.get("max-keys") ?? 1000) || 1000, 1000);
    const encode = q.get("encoding-type") === "url";
    const enc = (s) => (encode ? uriEncode(s, true) : s);
    const after = v2 ? (q.get("continuation-token") ? Buffer.from(q.get("continuation-token"), "base64url").toString() : (q.get("start-after") ?? "")) : (q.get("marker") ?? "");
    const { objects, prefixes } = this.s3.list(bucket, prefix, delimiter);
    const entries = [...objects.map((o) => ({ key: o.key, o })), ...prefixes.map((p) => ({ key: p, p }))].sort((a, b) => (a.key < b.key ? -1 : 1)).filter((e) => e.key > after);
    const page = entries.slice(0, max);
    const truncated = entries.length > max;
    const last = page[page.length - 1]?.key ?? "";
    const contents = page
      .filter((e) => e.o)
      .map((e) => `<Contents>${tag("Key", enc(e.o.key))}${tag("LastModified", e.o.lastModified)}${tag("ETag", `"${e.o.etag}"`)}${tag("Size", e.o.size)}${tag("StorageClass", "STANDARD")}</Contents>`)
      .join("");
    const common = page
      .filter((e) => e.p)
      .map((e) => `<CommonPrefixes>${tag("Prefix", enc(e.p))}</CommonPrefixes>`)
      .join("");
    const head =
      tag("Name", bucket) +
      tag("Prefix", enc(prefix)) +
      (delimiter ? tag("Delimiter", enc(delimiter)) : "") +
      tag("MaxKeys", max) +
      (encode ? tag("EncodingType", "url") : "") +
      tag("IsTruncated", truncated) +
      (v2
        ? tag("KeyCount", page.length) + (q.get("continuation-token") ? tag("ContinuationToken", q.get("continuation-token")) : "") + (truncated ? tag("NextContinuationToken", Buffer.from(last).toString("base64url")) : "") + (q.get("start-after") ? tag("StartAfter", enc(q.get("start-after"))) : "")
        : tag("Marker", enc(q.get("marker") ?? "")) + (truncated && delimiter ? tag("NextMarker", enc(last)) : ""));
    return xml("ListBucketResult", head + contents + common);
  }

  async multipart(req, send, bucket, key, q) {
    const uploadId = q.get("uploadId");
    const up = this.uploads.get(uploadId);
    if (!up || up.bucket !== bucket || up.key !== key) throw new AwsError("NoSuchUpload", "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.", 404, { UploadId: uploadId });
    if (req.method === "PUT") {
      const n = Number(q.get("partNumber"));
      if (!Number.isInteger(n) || n < 1 || n > 10000) throw new AwsError("InvalidArgument", "Part number must be an integer between 1 and 10000, inclusive", 400);
      const body = await readBody(req);
      const etag = createHash("md5").update(body).digest("hex");
      up.parts.set(n, { body, etag });
      return send(200, "", { etag: `"${etag}"` });
    }
    if (req.method === "DELETE") {
      this.uploads.delete(uploadId);
      return send(204);
    }
    if (req.method === "GET") {
      const parts = [...up.parts.entries()].sort((a, b) => a[0] - b[0]).map(([n, p]) => `<Part>${tag("PartNumber", n)}${tag("ETag", `"${p.etag}"`)}${tag("Size", p.body.length)}</Part>`).join("");
      return send(200, xml("ListPartsResult", tag("Bucket", bucket) + tag("Key", key) + tag("UploadId", uploadId) + parts));
    }
    if (req.method === "POST") {
      const body = (await readBody(req, 5 * 1024 * 1024)).toString("utf8");
      const wanted = [...body.matchAll(/<Part>[\s\S]*?<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<\/Part>/g)].map((m) => Number(m[1]));
      const chunks = [];
      for (const n of wanted) {
        const p = up.parts.get(n);
        if (!p) throw new AwsError("InvalidPart", "One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part's entity tag.", 400);
        chunks.push(p.body);
      }
      await this.s3.put(bucket, key, Readable.from([Buffer.concat(chunks)]), up.contentType, up.metadata);
      // Like S3: the ETag of a multipart upload is the MD5 of the parts' MD5s, and their count.
      const etag = `${createHash("md5").update(Buffer.concat(wanted.map((n) => Buffer.from(up.parts.get(n).etag, "hex")))).digest("hex")}-${wanted.length}`;
      this.s3.setEtag(bucket, key, etag);
      this.uploads.delete(uploadId);
      this.onChange(bucket);
      return send(200, xml("CompleteMultipartUploadResult", tag("Location", `http://localhost:${AWS_PORT}/${bucket}/${key}`) + tag("Bucket", bucket) + tag("Key", key) + tag("ETag", `"${etag}"`)));
    }
    throw new AwsError("MethodNotAllowed", "The specified method is not allowed against this resource.", 405);
  }
}

const userMetadata = (req) => Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-amz-meta-")).map(([k, v]) => [k.slice(11), String(v)]));

/** Serves the AWS endpoint: checks the signature, then hands the request to the service it was signed for. */
export class AwsEndpoint {
  constructor({ keys, services }) {
    this.keys = keys;
    this.services = services;
    this.port = null;
  }

  async start(port = AWS_PORT) {
    const server = http.createServer((req, res) => this.serve(req, res));
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "0.0.0.0", () => resolve(true));
    });
    if (!ok) return null;
    this.server = server;
    this.port = server.address().port;
    return this.port;
  }

  async serve(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Browsers uploading with presigned URLs ask first (CORS).
    const cors = {
      "access-control-allow-origin": req.headers.origin ?? "*",
      "access-control-allow-methods": "GET, PUT, POST, DELETE, HEAD",
      "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "*"),
      "access-control-expose-headers": "ETag, x-amz-request-id, x-amz-version-id",
    };
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      return res.end();
    }
    // Unsigned requests can't name a service in a signature: DynamoDB's say who they're for in X-Amz-Target.
    const target = String(req.headers["x-amz-target"] ?? "");
    let service = target.startsWith("DynamoDB_") ? "dynamodb" : target.startsWith("AmazonSQS.") ? "sqs" : "s3";
    // Errors in the signature itself come back in the shape of the service it was for.
    const scope = /Credential=[^/,]+\/\d{8}\/[^/]+\/([^/]+)\//.exec(String(req.headers.authorization ?? "")) ?? /^[^/]+\/\d{8}\/[^/]+\/([^/]+)\//.exec(url.searchParams.get("X-Amz-Credential") ?? "");
    if (scope && this.services[scope[1]]) service = scope[1];
    try {
      let bodyHash = null;
      if (req.headers.authorization && !req.headers["x-amz-content-sha256"] && req.method !== "GET" && req.method !== "HEAD") {
        req.bufferedBody = await readBody(req, 16 * 1024 * 1024);
        bodyHash = sha256(req.bufferedBody);
      }
      const who = verifySigV4(req, url, this.keys(), Date.now(), bodyHash);
      if (who) service = who.service;
      const handler = this.services[service];
      if (!handler) throw new AwsError("NotImplemented", `CloudLab doesn't run ${service} on your computer yet.`, 501);
      await handler.handle(req, res, url, who);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (this.services[service]?.sendError) return this.services[service].sendError(res, e);
      const code = e.code ?? "InternalError";
      const status = e.status ?? 500;
      const extra = Object.entries(e.extra ?? {}).map(([k, v]) => tag(k, v)).join("");
      const body = req.method === "HEAD" ? "" : xml("Error", tag("Code", code) + tag("Message", e.message) + extra + tag("RequestId", randomBytes(8).toString("hex").toUpperCase()), false);
      res.writeHead(status, { "content-type": "application/xml" });
      res.end(body);
    }
  }
}

// ---------- DynamoDB ----------

const DDB_PREFIX = "DynamoDB_20120810.";
const DDB_ERROR_NS = "com.amazonaws.dynamodb.v20120810#";

/**
 * DynamoDB's API on the AWS endpoint (AWS's JSON protocol: POST / with
 * X-Amz-Target: DynamoDB_20120810.<Operation>). The work is CloudLab's own
 * DynamoDB code (lib/core.mjs) on tables kept as files on this computer.
 * Creating, changing and deleting tables goes through CloudLab, so they show
 * up in the console; items stay here.
 */
export class DynamoApi {
  constructor(host, { createTable, updateTable, deleteTable }) {
    this.host = host;
    this.ctx = { host, accountId: "local", region: "local-1", createTable, updateTable, deleteTable };
  }

  async handle(req, res, url, who) {
    if (!who) throw new AwsError("MissingAuthenticationTokenException", "Request is missing Authentication Token", 400);
    if (req.method !== "POST" || url.pathname !== "/") throw new AwsError("UnknownOperationException", "", 400);
    const target = String(req.headers["x-amz-target"] ?? "");
    if (!target.startsWith(DDB_PREFIX)) throw new AwsError("UnknownOperationException", "", 400);
    let body;
    try {
      const raw = (await readBody(req, 16 * 1024 * 1024)).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      if (e instanceof AwsError) throw e;
      throw new AwsError("SerializationException", "Start of structure or map found where not expected.", 400);
    }
    const out = await dynamodbApi(target.slice(DDB_PREFIX.length), body, this.ctx);
    const json = JSON.stringify(out ?? {});
    res.writeHead(200, { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": randomBytes(16).toString("hex").toUpperCase(), "content-length": Buffer.byteLength(json) });
    res.end(json);
  }

  /** DynamoDB's error shape: {"__type": "com.amazonaws.dynamodb.v20120810#Code", "message": "…"}. */
  sendError(res, e) {
    // DynamoDB names signature problems its own way.
    const auth = {
      SignatureDoesNotMatch: ["InvalidSignatureException", e.message],
      InvalidAccessKeyId: ["UnrecognizedClientException", "The security token included in the request is invalid."],
      RequestTimeTooSkewed: ["InvalidSignatureException", "Signature expired: the request's time is more than 15 minutes from this computer's time."],
      AuthorizationHeaderMalformed: ["IncompleteSignatureException", e.message],
    }[e.code];
    if (auth) e = new AwsError(auth[0], auth[1], 400);
    const code = e.code ?? "InternalServerError";
    const known = e instanceof EngineError || e instanceof AwsError;
    const ns = code === "UnknownOperationException" || code === "SerializationException" ? "com.amazon.coral.service#" : DDB_ERROR_NS;
    const body = { __type: ns + (known ? code : "InternalServerError"), message: known ? e.message : "Internal server error", ...(e.extra ?? {}) };
    if (!known) log("DynamoDB:", e.stack ?? e);
    res.writeHead(known ? (e.status ?? 400) : 500, { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": randomBytes(16).toString("hex").toUpperCase() });
    res.end(JSON.stringify(body));
  }

  /** The console's "Explore items" for a table on this computer. */
  async explore(input) {
    const t = this.host.byName(String(input?.table ?? ""));
    const action = input?.action;
    if (!["scan", "query", "put", "delete", "statement"].includes(action)) throw new EngineError("ValidationException", "Unknown action.", 400);
    return explore(this.host, t, { limit: 100, forward: true, mustBeNew: false, ...input });
  }
}

// ---------- SQS ----------

const SQS_PREFIX = "AmazonSQS.";

/**
 * SQS's API on the AWS endpoint (AWS's JSON protocol, which current SDKs and the
 * AWS CLI use: POST / with X-Amz-Target: AmazonSQS.<Operation>). The work is
 * CloudLab's own SQS code (lib/core.mjs) on queues kept as files on this computer.
 * Long polling really waits (QueueWaiters), so idle workers cost nothing.
 */
export class SqsApi {
  constructor(host, { createQueue, updateQueue, deleteQueue, urlOf }) {
    this.host = host;
    this.waiters = new QueueWaiters();
    this.ctx = { host, accountId: "local", region: "local-1", createQueue, updateQueue, deleteQueue, urlOf, waiters: this.waiters };
  }

  async handle(req, res, url, who) {
    if (!who) throw new AwsError("MissingAuthenticationToken", "Request is missing Authentication Token", 403);
    if (String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
      throw new AwsError(
        "UnsupportedProtocol",
        "This client uses SQS's older Query protocol. CloudLab's SQS speaks the JSON protocol that current AWS SDKs and the AWS CLI use: update your SDK.",
        400,
      );
    }
    const target = String(req.headers["x-amz-target"] ?? "");
    if (req.method !== "POST" || !target.startsWith(SQS_PREFIX)) throw new AwsError("AWS.SimpleQueueService.UnsupportedOperation", "", 400);
    let body;
    try {
      const raw = (await readBody(req, 2 * 1024 * 1024)).toString("utf8");
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      if (e instanceof AwsError) throw e;
      throw new AwsError("SerializationException", "The request body isn't valid JSON.", 400);
    }
    // A long-polling receive ends early if the client goes away.
    const out = await sqsApi(target.slice(SQS_PREFIX.length), body, this.ctx);
    if (res.destroyed) return;
    const json = JSON.stringify(out ?? {});
    res.writeHead(200, { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": randomUUIDv4(), "content-length": Buffer.byteLength(json) });
    res.end(json);
  }

  /** SQS's error shape: {"__type": "com.amazonaws.sqs#QueueDoesNotExist", "message": "…"}, with the older code in x-amzn-query-error. */
  sendError(res, e) {
    const auth = {
      InvalidAccessKeyId: ["InvalidClientTokenId", "The security token included in the request is invalid.", 403],
      SignatureDoesNotMatch: ["SignatureDoesNotMatch", e.message, 403],
      RequestTimeTooSkewed: ["SignatureDoesNotMatch", "Signature expired: the request's time is more than 15 minutes from this computer's time.", 403],
    }[e.code];
    if (auth) e = new AwsError(auth[0], auth[1], auth[2]);
    const known = e instanceof EngineError || e instanceof AwsError;
    if (!known) log("SQS:", e.stack ?? e);
    const code = known ? (e.code ?? "InternalError") : "InternalError";
    const { type, queryCode } = sqsErrorNames(code);
    const status = known ? (e.status ?? 400) : 500;
    res.writeHead(status, {
      "content-type": "application/x-amz-json-1.0",
      "x-amzn-requestid": randomUUIDv4(),
      "x-amzn-query-error": `${queryCode};${status < 500 ? "Sender" : "Receiver"}`,
    });
    res.end(JSON.stringify({ __type: `com.amazonaws.sqs#${type}`, message: known ? e.message : "Internal error" }));
  }

  /** The console's "Send and receive messages" for a queue on this computer. */
  async console(input) {
    const q = this.host.byName(String(input?.queue ?? ""));
    if (!["counts", "send", "receive", "delete", "purge"].includes(input?.action)) throw new EngineError("ValidationException", "Unknown action.", 400);
    return queueConsole(this.host, q, { maxNumberOfMessages: 10, attributes: {}, ...input }, () => this.waiters.notify(q.id));
  }
}

const randomUUIDv4 = () => randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

// ---------- EC2 in My computer (local) ----------

const EC2_DIR = path.join(HOME, "ec2");

/**
 * Runs when an instance's container starts, as its first process: the parts of an
 * EC2 boot a plain container doesn't do. User data runs once, on the first boot (its
 * output in /var/log/cloud-init-output.log); services enabled with systemctl start on
 * every boot; sudo works.
 */
export const EC2_BOOT = `#!/bin/sh
mkdir -p /var/lib/cloudlab /var/log /var/run
cp /cloudlab/systemctl /usr/local/bin/systemctl 2>/dev/null && chmod +x /usr/local/bin/systemctl
command -v sudo >/dev/null 2>&1 || { printf '#!/bin/sh\\nexec "$@"\\n' > /usr/local/bin/sudo; chmod +x /usr/local/bin/sudo; }
# Debian and Ubuntu images stop services from starting; a server should start them.
rm -f /usr/sbin/policy-rc.d
if [ -f /cloudlab/user-data ] && [ ! -f /var/lib/cloudlab/user-data-done ]; then
  touch /var/lib/cloudlab/user-data-done
  cp /cloudlab/user-data /var/lib/cloudlab/user-data.sh && chmod +x /var/lib/cloudlab/user-data.sh
  (
    echo "Cloud-init: running user data at $(date)"
    if head -1 /var/lib/cloudlab/user-data.sh | grep -q '^#!'; then /var/lib/cloudlab/user-data.sh; else sh /var/lib/cloudlab/user-data.sh; fi
    echo "Cloud-init: user data finished with exit code $? at $(date)"
  ) >> /var/log/cloud-init-output.log 2>&1 &
fi
if [ -f /var/lib/cloudlab/enabled ]; then
  while read -r s; do [ -n "$s" ] && /usr/local/bin/systemctl start "$s" >/dev/null 2>&1; done < /var/lib/cloudlab/enabled
fi
trap 'exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
`;

/**
 * A systemctl for containers, which have no systemd: start, stop, restart, enable,
 * disable and status, through the service's init script or its unit file.
 */
export const EC2_SYSTEMCTL = `#!/bin/sh
# CloudLab: a stand-in for systemctl (containers have no systemd).
cmd="$1"; [ $# -gt 0 ] && shift
now=""; svc=""
for a in "$@"; do case "$a" in --now) now=1 ;; -*) ;; *) svc="\${a%.service}" ;; esac; done
unit_file() { for d in /etc/systemd/system /lib/systemd/system /usr/lib/systemd/system; do [ -f "$d/$svc.service" ] && { echo "$d/$svc.service"; return; }; done; }
pidfile="/var/run/cloudlab-$svc.pid"
do_start() {
  if [ -x "/etc/init.d/$svc" ]; then "/etc/init.d/$svc" start; return $?; fi
  u=$(unit_file); [ -z "$u" ] && { echo "Failed to start $svc.service: Unit $svc.service not found." >&2; return 5; }
  sed -n 's/^ExecStartPre=-\\{0,1\\}//p' "$u" | while read -r l; do sh -c "$l" >/dev/null 2>&1; done
  start=$(sed -n 's/^ExecStart=//p' "$u" | head -1)
  nohup sh -c "$start" >> "/var/log/$svc.log" 2>&1 &
  echo $! > "$pidfile"
}
do_stop() {
  if [ -x "/etc/init.d/$svc" ]; then "/etc/init.d/$svc" stop; return $?; fi
  [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null; rm -f "$pidfile"
  u=$(unit_file); [ -n "$u" ] && bin=$(sed -n 's/^ExecStart=//p' "$u" | head -1 | awk '{print $1}') && [ -n "$bin" ] && pkill -f "$bin" 2>/dev/null
  return 0
}
case "$cmd" in
  start) do_start ;;
  stop) do_stop ;;
  restart|reload|try-restart|reload-or-restart) do_stop; sleep 1; do_start ;;
  enable)
    mkdir -p /var/lib/cloudlab; touch /var/lib/cloudlab/enabled
    grep -qx "$svc" /var/lib/cloudlab/enabled || echo "$svc" >> /var/lib/cloudlab/enabled
    echo "Created symlink: $svc.service will start at boot (CloudLab)."
    [ -n "$now" ] && do_start ;;
  disable) [ -f /var/lib/cloudlab/enabled ] && sed -i "/^$svc\\$/d" /var/lib/cloudlab/enabled; [ -n "$now" ] && do_stop; true ;;
  status|is-active)
    if [ -x "/etc/init.d/$svc" ]; then "/etc/init.d/$svc" status; exit $?; fi
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo "active (running)"; exit 0; fi
    echo "inactive (dead)"; exit 3 ;;
  is-enabled) grep -qx "$svc" /var/lib/cloudlab/enabled 2>/dev/null && { echo enabled; exit 0; } || { echo disabled; exit 1; } ;;
  daemon-reload|daemon-reexec) exit 0 ;;
  *) echo "CloudLab's systemctl supports start, stop, restart, enable, disable and status." >&2; exit 1 ;;
esac
`;

const ec2Container = (id) => `cloudlab-ec2-${id}`;
const ec2Image = (id) => `cloudlab/ec2-${id}:saved`;

/** EC2 instances as Linux containers. Reports go to CloudLab as the instance's real state and details. */
export class Ec2Instances {
  constructor(api) {
    this.api = api;
  }

  report(id, r) {
    return this.api.reportResource(id, r);
  }

  async inspect(id) {
    const r = await docker(["inspect", "-f", `{{.State.Status}}|{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, ec2Container(id)]);
    if (r.code !== 0) return null;
    const [status, ip] = r.out.trim().split("|");
    return { status, ip: ip && ip !== "<no value>" ? ip : null };
  }

  /** Host ports for the instance's open ports: the same number when it's free, else from 8000 up. */
  async portMap(ports, taken) {
    const map = [];
    for (const port of ports) {
      let hostPort = port >= 1024 && !taken.includes(port) ? await freePort(port, taken).catch(() => null) : null;
      if (hostPort !== port) hostPort = await freePort(8000, taken);
      taken.push(hostPort);
      map.push({ port, hostPort });
    }
    return map;
  }

  async takenPorts() {
    const r = await docker(["ps", "-a", "--format", "{{.Ports}}"]);
    return [...r.out.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
  }

  /** Creates the container (not started) with the spec's ports, from `image`. */
  async create(spec, image) {
    const dir = path.join(EC2_DIR, spec.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "boot.sh"), EC2_BOOT);
    writeFileSync(path.join(dir, "systemctl"), EC2_SYSTEMCTL);
    if (spec.userData) writeFileSync(path.join(dir, "user-data"), spec.userData);
    else rmSync(path.join(dir, "user-data"), { force: true });
    await ensureNetwork();
    const map = await this.portMap(spec.ports, await this.takenPorts());
    const args = [
      "create",
      "--name",
      ec2Container(spec.id),
      "--hostname",
      spec.hostname,
      "--label",
      `cloudlab.ec2=${spec.id}`,
      "--network",
      NETWORK,
      "--cpus",
      String(Math.min(spec.cpus, os.cpus().length || 1)),
      "--memory",
      `${spec.memoryMb}m`,
      "-v",
      `${dir}:/cloudlab:ro`,
      ...map.flatMap((m) => ["-p", `${m.hostPort}:${m.port}`]),
      image,
      "/bin/sh",
      "/cloudlab/boot.sh",
    ];
    const r = await docker(args);
    if (r.code !== 0) throw new Error(`Docker couldn't create the instance: ${tail(r.out, 400)}`);
    return map;
  }

  /** The instance's details as CloudLab shows them, after a start. */
  async running(spec, map) {
    const info = await this.inspect(spec.id);
    const lanIp = lanAddress();
    return {
      state: "running",
      attributes: {
        publicIp: lanIp,
        localIp: info?.ip ?? null,
        portMap: map,
        container: ec2Container(spec.id),
        localImage: spec.image,
        localError: null,
      },
    };
  }

  fail(id, message) {
    log(`  ${id}: ${message}`);
    return this.report(id, { state: "terminated", attributes: { localError: message, stateReason: "Server.InternalError" } });
  }

  async launch(spec) {
    const info = await dockerInfo();
    if (!info.ok) return this.fail(spec.id, `EC2 instances run in Docker, and Docker isn't running on this computer. ${info.error}`);
    // Getting the machine image can take a minute the first time.
    if ((await docker(["image", "inspect", spec.image])).code !== 0) {
      await this.report(spec.id, { attributes: { localStatus: `Downloading ${spec.imageName} (${spec.image})…` } });
      const pull = await docker(["pull", spec.image], { timeoutMs: 20 * 60_000 });
      if (pull.code !== 0) return this.fail(spec.id, `Couldn't download ${spec.image}: ${tail(pull.out, 300)}`);
    }
    await docker(["rm", "-f", ec2Container(spec.id)]);
    let map;
    try {
      map = await this.create(spec, spec.image);
    } catch (e) {
      return this.fail(spec.id, e.message);
    }
    const r = await docker(["start", ec2Container(spec.id)]);
    if (r.code !== 0) return this.fail(spec.id, `The instance didn't start: ${tail(r.out, 300)}`);
    log(`EC2 ${spec.name} is running (${spec.image}).`);
    const done = await this.running(spec, map);
    await this.report(spec.id, { ...done, attributes: { ...done.attributes, localStatus: null } });
  }

  /** Recreates the container with new ports, keeping its disk (as a saved image). Running stays running. */
  async ports(spec) {
    const before = await this.inspect(spec.id);
    if (!before) return;
    const wasRunning = before.status === "running";
    if (wasRunning) await docker(["stop", "-t", "10", ec2Container(spec.id)]);
    const commit = await docker(["commit", ec2Container(spec.id), ec2Image(spec.id)]);
    if (commit.code !== 0) return this.report(spec.id, { attributes: { localError: `Couldn't apply the security group change: ${tail(commit.out, 300)}` } });
    await docker(["rm", "-f", ec2Container(spec.id)]);
    const map = await this.create(spec, ec2Image(spec.id));
    if (wasRunning) {
      await docker(["start", ec2Container(spec.id)]);
      await this.report(spec.id, await this.running(spec, map));
    } else await this.report(spec.id, { attributes: { portMap: map } });
    log(`EC2 ${spec.name}: ports now ${map.map((m) => `${m.port}→${m.hostPort}`).join(", ") || "none"}.`);
  }

  async handle(task) {
    const { op, id, spec } = task;
    if (op === "launch") return this.launch(spec);
    const exists = await this.inspect(id);
    if (!exists && op !== "terminate") return this.fail(id, "The instance's container isn't on this computer any more (removed outside CloudLab).");
    if (op === "stop") {
      await docker(["stop", "-t", "10", ec2Container(id)]);
      return this.report(id, { state: "stopped", attributes: { localIp: null } });
    }
    if (op === "start") {
      const r = await docker(["start", ec2Container(id)]);
      if (r.code !== 0) return this.report(id, { state: "stopped", attributes: { localError: `It didn't start: ${tail(r.out, 300)}` } });
      const portMap = (await this.portMapOf(id)) ?? [];
      return this.report(id, await this.running(spec, portMap));
    }
    if (op === "reboot") {
      await docker(["restart", "-t", "5", ec2Container(id)]);
      return this.report(id, await this.running(spec, (await this.portMapOf(id)) ?? []));
    }
    if (op === "terminate") {
      await docker(["rm", "-f", ec2Container(id)]);
      await docker(["rmi", ec2Image(id)]);
      rmSync(path.join(EC2_DIR, id), { recursive: true, force: true });
      log(`EC2 ${id} terminated.`);
      return this.report(id, { state: "terminated", attributes: { localIp: null, portMap: [] } });
    }
    if (op === "ports") return this.ports(spec);
    if (op === "exec") return this.exec(id, task.command, task.execId);
  }

  async portMapOf(id) {
    const r = await docker(["port", ec2Container(id)]);
    if (r.code !== 0) return null;
    const map = [];
    for (const m of r.out.matchAll(/^(\d+)\/tcp -> [^:]*:(\d+)$/gm)) if (!map.some((x) => x.port === Number(m[1]))) map.push({ port: Number(m[1]), hostPort: Number(m[2]) });
    return map;
  }

  /** Runs a command as root, like Systems Manager Run Command, and reports its output. */
  async exec(id, command, execId) {
    const shell = (await docker(["exec", ec2Container(id), "sh", "-c", "command -v bash"])).code === 0 ? "bash" : "sh";
    const r = await docker(["exec", ec2Container(id), shell, "-lc", command], { timeoutMs: 5 * 60_000 });
    await this.report(id, {
      attributes: { lastCommand: { id: execId, command, status: r.code === 0 ? "Success" : "Failed", exitCode: r.code, output: tail(r.out, 24_000), at: new Date().toISOString() } },
    });
  }
}

// ---------- tasks ----------

/**
 * How a container's state reads in CloudLab. An app that exited with an error (not
 * because it was stopped) or that Docker keeps restarting has failed.
 */
export function appState(c) {
  if (c.running) return { status: "running", detail: `Running on port ${c.hostPort}.` };
  if (c.state === "restarting") return { status: "failed", detail: "The app keeps crashing, and Docker keeps restarting it. Its logs say why." };
  const stopped = c.exitCode === 0 || c.exitCode === 137 || c.exitCode === 143;
  return stopped ? { status: "stopped", detail: "Stopped. Start it again whenever you like." } : { status: "failed" };
}

export class Agent {
  constructor(api) {
    this.api = api;
    this.busy = new Set();
    this.lastLogs = 0;
    this.gateway = new Gateway();
    this.native = new NativeApps();
    this.ec2 = new Ec2Instances(api);
    this.nativeGateway = new NativeGateway();
    this.s3 = new LocalS3();
    this.localApi = null;
    this.bucketReports = new Map();
    /** DynamoDB tables and SQS queues on this computer (set up in startLocal). */
    this.tables = null;
    this.queues = null;
    this.localReports = new Map();
  }

  /** Sets up and starts an app without Docker. Returns an error message, or null. */
  async deployNative({ appId, name, source, hostPort, plan, dir, report, progress, getBuildLog }) {
    const np = nativePlan(plan, dir);
    if (np.kind === "docker") throw new Error("This project has its own Dockerfile, so it needs Docker, which isn't running on this computer.");
    if (source.type === "github" && np.kind !== "static") {
      throw new Error(
        "Without Docker, CloudLab only runs code from GitHub if it's a static site: anything else would run with full access to your computer. If you trust this repository, copy it into your CloudLab folder and deploy that folder.",
      );
    }
    await report({ status: "building", detail: "Setting it up without Docker…", runtime: np.runtime });
    const dockerPorts = ((await inventory()) ?? []).map((c) => c.hostPort);
    const port = await this.native.deploy(appId, name, np, dir, hostPort, [...this.native.ports(), ...dockerPorts], progress);
    await report({ status: "starting", detail: "Starting…", buildLog: getBuildLog() });
    const ok = await this.native.start(appId);
    const logs = this.native.logs(appId);
    if (!ok) {
      await report({ status: "failed", detail: "The app started and then stopped. Its logs say why.", hostPort: port, containerPort: null, logs, buildLog: getBuildLog() });
      return "The app exited right after starting.";
    }
    await report({ status: "running", detail: `Running on port ${port}, without Docker.`, hostPort: port, containerPort: null, runtime: np.runtime, logs, buildLog: getBuildLog() });
    log(`${name} is running without Docker: http://localhost:${port}`);
    return null;
  }

  async deploy(task) {
    const { appId, name, source, hostPort } = task.payload;
    const mode = task.payload.mode ?? "auto";
    if (!NAME.test(name ?? "")) throw new Error("Invalid app name.");
    this.busy.add(appId);
    let buildLog = "";
    let lastSent = 0;
    const report = (r) => this.api.report(appId, r);
    const progress = (detail, output) => {
      if (output !== undefined) buildLog = tail(output);
      if (detail) report({ detail, buildLog });
      else if (Date.now() - lastSent > 2000) {
        lastSent = Date.now();
        report({ buildLog });
      }
    };
    try {
      // "native" never touches Docker; "docker" and "auto" use it when it's there (starting it if needed).
      const info = mode === "native" ? await dockerInfoQuiet() : await waitForDocker();
      if (mode === "docker" && !info.ok) {
        throw new Error('You chose Docker, but Docker isn\'t running on this computer. Start Docker Desktop and redeploy, or redeploy with "Without Docker".');
      }
      const useDocker = mode !== "native" && info.ok;
      // A redeploy starts from scratch, whichever way it ran before.
      await this.native.remove(appId);
      if (!useDocker && info.ok) await docker(["rm", "-f", containerName(name)]);

      // 1. Get the code into a fresh folder.
      const dir = path.join(APPS_DIR, appId, "src");
      rmSync(path.dirname(dir), { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      const preparing = { sample: "Preparing the sample app…", folder: `Copying ${source.folder ?? "the folder"}…`, github: "Downloading the code…" }[source.type];
      await report({ status: "downloading", detail: preparing, buildLog: "" });
      if (source.type === "folder") {
        copyProject(source.folder, dir);
      } else if (source.type === "sample") {
        const files = SAMPLE_FILES[source.sample];
        if (!files) throw new Error(`Unknown sample ${source.sample}.`);
        mkdirSync(dir, { recursive: true });
        writeFiles(dir, files);
      } else {
        await fetchRepo(source, dir, progress);
      }

      // 2. Work out how to run it, and build the image.
      const plan = detect(dir);
      if (!plan) {
        const where = source.type === "folder" ? `the folder ${source.folder}` : "the repository";
        throw new Error(`Couldn't tell how to run this code: there's no Dockerfile, package.json, requirements.txt or index.html at the top of ${where}. Add a Dockerfile.`);
      }
      if (!useDocker) return await this.deployNative({ appId, name, source, hostPort, plan, dir, report, progress, getBuildLog: () => buildLog });
      if (plan.dockerfile && !existsSync(path.join(dir, "Dockerfile"))) writeFileSync(path.join(dir, "Dockerfile"), plan.dockerfile);
      if (!existsSync(path.join(dir, ".dockerignore"))) writeFileSync(path.join(dir, ".dockerignore"), "node_modules\n.git\n");
      await report({ status: "building", detail: `Building the image (${plan.runtime})…`, runtime: plan.runtime });
      const build = await docker(["build", "-t", imageName(name), "--label", `cloudlab.app=${appId}`, dir], { onOutput: (o) => progress(null, o) });
      buildLog = tail(build.out);
      if (build.code !== 0) throw new Error("The image didn't build. The build log says why (look near the end).");

      // 3. Replace any previous container and start the new one.
      await report({ status: "starting", detail: "Starting the container…", buildLog });
      await docker(["rm", "-f", containerName(name)]);
      await ensureNetwork();
      const others = ((await inventory()) ?? []).filter((c) => c.id !== appId).map((c) => c.hostPort);
      const port = hostPort ?? (await freePort(8080, others));
      const started = await docker([
        "run",
        "-d",
        "--name",
        containerName(name),
        "--label",
        `cloudlab.app=${appId}`,
        "--label",
        `cloudlab.name=${name}`,
        "--label",
        `cloudlab.port=${port}`,
        "--label",
        `cloudlab.containerPort=${plan.containerPort}`,
        "--label",
        `cloudlab.runtime=${plan.runtime}`,
        "--network",
        NETWORK,
        "--restart",
        "unless-stopped",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "-e",
        `PORT=${plan.containerPort}`,
        "-p",
        `${port}:${plan.containerPort}`,
        imageName(name),
      ]);
      if (started.code !== 0) {
        throw new Error(/port is already allocated|address already in use/i.test(started.out) ? `Port ${port} is already used by another program on your computer. Redeploy with another port.` : `Docker couldn't start it:\n${tail(started.out, 1000)}`);
      }

      // 4. Give it a moment: an app that crashes on start shows up here.
      await sleep(3000);
      const c = await containerFor(appId);
      const logs = await containerLogs(containerName(name));
      if (!c?.running) {
        // Don't let Docker keep restarting an app that can't start.
        await docker(["update", "--restart=no", containerName(name)]);
        await docker(["stop", "-t", "2", containerName(name)]);
        await report({ status: "failed", detail: "The app started and then stopped. Its logs say why.", hostPort: port, containerPort: plan.containerPort, logs, buildLog });
        return "The app exited right after starting.";
      }
      await report({ status: "running", detail: `Running on port ${port}.`, hostPort: port, containerPort: plan.containerPort, runtime: plan.runtime, logs, buildLog });
      log(`${name} is running: http://localhost:${port}`);
      return null;
    } catch (e) {
      await report({ status: "failed", detail: String(e.message ?? e).slice(0, 500), buildLog });
      return String(e.message ?? e);
    } finally {
      this.busy.delete(appId);
    }
  }

  async lifecycle(task) {
    const { appId } = task.payload;
    if (this.native.has(appId)) {
      if (task.type === "remove") {
        await this.native.remove(appId);
        log("Removed an app.");
        return null;
      }
      if (task.type === "stop") await this.native.stop(appId);
      else {
        if (task.type === "restart") await this.native.stop(appId, false);
        await this.native.start(appId);
      }
      const [r] = this.native.report(true).filter((x) => x.id === appId);
      await this.api.report(appId, r);
      return r.status === "failed" ? "The app stopped with an error." : null;
    }
    const c = await containerFor(appId);
    if (!c) {
      if (task.type === "remove") return null;
      await this.api.report(appId, { status: "missing", detail: "The app's container isn't on this computer any more. Redeploy it to bring it back." });
      return "The container doesn't exist.";
    }
    if (task.type === "remove") {
      await docker(["rm", "-f", c.container]);
      if (c.name) await docker(["rmi", imageName(c.name)]);
      rmSync(path.join(APPS_DIR, appId), { recursive: true, force: true });
      log(`Removed ${c.name || appId}.`);
      return null;
    }
    const r = await docker(task.type === "start" ? ["start", c.container] : [task.type, "-t", "5", c.container]);
    if (r.code !== 0) return tail(r.out, 1000);
    const now = await containerFor(appId);
    await this.api.report(appId, {
      status: now?.running ? "running" : "stopped",
      detail: now?.running ? `Running on port ${c.hostPort}.` : "Stopped. Start it again whenever you like.",
      ...(now?.running ? { logs: await containerLogs(c.container) } : {}),
    });
    return null;
  }

  /** A bucket's files changed: tell CloudLab its counts. */
  reportBucket(bucket) {
    // At most once per half second, also while files keep changing.
    if (this.bucketReports.has(bucket)) return;
    this.bucketReports.set(
      bucket,
      setTimeout(async () => {
        this.bucketReports.delete(bucket);
        const attributes = await this.s3.report(bucket).catch(() => null);
        if (attributes) await this.api.reportResource(bucket, { attributes });
      }, 500),
    );
  }

  /** Writes local services' pending changes to disk (they're batched for speed). */
  flushLocal() {
    for (const host of [this.tables, this.queues]) {
      try {
        host?.flush();
      } catch (e) {
        console.error("Couldn't save local data:", e.message);
      }
    }
  }

  /**
   * Services whose resources are records in CloudLab and data on this computer:
   * their store, their routes in CloudLab, and what to call them in messages.
   */
  localServices() {
    return [
      { kind: "dynamodb", host: this.tables, route: "/api/agent/dynamodb/tables", noun: "Table", spec: (r) => r.table },
      { kind: "sqs", host: this.queues, route: "/api/agent/sqs/queues", noun: "Queue", spec: (r) => r.queue },
    ].filter((x) => x.host);
  }

  /** CloudLab created, changed or deleted a table or queue on this computer. */
  handleLocalResource(r) {
    const svc = this.localServices().find((x) => x.kind === r.kind);
    if (!svc) throw new Error(`${r.kind} isn't running on this computer.`);
    const spec = svc.spec(r);
    if (r.op.startsWith("delete-")) {
      svc.host.remove(spec.name);
      log(`${svc.noun} ${spec.name} deleted.`);
      return;
    }
    const isNew = !svc.host.has(spec.name);
    const res = svc.host.upsert(spec);
    if (isNew) log(`${svc.noun} ${res.name} ready (${svc.host.pathOf(res.name)}).`);
    this.reportLocal(svc.kind, res.name);
  }

  /**
   * A table's or queue's data changed: tell CloudLab its counts (never the data).
   * At most once per half second, also while changes keep coming.
   */
  reportLocal(kind, name) {
    const key = `${kind}:${name}`;
    if (this.localReports.has(key)) return;
    this.localReports.set(
      key,
      setTimeout(async () => {
        this.localReports.delete(key);
        const svc = this.localServices().find((x) => x.kind === kind);
        const attributes = svc?.host.report(name);
        if (!attributes) return;
        await this.api.reportResource(svc.host.byName(name).id, { attributes });
      }, 500),
    );
  }

  /** Calls CloudLab for the AWS endpoint, turning its errors into the service's own. */
  async viaCloudLab(pathname, body, method = "POST") {
    try {
      return await this.api.post(pathname, body, method);
    } catch (e) {
      throw new EngineError(e.code ?? "InternalServerError", e.message, e.status && e.status < 500 ? e.status : 500);
    }
  }

  /** Starts the API the console uses for this computer's S3 files, and the buckets' websites. */
  async startLocal(config) {
    this.localApi = new LocalApi(this.s3, { key: config.localKey, origin: new URL(config.server).origin, onChange: (b) => this.reportBucket(b) });
    const port = await this.localApi.start();
    if (!port) log("Couldn't open the local API (ports 4510–4529 are all in use): S3 files on this computer won't show in the console.");

    // The AWS endpoint: AWS SDKs and the AWS CLI talk to CloudLab's services here, signed with this computer's keys.
    const keys = { [config.awsAccessKeyId]: config.awsSecretAccessKey };
    const createBucket = async (name) => {
      try {
        await this.api.post("/api/agent/s3/buckets", { name });
      } catch (e) {
        throw new AwsError(e.code ?? "InternalError", e.message, e.status ?? 500, { BucketName: name });
      }
      // Usable right away; CloudLab's own create-bucket task follows with the settings.
      if (!this.s3.meta.buckets[name]) this.s3.createBucket({ name, versioning: "Disabled", blockPublicAccess: true, publicRead: false, websiteEnabled: false, indexDocument: null, errorDocument: null });
    };
    const deleteBucket = async (name) => {
      try {
        await this.api.post(`/api/agent/s3/buckets/${encodeURIComponent(name)}`, {}, "DELETE");
      } catch (e) {
        throw new AwsError(e.code ?? "InternalError", e.message, e.status ?? 500, { BucketName: name });
      }
      this.s3.deleteBucket(name);
    };
    this.tables = new FileTableHost(path.join(HOME, "dynamodb"), (t) => this.reportLocal("dynamodb", t.name));
    const dynamodb = new DynamoApi(this.tables, {
      createTable: async (cfg) => this.tables.upsert(await this.viaCloudLab("/api/agent/dynamodb/tables", { config: cfg })),
      updateTable: async (t, patch) => this.tables.upsert(await this.viaCloudLab(`/api/agent/dynamodb/tables/${encodeURIComponent(t.name)}`, { config: patch }, "PATCH")),
      deleteTable: async (t) => {
        await this.viaCloudLab(`/api/agent/dynamodb/tables/${encodeURIComponent(t.name)}`, {}, "DELETE");
        this.tables.remove(t.name);
      },
    });
    this.localApi.dynamodb = dynamodb;

    this.queues = new FileQueueHost(path.join(HOME, "sqs"), (q) => this.reportLocal("sqs", q.name));
    const queueRoute = (q) => `/api/agent/sqs/queues/${encodeURIComponent(q.name)}`;
    const sqs = new SqsApi(this.queues, {
      createQueue: async (cfg) => this.queues.upsert(await this.viaCloudLab("/api/agent/sqs/queues", { config: cfg })),
      updateQueue: async (q, patch) => this.queues.upsert(await this.viaCloudLab(queueRoute(q), { config: patch }, "PATCH")),
      deleteQueue: async (q) => {
        await this.viaCloudLab(queueRoute(q), {}, "DELETE");
        this.queues.remove(q.name);
      },
      urlOf: (q) => `http://localhost:${this.aws?.port ?? AWS_PORT}/${q.id.split("/").at(-2)}/${q.name}`,
    });
    this.localApi.sqs = sqs;

    this.aws = new AwsEndpoint({
      keys: () => keys,
      services: { s3: new S3Api(this.s3, { createBucket, deleteBucket, onChange: (b) => this.reportBucket(b), owner: config.awsAccessKeyId }), dynamodb, sqs },
    });
    const awsPort = await this.aws.start();
    if (awsPort) log(`AWS endpoint for SDKs and the AWS CLI: http://localhost:${awsPort} (S3, DynamoDB and SQS)`);
    else log(`Couldn't open the AWS endpoint: port ${AWS_PORT} is in use by another program.`);
    this.localApi.credentials = () =>
      awsPort ? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey, endpoint: `http://localhost:${awsPort}`, lanEndpoint: lanAddress() ? `http://${lanAddress()}:${awsPort}` : null, region: "local-1" } : null;
    await this.s3.restore();
  }

  /**
   * After the first check-in (so deletes queued while this computer was off are done
   * first): tell CloudLab about every bucket on this computer, counting files added to
   * the folders by hand, and add buckets the account doesn't have yet (made before
   * this computer was connected to it).
   */
  async syncLocalResources() {
    for (const svc of this.localServices()) {
      for (const name of svc.host.names()) {
        const res = svc.host.byName(name);
        try {
          await this.api.post(`/api/agent/resources/${encodeURIComponent(res.id)}`, { attributes: svc.host.report(name) });
        } catch (e) {
          if (e.code !== "ResourceNotFound") {
            log(`Couldn't report ${svc.noun.toLowerCase()} ${name}:`, e.message);
            continue;
          }
          try {
            svc.host.upsert(await this.api.post(svc.route, { config: res.config }));
            log(`${svc.noun} ${name} is on this computer but wasn't in your CloudLab account, so it was added.`);
            this.reportLocal(svc.kind, name);
          } catch (e2) {
            log(`${svc.noun} ${name} is on this computer but couldn't be added to your CloudLab account: ${e2.message}`);
          }
        }
      }
    }
  }

  async syncBuckets() {
    for (const name of Object.keys(this.s3.meta.buckets)) {
      const attributes = await this.s3.report(name).catch(() => null);
      if (!attributes) continue;
      try {
        await this.api.post(`/api/agent/resources/${encodeURIComponent(name)}`, { attributes });
      } catch (e) {
        if (e.code !== "ResourceNotFound") {
          log(`Couldn't report bucket ${name}:`, e.message);
          continue;
        }
        try {
          await this.api.post("/api/agent/s3/buckets", { name });
          log(`Bucket ${name} is on this computer but wasn't in your CloudLab account, so it was added (private).`);
          this.reportBucket(name);
        } catch (e2) {
          log(`Bucket ${name} is on this computer but couldn't be added to your CloudLab account: ${e2.message}`);
        }
      }
    }
  }

  async handle(task) {
    if (task.type === "resource") {
      const r = task.payload.resource;
      log(`${r.kind.toUpperCase()} ${r.op} ${r.spec?.name ?? r.id}`);
      let error = null;
      try {
        if (r.kind === "ec2") await this.ec2.handle(r);
        else if (r.kind === "s3") await this.s3.handle(r, this.api);
        else if (r.kind === "dynamodb" || r.kind === "sqs") this.handleLocalResource(r);
      } catch (e) {
        error = String(e.message ?? e);
        log(`  failed: ${error}`);
      }
      await this.api.finish(task.id, error ? "failed" : "done", error ?? undefined);
      return;
    }
    log(`Task: ${task.type}${task.payload.name ? ` ${task.payload.name}` : ""}`);
    const error = task.type === "deploy" ? await this.deploy(task) : await this.lifecycle(task);
    await this.api.finish(task.id, error ? "failed" : "done", error ?? undefined);
    if (error) log(`  failed: ${error.split("\n")[0]}`);
  }

  /** One check-in: report the computer and its apps, and do whatever work comes back. */
  async tick() {
    const base = await computerInfo();
    const info = {
      ...base,
      lanIp: lanAddress(),
      gateway: base.docker.ok ? this.gateway.state : this.nativeGateway.state,
      localApi: this.localApi?.port ? { port: this.localApi.port, key: this.localApi.key, awsPort: this.aws?.port ?? null } : null,
    };
    const found = info.docker.ok ? await inventory() : null;
    const withLogs = Date.now() - this.lastLogs > LOGS_EVERY_MS;
    if (withLogs) this.lastLogs = Date.now();
    const apps = [];
    for (const c of found ?? []) {
      if (this.busy.has(c.id)) continue;
      apps.push({
        id: c.id,
        ...appState(c),
        hostPort: c.hostPort,
        containerPort: c.containerPort,
        runtime: c.runtime,
        ...(withLogs && c.running ? { logs: await containerLogs(c.container) } : {}),
      });
    }
    for (const a of this.native.report(withLogs)) if (!this.busy.has(a.id)) apps.push(a);
    const { tasks, routes = [] } = await this.api.sync({ info, apps, complete: found !== null && this.busy.size === 0 });
    for (const t of tasks) await this.handle(t);
    if (!this.bucketsSynced) {
      this.bucketsSynced = true;
      await this.syncBuckets();
      await this.syncLocalResources();
    }
    try {
      if (info.docker.ok) await this.gateway.update(routes, this.native.targets());
      else await this.nativeGateway.update(routes, this.native.targets());
    } catch (e) {
      log("Gateway:", e.message);
    }
  }
}

// ---------- command line ----------

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(c) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (command === "disconnect") {
    rmSync(CONFIG, { force: true });
    console.log("Disconnected. Your apps' containers are still in Docker; delete them from CloudLab (or with docker rm) if you don't need them.");
    return;
  }

  if (command === "status") {
    const found = await inventory();
    if (!found) return console.log("Docker isn't running.");
    if (!found.length) return console.log("No CloudLab apps on this computer.");
    for (const c of found) console.log(`${c.name.padEnd(32)} ${c.running ? "running" : "stopped"}  http://localhost:${c.hostPort}`);
    return;
  }

  let config = readConfig();
  if (command === "connect") {
    const token = rest.find((a) => a.startsWith("cla_"));
    if (!token) {
      console.error("Usage: node cloudlab-agent.mjs connect <token> [--server https://…]\nCopy the full command from CloudLab → Local mode → Connect my computer.");
      process.exitCode = 1;
      return;
    }
    config = { server: flag("server") ?? DEFAULT_SERVER, token };
    saveConfig(config);
  } else if (command) {
    console.error(`Unknown command '${command}'. Use connect, status or disconnect, or nothing to run the agent.`);
    process.exitCode = 1;
    return;
  }
  if (!config && process.stdin.isTTY) {
    // Started by double-click (the downloaded app): ask for the connect code.
    console.log("CloudLab agent: run your CloudLab apps on this computer.\n");
    console.log("In CloudLab, open Local mode and click Connect my computer. Copy the connect code (it starts with cla_).");
    const answer = (await ask("Paste the connect code here and press Enter: ")).trim();
    const token = /cla_[\w-]{20,}/.exec(answer)?.[0];
    if (!token) {
      console.error("That doesn't look like a connect code.");
      process.exitCode = 1;
      return;
    }
    config = { server: /--server\s+(\S+)/.exec(answer)?.[1] ?? DEFAULT_SERVER, token };
    saveConfig(config);
    console.log("Connected. Next time, just open the agent again.\n");
  }
  if (!config) {
    console.error("This computer isn't connected yet. In CloudLab, open Local mode, click Connect my computer and run the command it shows.");
    process.exitCode = 1;
    return;
  }

  if (!config.localKey || !config.awsAccessKeyId) {
    config.localKey ??= randomBytes(24).toString("base64url");
    // This computer's keys for AWS SDKs and the AWS CLI (they never leave it).
    const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    config.awsAccessKeyId ??= `CLAK${[...randomBytes(16)].map((b) => alnum[b % 32]).join("")}`;
    config.awsSecretAccessKey ??= randomBytes(30).toString("base64").replace(/[+/=]/g, "x");
    saveConfig(config);
  }
  const agent = new Agent(new Api(config.server, config.token));
  await agent.startLocal(config);
  const info = await computerInfo();
  console.log(`CloudLab agent ${AGENT_VERSION} on ${info.hostname} (${info.platform}, ${info.cpus} CPUs, ${(info.memTotal / 2 ** 30).toFixed(1)} GB RAM)`);
  console.log(info.docker.ok ? `Docker ${info.docker.version} is ready.` : `${info.docker.error}`);
  console.log(`Connected to ${config.server}. Leave this window open; press Ctrl+C to stop.`);
  console.log(`Your own projects go in ${WORKSPACE} (one folder per project).\n`);

  await agent.native.restore();
  // Apps run without Docker live as long as the agent: close them with it.
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    // Tables and queues keep recent changes in memory for a moment: write them out first.
    agent.flushLocal();
    agent.native.stopAll();
    agent.nativeGateway.stop();
    process.exit(0);
  };
  for (const sig of IS_WINDOWS ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, close);
  process.on("exit", () => {
    if (!closing) {
      agent.flushLocal();
      agent.native.stopAll();
    }
  });
  let failures = 0;
  for (;;) {
    try {
      await agent.tick();
      if (failures) log("Back in touch with CloudLab.");
      failures = 0;
    } catch (e) {
      if (e.status === 401) {
        console.error(`\n${e.message}`);
        process.exitCode = 1;
        return;
      }
      if (failures++ === 0) log(`Can't reach CloudLab (${e.message}). Retrying…`);
    }
    await sleep(failures ? Math.min(30_000, POLL_MS * 2 ** Math.min(failures, 4)) : POLL_MS);
  }
}

// Only run when started as a program (or as the downloaded app), not when imported by tests.
const isMain = import.meta.main ?? (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    console.error(`The CloudLab agent needs Node.js 18 or newer (this is ${process.versions.node}).`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  main(args)
    .catch((e) => {
      console.error(e?.message ?? e);
      process.exitCode = 1;
    })
    .finally(async () => {
      // A double-clicked window would vanish before the message could be read.
      if (process.exitCode && args.length === 0 && process.stdin.isTTY) await ask("\nPress Enter to close.");
    });
}

// For tests.
export { SAMPLE_FILES, containerName, copyProject, imageName };

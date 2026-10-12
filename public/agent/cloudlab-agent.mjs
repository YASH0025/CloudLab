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
 * Needs Node.js 18 or newer and Docker. No npm packages.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_VERSION = "0.4.0";
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

  async post(pathname, body) {
    const res = await fetch(this.server + pathname, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message ?? `CloudLab answered ${res.status}`);
      err.status = res.status;
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
    this.nativeGateway = new NativeGateway();
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

  async handle(task) {
    log(`Task: ${task.type}${task.payload.name ? ` ${task.payload.name}` : ""}`);
    const error = task.type === "deploy" ? await this.deploy(task) : await this.lifecycle(task);
    await this.api.finish(task.id, error ? "failed" : "done", error ?? undefined);
    if (error) log(`  failed: ${error.split("\n")[0]}`);
  }

  /** One check-in: report the computer and its apps, and do whatever work comes back. */
  async tick() {
    const base = await computerInfo();
    const info = { ...base, lanIp: lanAddress(), gateway: base.docker.ok ? this.gateway.state : this.nativeGateway.state };
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

  const agent = new Agent(new Api(config.server, config.token));
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
    agent.native.stopAll();
    agent.nativeGateway.stop();
    process.exit(0);
  };
  for (const sig of IS_WINDOWS ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, close);
  process.on("exit", () => {
    if (!closing) agent.native.stopAll();
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

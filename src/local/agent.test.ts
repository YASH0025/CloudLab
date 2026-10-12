import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The agent is plain JavaScript that runs on the learner's computer; these test its pure parts.
import { Script } from "node:vm";
import { appState, copyProject, detect, dockerDesktopCommand, GATEWAY_JS, lanAddress, projectFolders, SAMPLE_FILES } from "../../public/agent/cloudlab-agent.mjs";

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(path.join(tmpdir(), "cl-agent-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    writeFileSync(path.join(d, name), content);
  }
  return d;
};

describe("agent", () => {
  it("works out how to run a project", () => {
    expect(detect(dir({ Dockerfile: "FROM nginx:alpine\nEXPOSE 8081\n" }))).toMatchObject({ runtime: "Dockerfile", containerPort: 8081, dockerfile: null });
    const node = detect(dir({ "package.json": JSON.stringify({ scripts: { start: "node app.js", build: "tsc" } }) }));
    expect(node).toMatchObject({ runtime: "Node.js 22", containerPort: 3000 });
    expect(node?.dockerfile).toContain("RUN npm run build");
    expect(node?.dockerfile).toContain('CMD ["npm","start"]');
    expect(detect(dir({ "package.json": JSON.stringify({ main: "server.js" }) }))?.dockerfile).toContain('CMD ["node","server.js"]');
    expect(detect(dir({ "requirements.txt": "flask", "main.py": "" }))?.dockerfile).toContain('CMD ["python", "main.py"]');
    expect(detect(dir({ "index.html": "<h1>hi</h1>" }))).toMatchObject({ runtime: "nginx (static site)", containerPort: 80 });
    expect(detect(dir({ "notes.txt": "hi" }))).toBeNull();
  });

  it("ships samples that each know how to run", () => {
    for (const files of Object.values(SAMPLE_FILES)) expect(detect(dir(files as Record<string, string>))).not.toBeNull();
  });

  it("lists project folders in the CloudLab folder, creating it with a note", () => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), "cl-ws-")), "CloudLab");
    expect(projectFolders(root)).toEqual([]);
    expect(readdirSync(root)).toEqual(["README.txt"]);
    mkdirSync(path.join(root, "my-site"));
    mkdirSync(path.join(root, ".hidden"));
    expect(projectFolders(root)).toEqual(["my-site"]);
  });

  it("copies a project without node_modules, .git or links that lead elsewhere", () => {
    const root = dir({ "site/index.html": "hi", "site/node_modules/x/index.js": "", "site/.git/HEAD": "", "secret/key": "s3cret" });
    symlinkSync(path.join(root, "secret"), path.join(root, "site", "escape"));
    const out = path.join(mkdtempSync(path.join(tmpdir(), "cl-out-")), "src");
    copyProject("site", out, root);
    expect(readdirSync(out)).toEqual(["index.html"]);
    expect(() => copyProject("../secret", out, root)).toThrow("Invalid folder name");
    expect(() => copyProject("nope", out, root)).toThrow("There's no folder nope");
  });

  it("reads a crashed container as failed, a stopped one as stopped", () => {
    expect(appState({ running: true, hostPort: 8080 })).toMatchObject({ status: "running" });
    expect(appState({ running: false, state: "exited", exitCode: 0 })).toMatchObject({ status: "stopped" });
    expect(appState({ running: false, state: "exited", exitCode: 143 })).toMatchObject({ status: "stopped" });
    expect(appState({ running: false, state: "exited", exitCode: 1 })).toEqual({ status: "failed" });
    expect(appState({ running: false, state: "restarting" })).toMatchObject({ status: "failed" });
  });

  it("ships gateway code that compiles", () => {
    expect(() => new Script(GATEWAY_JS)).not.toThrow();
  });

  it("finds the computer's home network address, not Docker's or a VPN's", () => {
    const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal }) as never;
    expect(
      lanAddress({
        lo: [v4("127.0.0.1", true)],
        docker0: [v4("172.17.0.1")],
        utun3: [v4("10.8.0.2")],
        "Wi-Fi": [v4("192.168.1.23")],
      }),
    ).toBe("192.168.1.23");
    expect(lanAddress({ eth0: [v4("10.0.0.5")] })).toBe("10.0.0.5");
    expect(lanAddress({ lo: [v4("127.0.0.1", true)] })).toBeNull();
  });

  it("knows how to start Docker Desktop on each system", () => {
    const programFiles = mkdtempSync(path.join(tmpdir(), "cl-pf-"));
    expect(dockerDesktopCommand("win32", { ProgramFiles: programFiles } as never)).toBeNull();
    const exe = path.join(programFiles, "Docker", "Docker", "Docker Desktop.exe");
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, "");
    expect(dockerDesktopCommand("win32", { ProgramFiles: programFiles } as never)).toEqual({ cmd: exe, args: [] });
    expect(dockerDesktopCommand("darwin")).toEqual({ cmd: "open", args: ["-a", "Docker"] });
    expect(dockerDesktopCommand("linux")).toEqual({ cmd: "systemctl", args: ["--user", "start", "docker-desktop"] });
  });
});

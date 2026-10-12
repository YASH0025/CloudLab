"use client";

import { formatDistanceToNowStrict } from "date-fns";
import {
  CheckIcon,
  CopyIcon,
  CpuIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GlobeIcon,
  KeyRoundIcon,
  FolderIcon,
  GitBranchIcon,
  LaptopIcon,
  Loader2Icon,
  PackageIcon,
  PlugZapIcon,
  RocketIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDeployLocal, useDisconnectComputer, useLocal, useLocalAction, usePairComputer, useSetDomain } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { localCredentials } from "@/lib/objects-backend";
import {
  AGENT_DOWNLOADS,
  AGENT_RELEASE,
  deployInput,
  domainSchema,
  SAMPLES,
  type AgentInfo,
  type AgentView,
  type AppAction,
  type LocalApp,
  type RunMode,
  type SampleId,
} from "@/local/types";
import { cn } from "@/lib/utils";
import { StateBadge } from "./state-badge";

type Os = (typeof AGENT_DOWNLOADS)[number]["os"];

/** The visitor's operating system, best guess, so the right download is offered first. */
function guessOs(): Os {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac-arm";
  if (/aarch64|arm64/i.test(ua) && /Linux/i.test(ua)) return "linux-arm";
  if (/Linux/i.test(ua)) return "linux";
  return "windows";
}

const noSubscribe = () => () => undefined;
const useOs = () => useSyncExternalStore(noSubscribe, guessOs, () => "windows" as Os);
const useOrigin = () => useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

function CopyText({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("relative min-w-0", className)}>
      <pre className="overflow-x-auto rounded-md bg-muted py-2 pr-9 pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{text}</pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute top-1 right-1 size-6"
        aria-label="Copy"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          )
        }
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      {error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Something went wrong."}
    </p>
  );
}

// ---------- connecting the computer ----------

/** How to start the agent with a connect code, per operating system. */
function startCommand(os: Os, file: string, token: string, origin: string) {
  const server = origin && !origin.includes("cloud-lab-livid.vercel.app") ? ` --server ${origin}` : "";
  if (os === "windows") return `& "$env:USERPROFILE\\Downloads\\${file}" connect ${token}${server}`;
  const mac = os.startsWith("mac") ? ` && xattr -d com.apple.quarantine ~/Downloads/${file} 2>/dev/null` : "";
  return `chmod +x ~/Downloads/${file}${mac}; ~/Downloads/${file} connect ${token}${server}`;
}

function ConnectSteps({ token, agent }: { token: string | null; agent: AgentView | null }) {
  const detected = useOs();
  const origin = useOrigin();
  const [os, setOs] = useState<Os | null>(null);
  const chosen = os ?? detected;
  const download = AGENT_DOWNLOADS.find((d) => d.os === chosen)!;
  const pair = usePairComputer();
  const code = token ?? pair.data?.token ?? null;

  return (
    <ol className="space-y-5 text-sm">
      <li className="space-y-1.5">
        <p className="font-medium">1. Install Docker</p>
        <p className="text-muted-foreground">
          Your apps run in Docker containers. Install{" "}
          <a className="text-primary hover:underline" href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">
            Docker Desktop
          </a>{" "}
          (Windows, macOS) or Docker Engine (Linux), and start it.
        </p>
      </li>
      <li className="space-y-2">
        <p className="font-medium">2. Download the CloudLab agent</p>
        <p className="text-muted-foreground">A small program that runs your apps and talks to CloudLab. It never lets CloudLab into your computer: it only asks CloudLab for work.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm">
            <a href={`${AGENT_RELEASE}/${download.file}`}>
              <DownloadIcon /> Download for {download.label}
            </a>
          </Button>
          <Select value={chosen} onValueChange={(v) => setOs(v as Os)}>
            <SelectTrigger className="h-8 w-56" aria-label="Operating system">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_DOWNLOADS.map((d) => (
                <SelectItem key={d.os} value={d.os}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          Have Node.js 18+? You can use{" "}
          <a className="text-primary hover:underline" href="/agent/cloudlab-agent.mjs" download>
            cloudlab-agent.mjs
          </a>{" "}
          instead: <span className="font-mono">node cloudlab-agent.mjs connect &lt;code&gt;</span>.
        </p>
      </li>
      <li className="space-y-2">
        <p className="font-medium">3. Connect it</p>
        {!code ? (
          <>
            <p className="text-muted-foreground">Get a connect code for this computer. It works for this account only{agent ? ", and replaces the computer connected now" : ""}.</p>
            <Button size="sm" variant={agent ? "outline" : "default"} onClick={() => pair.mutate()} disabled={pair.isPending}>
              {pair.isPending ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} {agent ? "Connect a different computer" : "Connect my computer"}
            </Button>
            <ErrorLine error={pair.error} />
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              {chosen === "windows"
                ? "Double-click the downloaded file and paste this code when it asks. (If Windows says it protected your PC: More info → Run anyway.)"
                : "Open a terminal and run this (it makes the download runnable, then connects):"}
            </p>
            {chosen === "windows" ? <CopyText text={code} /> : <CopyText text={startCommand(chosen, download.file, code, origin)} />}
            {chosen === "windows" && (
              <p className="text-xs text-muted-foreground">
                Or from PowerShell: <span className="font-mono break-all">{startCommand(chosen, download.file, code, origin)}</span>
              </p>
            )}
            <p className="text-xs text-muted-foreground">The code is shown only once. Keep the agent&apos;s window open while you use Local mode; this page turns green when it&apos;s connected.</p>
          </>
        )}
      </li>
    </ol>
  );
}

function ComputerCard() {
  const { data } = useLocal();
  const disconnect = useDisconnectComputer();
  const [reconnect, setReconnect] = useState(false);
  const agent = data?.agent ?? null;
  const info = agent?.info;

  if (!agent || !agent.lastSeenAt || reconnect) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LaptopIcon className="size-4" /> Connect your computer
          </CardTitle>
          <CardDescription>Three steps, once. After that, open the agent whenever you want to use Local mode.</CardDescription>
        </CardHeader>
        <CardContent className="pb-5">
          <ConnectSteps token={null} agent={agent} />
          {reconnect && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => setReconnect(false)}>
              Cancel
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <LaptopIcon className="size-4" /> {info?.hostname ?? agent.name}
            <Badge variant={agent.online ? "success" : "secondary"}>
              <span className="size-1.5 rounded-full bg-current" />
              {agent.online ? "Online" : "Offline"}
            </Badge>
          </CardTitle>
          <CardDescription>
            {agent.online
              ? "The agent is running on this computer and picks up work within a few seconds."
              : `Last seen ${formatDistanceToNowStrict(new Date(agent.lastSeenAt!), { addSuffix: true })}. Open the CloudLab agent on the computer to bring it back.`}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setReconnect(true)}>
            <PlugZapIcon /> Connect another
          </Button>
          <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            <UnplugIcon /> Disconnect
          </Button>
        </div>
      </CardHeader>
      {info && (
        <CardContent className="grid gap-4 pb-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">System</p>
            <p>
              {{ win32: "Windows", darwin: "macOS", linux: "Linux" }[info.platform] ?? info.platform} · {info.arch}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Processor</p>
            <p className="flex items-center gap-1.5">
              <CpuIcon className="size-3.5 text-muted-foreground" /> {info.cpus} cores
            </p>
            <p className="truncate text-xs text-muted-foreground" title={info.cpuModel}>
              {info.cpuModel}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Memory</p>
            <p>
              {gb(info.memFree)} free of {gb(info.memTotal)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Docker</p>
            {info.docker.ok ? (
              <p className="text-success">Ready · {info.docker.version}</p>
            ) : (
              <p className="flex items-start gap-1.5">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" /> Not available
              </p>
            )}
          </div>
          {!info.docker.ok && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm sm:col-span-2 lg:col-span-4">
              <p className="font-medium">Running without Docker</p>
              <p className="text-muted-foreground">{info.docker.error}</p>
              <p className="mt-1 text-muted-foreground">
                Without Docker, apps run straight on this computer: static sites and Node.js apps work as they are, Python apps if Python is installed. Code from
                GitHub only runs if it&apos;s a static site, and projects with their own Dockerfile need Docker.
              </p>
            </div>
          )}
          {info.workspace && (
            <div className="sm:col-span-2 lg:col-span-4">
              <p className="text-xs text-muted-foreground">Your projects folder</p>
              <p className="font-mono text-xs break-all">{info.workspace}</p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------- AWS SDK and CLI access ----------

const MASK = "••••••••••••••••••••••••••••••••••••••••";

function sdkExamples(endpoint: string) {
  return {
    node: `// npm install @aws-sdk/client-s3
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "local-1",
  endpoint: "${endpoint}",
  forcePathStyle: true, // bucket name in the path: ${endpoint}/my-bucket/key
  // keys come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
});

await s3.send(new PutObjectCommand({ Bucket: "my-bucket", Key: "hello.txt", Body: "Hello!" }));
const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: "my-bucket" }));
console.log(Contents.map((o) => o.Key));`,
    python: `# pip install boto3
import boto3

s3 = boto3.client("s3", region_name="local-1", endpoint_url="${endpoint}")
# keys come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY

s3.put_object(Bucket="my-bucket", Key="hello.txt", Body=b"Hello!")
for o in s3.list_objects_v2(Bucket="my-bucket").get("Contents", []):
    print(o["Key"])`,
    cli: `aws s3 mb s3://my-bucket --endpoint-url ${endpoint}
aws s3 cp ./photo.jpg s3://my-bucket/photos/ --endpoint-url ${endpoint}
aws s3 ls s3://my-bucket --recursive --endpoint-url ${endpoint}
aws s3 sync ./site s3://my-bucket --endpoint-url ${endpoint}`,
  };
}

function keysCommand(os: Os, id: string, secret: string) {
  if (os === "windows") return `$env:AWS_ACCESS_KEY_ID="${id}"\n$env:AWS_SECRET_ACCESS_KEY="${secret}"\n$env:AWS_REGION="local-1"`;
  return `export AWS_ACCESS_KEY_ID=${id}\nexport AWS_SECRET_ACCESS_KEY=${secret}\nexport AWS_REGION=local-1`;
}

/**
 * Keys and an address for using the AWS SDKs and the AWS CLI against this computer.
 * The keys are read from the agent itself (http://127.0.0.1), so they stay on this computer.
 */
function SdkAccessCard({ info }: { info: AgentInfo }) {
  const os = useOs();
  const [show, setShow] = useState(false);
  const api = info.localApi;
  const creds = useQuery({
    queryKey: ["local-credentials", api?.port, api?.key],
    queryFn: () => localCredentials(api!),
    enabled: !!api?.awsPort,
    staleTime: Infinity,
    retry: 1,
  });

  let body: React.ReactNode;
  if (!api || api.awsPort === undefined) {
    body = <p className="text-muted-foreground">Your agent is too old for this. Download the latest agent above and start it again.</p>;
  } else if (api.awsPort === null) {
    body = (
      <p className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" /> The agent couldn&apos;t open port 4566 because another program is using it (LocalStack,
        maybe). Close that program and restart the agent.
      </p>
    );
  } else if (creds.isLoading) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (creds.error || !creds.data) {
    body = <ErrorLine error={creds.error ?? new Error("The agent didn't return keys.")} />;
  } else {
    const c = creds.data;
    const secret = show ? c.secretAccessKey : MASK;
    const ex = sdkExamples(c.endpoint);
    body = (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Endpoint (this computer)</p>
            <CopyText text={c.endpoint} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Endpoint (other devices on the same Wi-Fi)</p>
            {c.lanEndpoint ? <CopyText text={c.lanEndpoint} /> : <p className="py-2 text-muted-foreground">Not on a network right now.</p>}
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Access key ID</p>
            <CopyText text={c.accessKeyId} />
          </div>
          <div className="space-y-1">
            <p className="flex items-center justify-between text-xs text-muted-foreground">
              Secret access key
              <button type="button" className="text-primary hover:underline" onClick={() => setShow((s) => !s)}>
                {show ? "Hide" : "Show"}
              </button>
            </p>
            <CopyText text={secret} />
          </div>
        </div>
        <div className="space-y-1">
          <p className="font-medium">1. Put the keys in your terminal</p>
          <p className="text-xs text-muted-foreground">
            Or run <span className="font-mono">aws configure</span> once with them, and region <span className="font-mono">local-1</span>.
            {!show && " Click Show above to copy the real secret."}
          </p>
          <CopyText text={keysCommand(os, c.accessKeyId, secret)} />
        </div>
        <div className="space-y-1">
          <p className="font-medium">2. Point your code at {c.endpoint}</p>
          <Tabs defaultValue="node">
            <TabsList>
              <TabsTrigger value="node">Node.js</TabsTrigger>
              <TabsTrigger value="python">Python</TabsTrigger>
              <TabsTrigger value="cli">AWS CLI</TabsTrigger>
            </TabsList>
            <TabsContent value="node">
              <CopyText text={ex.node} />
            </TabsContent>
            <TabsContent value="python">
              <CopyText text={ex.python} />
            </TabsContent>
            <TabsContent value="cli">
              <CopyText text={ex.cli} />
            </TabsContent>
          </Tabs>
        </div>
        <p className="text-xs text-muted-foreground">
          Works today: S3 (buckets, uploads, downloads, multipart, copy, presigned URLs). Buckets your code creates show up in the S3 console under My computer
          (local). Keep the secret to yourself: anyone with it, on your network, can use these buckets.
        </p>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" /> Use AWS SDKs and the AWS CLI
        </CardTitle>
        <CardDescription>
          The agent answers AWS&apos;s own APIs on this computer, so code written for AWS works here: just set the endpoint. Same requests, same errors, and your files
          stay on this computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-5 text-sm">{body}</CardContent>
    </Card>
  );
}

// ---------- deploying ----------

type SourceKind = "sample" | "github" | "folder";

function DeployCard() {
  const { data } = useLocal();
  const deploy = useDeployLocal();
  const [kind, setKind] = useState<SourceKind>("sample");
  const [name, setName] = useState("");
  const [sample, setSample] = useState<SampleId>("static-site");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [folder, setFolder] = useState("");
  const [port, setPort] = useState("");
  const [domain, setDomain] = useState("");
  const [mode, setMode] = useState<RunMode>("auto");
  const [invalid, setInvalid] = useState<string | null>(null);
  const agent = data?.agent;
  const folders = agent?.info?.folders ?? [];
  const connected = !!agent?.lastSeenAt;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setInvalid(null);
    const source = kind === "sample" ? { type: "sample", sample } : kind === "github" ? { type: "github", repo, branch } : { type: "folder", folder };
    const parsed = deployInput.safeParse({ name, source, hostPort: port || undefined, domain, mode });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }
    deploy.mutate(parsed.data, {
      onSuccess: () => {
        setName("");
        setDomain("");
      },
    });
  };

  const tabs: { kind: SourceKind; label: string; Icon: typeof PackageIcon }[] = [
    { kind: "sample", label: "Sample app", Icon: PackageIcon },
    { kind: "github", label: "GitHub repository", Icon: GitBranchIcon },
    { kind: "folder", label: "A folder on my computer", Icon: FolderIcon },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RocketIcon className="size-4" /> Deploy an app
        </CardTitle>
        <CardDescription>
          The agent gets the code, builds a Docker image (with your Dockerfile, or one it writes for Node.js, Python or a static site) and runs it. Each app gets
          its own port on your computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-5">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Where the code comes from">
            {tabs.map(({ kind: k, label, Icon }) => (
              <Button key={k} type="button" role="tab" aria-selected={kind === k} size="sm" variant={kind === k ? "secondary" : "ghost"} onClick={() => setKind(k)}>
                <Icon /> {label}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <div className="space-y-1.5">
              <Label htmlFor="app-name">App name</Label>
              <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-site" autoComplete="off" />
              <p className="text-xs text-muted-foreground">Lowercase letters, numbers and hyphens.</p>
            </div>

            {kind === "sample" && (
              <div className="space-y-1.5">
                <Label htmlFor="app-sample">Sample</Label>
                <Select value={sample} onValueChange={(v) => setSample(v as SampleId)}>
                  <SelectTrigger id="app-sample" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SAMPLES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{SAMPLES.find((s) => s.id === sample)?.description}</p>
              </div>
            )}

            {kind === "github" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="app-repo">Public repository</Label>
                  <Input id="app-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/owner/repo" autoComplete="off" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-branch">Branch (optional)</Label>
                  <Input id="app-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" />
                </div>
              </>
            )}

            {kind === "folder" && (
              <div className="space-y-1.5">
                <Label htmlFor="app-folder">Project folder</Label>
                <Select value={folder} onValueChange={setFolder} disabled={folders.length === 0}>
                  <SelectTrigger id="app-folder" className="w-full">
                    <SelectValue placeholder={folders.length ? "Choose a folder" : "No folders yet"} />
                  </SelectTrigger>
                  <SelectContent>
                    {folders.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Folders inside <span className="font-mono">{agent?.info?.workspace ?? "CloudLab"}</span> on your computer. Copy a project there and it shows up here
                  within a few seconds.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="app-mode">Run with</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as RunMode)}>
                <SelectTrigger id="app-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto: Docker if it&apos;s running, else without</SelectItem>
                  <SelectItem value="docker">Docker</SelectItem>
                  <SelectItem value="native">Without Docker</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {mode === "docker"
                  ? agent?.info?.docker.ok === false
                    ? "Docker isn't running on your computer right now: this deploy would fail. Start Docker first, or pick Without Docker."
                    : "The app runs in a container, isolated from the rest of your computer: the way clouds run apps."
                  : mode === "native"
                    ? "The app runs straight on your computer: static sites, Node.js, and Python if it's installed. Code from GitHub only if it's a static site."
                    : agent?.info?.docker.ok
                      ? "Docker is running, so the app will run in a container."
                      : "Docker isn't running, so the app will run straight on your computer."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="app-domain">Name on your network (optional)</Label>
              <Input id="app-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="myshop.home" autoComplete="off" />
              <p className="text-xs text-muted-foreground">Open the app as http://myshop.home from your phone and other devices on the same Wi-Fi.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="app-port">Port (optional)</Label>
              <Input id="app-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="Picked for you, from 8080" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!connected || deploy.isPending}>
              {deploy.isPending ? <Loader2Icon className="animate-spin" /> : <RocketIcon />} Deploy
            </Button>
            {!connected && <span className="text-sm text-muted-foreground">Connect your computer first.</span>}
          </div>
          {invalid ? <p className="text-sm text-destructive">{invalid}</p> : <ErrorLine error={deploy.error} />}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------- the apps ----------

const ACTIONS: Record<LocalApp["status"], AppAction[]> = {
  queued: ["delete"],
  downloading: ["delete"],
  building: ["delete"],
  starting: ["delete"],
  running: ["stop", "restart", "redeploy", "delete"],
  stopped: ["start", "redeploy", "delete"],
  failed: ["redeploy", "delete"],
  missing: ["redeploy", "delete"],
};

const ACTION_LABEL: Record<AppAction, string> = { start: "Start", stop: "Stop", restart: "Restart", redeploy: "Redeploy", delete: "Delete" };
const BUSY = ["queued", "downloading", "building", "starting"];

function sourceLabel(app: LocalApp) {
  const s = app.source;
  if (s.type === "sample") return SAMPLES.find((x) => x.id === s.sample)?.label ?? s.sample;
  if (s.type === "folder") return `Folder ${s.folder}`;
  return `${s.repo.replace("https://github.com/", "")}${s.branch ? ` (${s.branch})` : ""}`;
}

function Logs({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">{title}</summary>
      <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-[#0d1117] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#c9d1d9]">{text}</pre>
    </details>
  );
}

/** The app's name on the home network: shown as a link, editable in place. */
function DomainLine({ app, gateway }: { app: LocalApp; gateway: AgentInfo["gateway"] }) {
  const set = useSetDomain(app.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(app.domain ?? "");
  const [invalid, setInvalid] = useState<string | null>(null);
  const port = gateway?.httpPort && gateway.httpPort !== 80 ? `:${gateway.httpPort}` : "";

  const save = (domain: string | null) => {
    setInvalid(null);
    if (domain !== null) {
      const parsed = domainSchema.safeParse(domain);
      if (!parsed.success) return setInvalid(parsed.error.issues[0]?.message ?? "Not a valid name.");
      domain = parsed.data;
    }
    set.mutate(domain, { onSuccess: () => setEditing(false) });
  };

  if (editing) {
    return (
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          save(value.trim() || null);
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Name on your network" value={value} onChange={(e) => setValue(e.target.value)} placeholder="myshop.home" className="h-8 w-56" autoFocus />
          <Button type="submit" size="sm" disabled={set.isPending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
        {invalid ? <p className="text-sm text-destructive">{invalid}</p> : <ErrorLine error={set.error} />}
      </form>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <GlobeIcon className="size-3.5 text-muted-foreground" />
      {app.domain ? (
        <a className="font-mono text-primary hover:underline" href={`http://${app.domain}${port}`} target="_blank" rel="noreferrer">
          {app.domain}
          {port}
        </a>
      ) : (
        <span className="text-muted-foreground">No name on your network</span>
      )}
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => (setValue(app.domain ?? ""), setEditing(true))}>
        {app.domain ? "Change" : "Add a name"}
      </Button>
      {app.domain && (
        <Button size="sm" variant="ghost" className="h-7 px-2" disabled={set.isPending} onClick={() => save(null)}>
          Remove
        </Button>
      )}
    </p>
  );
}

/** One way to open the app: the address as a link, with a copy button. */
function AddressLine({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="w-full text-xs text-muted-foreground sm:w-52">{label}</span>
      <a className="font-mono text-primary hover:underline" href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={`Copy ${url}`}
        onClick={() =>
          navigator.clipboard?.writeText(url).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          )
        }
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </p>
  );
}

function AppCard({ app, gateway, lanIp }: { app: LocalApp; gateway: AgentInfo["gateway"]; lanIp: string | null }) {
  const action = useLocalAction();
  const busy = BUSY.includes(app.status);
  return (
    <Card className="gap-3 py-4">
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {app.name}
              <StateBadge state={app.status} pending={busy ? app.status : null} />
            </p>
            <p className="text-xs text-muted-foreground">
              {sourceLabel(app)}
              {app.runtime ? ` · ${app.runtime}` : ""}
              {app.hostPort ? ` · port ${app.hostPort}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {app.url && (
              <Button asChild size="sm">
                <a href={app.url} target="_blank" rel="noreferrer">
                  Open <ExternalLinkIcon />
                </a>
              </Button>
            )}
            {ACTIONS[app.status].map((a) => (
              <Button key={a} size="sm" variant={a === "delete" ? "ghost" : "outline"} disabled={action.isPending} onClick={() => action.mutate({ id: app.id, action: a })}>
                {ACTION_LABEL[a]}
              </Button>
            ))}
          </div>
        </div>
        {app.detail && <p className={cn("text-sm", app.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{app.detail}</p>}
        {app.url && (
          <div className="space-y-1">
            <AddressLine label="On the computer running the agent" url={app.url} />
            {lanIp && app.hostPort && <AddressLine label="On other devices on the same Wi-Fi" url={`http://${lanIp}:${app.hostPort}`} />}
          </div>
        )}
        <DomainLine app={app} gateway={gateway} />
        <div className="space-y-2">
          <Logs title="App logs" text={app.logs} />
          <Logs title="Build log" text={app.buildLog} />
        </div>
      </CardContent>
    </Card>
  );
}

/** How to use app names on other devices: the gateway's state and the DNS setting to change. */
function NetworkCard({ info, apps }: { info: AgentInfo | null | undefined; apps: LocalApp[] }) {
  const named = apps.filter((a) => a.domain);
  if (named.length === 0 || !info) return null;
  const gw = info.gateway;
  const ip = info.lanIp;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GlobeIcon className="size-4" /> Use your app names on other devices
          {gw && (
            <Badge variant={gw.running ? "success" : "destructive"}>
              <span className="size-1.5 rounded-full bg-current" />
              {gw.running ? "Gateway running" : "Gateway not running"}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          The agent runs a small DNS server on this computer: it answers {named.map((a) => a.domain).join(", ")} with this computer&apos;s address
          {ip ? ` (${ip})` : ""}, and passes every other name on to the internet as usual. Devices on the same network that use it as their DNS server can open
          your apps by name. Nothing is reachable from outside your network.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-5 text-sm">
        {gw?.error && (
          <p className="flex items-start gap-2">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" /> {gw.error}
          </p>
        )}
        {!gw && <p className="text-muted-foreground">Starting the gateway… (the first time, the agent builds it, which takes a minute.)</p>}
        {ip && gw?.dns && (
          <div className="grid gap-4 md:grid-cols-3 [&>*]:min-w-0">
            <div className="space-y-1">
              <p className="font-medium">Phone or tablet</p>
              <p className="text-muted-foreground">
                Wi-Fi settings → your network → DNS → Manual. Add <span className="font-mono">{ip}</span> as the DNS server.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">Another computer</p>
              <p className="text-muted-foreground">
                Network settings → your connection → DNS servers: <span className="font-mono">{ip}</span>.
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">Every device at once</p>
              <p className="text-muted-foreground">
                In your router&apos;s settings (DHCP), set the DNS server to <span className="font-mono">{ip}</span>. Turn it back if you switch this computer off.
              </p>
            </div>
          </div>
        )}
        {ip && (
          <p className="text-xs text-muted-foreground">
            On this computer itself, either point its DNS at {ip} too, or add a line like <span className="font-mono">127.0.0.1 {named[0].domain}</span> to its hosts file.
            If {ip} changes (a different network, or the router hands out a new address), update the DNS settings.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Local mode: run real apps on the learner's own computer, with CloudLab as the remote control. */
export function LocalView() {
  const { data, isLoading } = useLocal();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Local mode</h1>
        <p className="text-sm text-muted-foreground">
          Run real apps on your own computer with Docker, using its CPU, memory and disk. CloudLab is the remote control: nothing is billed, and nothing leaves your
          computer except status and logs.
        </p>
      </div>
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <ComputerCard />
          <DeployCard />
          {data?.agent?.online && data.agent.info && <SdkAccessCard info={data.agent.info} />}
          <NetworkCard info={data?.agent?.info} apps={data?.apps ?? []} />
          {data && data.apps.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-medium">Your apps ({data.apps.length})</h2>
              {data.apps.map((a) => (
                <AppCard key={a.id} app={a} gateway={data.agent?.info?.gateway ?? null} lanIp={data.agent?.info?.lanIp ?? null} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

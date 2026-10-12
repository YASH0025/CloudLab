"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { ChevronDownIcon, ChevronRightIcon, CodeIcon, FlaskConicalIcon, GlobeIcon, Loader2Icon, PlusIcon, RocketIcon, SendIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceDTO } from "@/engine/types";
import { queryKeys, useInvoke, usePermission, useResources, useUpdateResource } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { CodeEditor } from "./code-editor";

// ---------- function ----------

interface Invocation {
  requestId: string;
  at: string;
  source: string;
  status: "Succeeded" | "Failed" | "Timed out";
  durationMs: number;
  billedDurationMs: number;
  initDurationMs?: number;
  errorType?: string;
  logs: string[];
}

interface Statement {
  Sid: string;
  Principal: { Service?: string; AWS?: string };
  Condition?: { ArnLike?: { "AWS:SourceArn": string } };
}

const TEST_EVENTS: Record<string, { label: string; event: unknown }> = {
  hello: { label: "hello-world", event: { key1: "value1", key2: "value2", key3: "value3" } },
  http: {
    label: "API Gateway HTTP API (GET /hello?name=Ada)",
    event: {
      version: "2.0",
      routeKey: "GET /hello",
      rawPath: "/hello",
      rawQueryString: "name=Ada",
      headers: { accept: "*/*", "user-agent": "curl/8.7.1" },
      queryStringParameters: { name: "Ada" },
      requestContext: { http: { method: "GET", path: "/hello", sourceIp: "198.51.100.23" }, routeKey: "GET /hello", stage: "$default" },
      isBase64Encoded: false,
    },
  },
  post: {
    label: "API Gateway HTTP API (POST /orders with JSON)",
    event: {
      version: "2.0",
      routeKey: "POST /orders",
      rawPath: "/orders",
      rawQueryString: "",
      headers: { "content-type": "application/json" },
      requestContext: { http: { method: "POST", path: "/orders", sourceIp: "198.51.100.23" }, routeKey: "POST /orders", stage: "$default" },
      body: JSON.stringify({ item: "coffee", quantity: 2 }),
      isBase64Encoded: false,
    },
  },
};

const STATUS_VARIANT = { Succeeded: "success", Failed: "destructive", "Timed out": "warning" } as const;

export function FunctionPanel({ fn }: { fn: ResourceDTO }) {
  return (
    <>
      {/* A new deployment (from here, the CLI or another tab) resets the editor to the deployed code. */}
      <CodeCard key={String(fn.attributes.revisionId ?? "")} fn={fn} />
      <TestCard fn={fn} />
      <InvocationsCard fn={fn} />
      <PolicyCard fn={fn} />
    </>
  );
}

function CodeCard({ fn }: { fn: ResourceDTO }) {
  const deployed = (fn.config.files as Record<string, string>) ?? {};
  const [files, setFiles] = useState(deployed);
  const update = useUpdateResource(fn.id);
  const dirty = JSON.stringify(files) !== JSON.stringify(deployed);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <CodeIcon className="size-4" /> Code
          </CardTitle>
          <CardDescription>
            Handler <span className="font-mono">{String(fn.config.handler)}</span> runs the export named after the dot, from the file named before it. Changes
            take effect when you deploy.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <Badge variant="warning">Changes not deployed</Badge>}
          <Button size="sm" onClick={() => update.mutate({ files })} disabled={!dirty || update.isPending}>
            {update.isPending ? <Loader2Icon className="animate-spin" /> : <RocketIcon />} Deploy
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pb-5">
        <CodeEditor value={files} onChange={setFiles} />
        <p className="mt-2 text-xs text-muted-foreground">
          Nuvora runs your code for real in a sandbox: plain JavaScript and your own files work; packages (npm, the AWS SDK) and network calls don&apos;t
          yet. setTimeout runs on simulated time.
        </p>
      </CardContent>
    </Card>
  );
}

function TestCard({ fn }: { fn: ResourceDTO }) {
  const invoke = useInvoke(fn.id);
  const [template, setTemplate] = useState("hello");
  const [text, setText] = useState(JSON.stringify(TEST_EVENTS.hello.event, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const r = invoke.data;
  const active = fn.state === "Active";

  const run = () => {
    try {
      const event = JSON.parse(text);
      setParseError(null);
      invoke.mutate(event);
    } catch (e) {
      setParseError(`The event isn't valid JSON: ${(e as Error).message}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConicalIcon className="size-4" /> Test
        </CardTitle>
        <CardDescription>Run the deployed code with an event, the JSON your handler receives as its first argument.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 space-y-1.5">
            <Label htmlFor="test-template">Event template</Label>
            <Select
              value={template}
              onValueChange={(v) => {
                setTemplate(v);
                setText(JSON.stringify(TEST_EVENTS[v].event, null, 2));
              }}
            >
              <SelectTrigger id="test-template" aria-label="Event template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TEST_EVENTS).map(([k, t]) => (
                  <SelectItem key={k} value={k}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={run} disabled={invoke.isPending || !active}>
            {invoke.isPending ? <Loader2Icon className="animate-spin" /> : <FlaskConicalIcon />} Test
          </Button>
          {!active && <span className="text-xs text-muted-foreground">The function is {fn.state}; wait until it&apos;s Active.</span>}
        </div>
        <textarea
          aria-label="Test event JSON"
          spellCheck={false}
          rows={Math.min(14, Math.max(5, text.split("\n").length + 1))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        {parseError && <p className="text-sm text-destructive">{parseError}</p>}
        {invoke.error && (
          <p className="text-sm text-destructive">
            {invoke.error instanceof ApiError ? `${invoke.error.code}: ` : ""}
            {invoke.error.message}
          </p>
        )}
        {r && (
          <div className={cn("space-y-3 rounded-md border p-3", r.functionError ? "border-destructive/50 bg-destructive/5" : "border-success/40 bg-success/5")}>
            <p className={cn("text-sm font-medium", r.functionError ? "text-destructive" : "text-success")}>
              Execution result: {r.timedOut ? "timed out" : r.functionError ? "failed" : "succeeded"}
            </p>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Response</p>
              <pre className="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-xs">{JSON.stringify(r.payload, null, 2)}</pre>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Duration</dt>
                <dd className="font-mono">{r.durationMs.toFixed(2)} ms</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Billed duration</dt>
                <dd className="font-mono">{r.billedDurationMs} ms</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Max memory used</dt>
                <dd className="font-mono">
                  {r.maxMemoryUsedMb} MB of {String(fn.config.memorySize)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Init duration</dt>
                <dd className="font-mono">{r.initDurationMs !== undefined ? `${r.initDurationMs.toFixed(2)} ms (cold start)` : "– (warm)"}</dd>
              </div>
            </dl>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Log output</p>
              <pre className="max-h-64 overflow-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed">{r.logs.join("\n")}</pre>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">Request ID {r.requestId}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InvocationsCard({ fn }: { fn: ResourceDTO }) {
  const items = (fn.attributes.invocations as Invocation[] | undefined) ?? [];
  const metrics = (fn.attributes.metrics as { invocations?: number; errors?: number; durationMs?: number } | undefined) ?? {};
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent invocations</CardTitle>
        <CardDescription>
          {metrics.invocations
            ? `${metrics.invocations} invocation${metrics.invocations === 1 ? "" : "s"}, ${metrics.errors ?? 0} error${metrics.errors === 1 ? "" : "s"}, average ${((metrics.durationMs ?? 0) / metrics.invocations).toFixed(1)} ms. `
            : ""}
          Every call, from the Test button, the CLI or an API, with its log: what CloudWatch Logs would show for /aws/lambda/{fn.name}.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-5">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not invoked yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((i) => (
              <li key={i.requestId} className="text-sm">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => setOpen(open === i.requestId ? null : i.requestId)}
                >
                  {open === i.requestId ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                  <Badge variant={STATUS_VARIANT[i.status]}>{i.status}</Badge>
                  <span className="text-xs text-muted-foreground">from {i.source}</span>
                  {i.errorType && <span className="font-mono text-xs text-destructive">{i.errorType}</span>}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {i.durationMs.toFixed(1)} ms{i.initDurationMs !== undefined ? " · cold" : ""} · {formatDistanceToNowStrict(new Date(i.at), { addSuffix: true })}
                  </span>
                </button>
                {open === i.requestId && <pre className="overflow-auto bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed">{i.logs.join("\n")}</pre>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PolicyCard({ fn }: { fn: ResourceDTO }) {
  const statements = (fn.attributes.permissions as Statement[] | undefined) ?? [];
  const apis = useResources("apigateway", "api");
  const { add, remove } = usePermission(fn.id);
  const [apiId, setApiId] = useState<string>("");
  const account = fn.id.split(":")[4];
  const choices = apis.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4" /> Resource-based policy
        </CardTitle>
        <CardDescription>
          Who else may invoke this function. Your execution role says what the function may do; this policy says who may call it. API Gateway needs a statement
          here, or every request returns 500.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-5">
        {statements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No statements: only you (through the console, CLI or SDK) can invoke it.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Statement ID</TableHead>
                  <TableHead>Principal</TableHead>
                  <TableHead>Source ARN</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {statements.map((s) => (
                  <TableRow key={s.Sid}>
                    <TableCell className="font-mono text-xs">{s.Sid}</TableCell>
                    <TableCell className="font-mono text-xs">{s.Principal.Service ?? s.Principal.AWS}</TableCell>
                    <TableCell className="font-mono text-xs break-all whitespace-normal">{s.Condition?.ArnLike?.["AWS:SourceArn"] ?? "any"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" aria-label={`Remove ${s.Sid}`} onClick={() => remove.mutate(s.Sid)} disabled={remove.isPending}>
                        <Trash2Icon className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 space-y-1.5">
            <Label htmlFor="perm-api">Allow an API to invoke this function</Label>
            <Select value={apiId} onValueChange={setApiId}>
              <SelectTrigger id="perm-api" aria-label="API to allow">
                <SelectValue placeholder={choices.length ? "Choose an API" : "No APIs in this region yet"} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} ({a.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={!apiId || add.isPending}
            onClick={() =>
              add.mutate({
                statementId: `apigateway-${apiId}-${Math.random().toString(36).slice(2, 6)}`,
                principal: "apigateway.amazonaws.com",
                sourceArn: `arn:aws:execute-api:${fn.region}:${account}:${apiId}/*`,
              })
            }
          >
            <PlusIcon /> Add permission
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- API ----------

interface RequestLog {
  at: string;
  requestId: string;
  method: string;
  path: string;
  routeKey: string | null;
  stage: string | null;
  status: number;
  latencyMs: number;
  reason?: string;
}

const statusVariant = (s: number) => (s < 300 ? "success" : s < 500 ? "warning" : "destructive");

export function ApiPanel({ api }: { api: ResourceDTO }) {
  const routesQ = useResources("apigateway", "route");
  const integrationsQ = useResources("apigateway", "integration");
  const stagesQ = useResources("apigateway", "stage");
  const functions = useResources("lambda", "function");
  const qc = useQueryClient();
  const myRoutes = (routesQ.data ?? []).filter((r) => r.config.apiId === api.id);
  const myIntegrations = (integrationsQ.data ?? []).filter((i) => i.config.apiId === api.id);
  const myStages = (stagesQ.data ?? []).filter((s) => s.config.apiId === api.id);
  // Rendered only in the browser, after the API has loaded.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const base = `${origin}/apigw/${api.id}`;
  const urlFor = (stage: string) => (stage === "$default" ? base : `${base}/${stage}`);
  const requests = (api.attributes.recentRequests as RequestLog[] | undefined) ?? [];

  const firstPath = useMemo(() => {
    const k = myRoutes.map((r) => String(r.config.routeKey)).find((key) => key !== "$default");
    return k ? k.split(" ")[1].replace(/\{(\w+)\+?\}/g, "example") : "/";
  }, [myRoutes]);
  const [method, setMethod] = useState("GET");
  const [stage, setStage] = useState<string>("");
  const [path, setPath] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<{ status: number; type: string; reason: string | null; body: string; ms: number } | null>(null);
  const chosenStage = stage || myStages[0]?.name || "$default";

  const send = async () => {
    setSending(true);
    const started = performance.now();
    try {
      const res = await fetch(`${urlFor(chosenStage)}${path ?? firstPath}`, {
        method,
        headers: body && method !== "GET" ? { "content-type": "application/json" } : undefined,
        body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
      });
      setResponse({
        status: res.status,
        type: res.headers.get("content-type") ?? "",
        reason: res.headers.get("x-cloudlab-reason"),
        body: await res.text(),
        ms: Math.round(performance.now() - started),
      });
    } catch (e) {
      setResponse({ status: 0, type: "", reason: String(e), body: "", ms: 0 });
    } finally {
      setSending(false);
      qc.invalidateQueries({ queryKey: queryKeys.resource(api.id) });
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GlobeIcon className="size-4" /> Invoke URL
          </CardTitle>
          <CardDescription>
            Your API really answers at this address: open it in a browser, call it with curl, or from any app. (On AWS it would be {String(api.attributes.apiEndpoint)}.)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 pb-5">
          {myStages.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
              <span>Nothing is deployed: the API needs a stage. $default serves it at the root of the address.</span>
              <Button asChild size="sm" variant="outline">
                <Link href={routes.createPrefilled("apigateway", "stage", { apiId: api.id, name: "$default" })}>Create $default stage</Link>
              </Button>
            </div>
          ) : (
            myStages.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary" className="font-mono">
                  {s.name}
                </Badge>
                <a href={urlFor(s.name)} target="_blank" rel="noreferrer" className="font-mono text-xs break-all text-primary hover:underline">
                  {urlFor(s.name)}
                </a>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Routes</CardTitle>
            <CardDescription>Each route sends matching requests to an integration (a Lambda function). $default catches everything else.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={routes.createPrefilled("apigateway", "integration", { apiId: api.id })}>
                <PlusIcon /> Integration
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={routes.createPrefilled("apigateway", "route", { apiId: api.id, integrationId: myIntegrations[0]?.id })}>
                <PlusIcon /> Route
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pb-5">
          {myRoutes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No routes yet. Add an integration (which function to call), then a route like GET /hello that uses it.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {myRoutes.map((r) => {
                const integ = myIntegrations.find((i) => i.id === r.config.integrationId);
                const fn = (functions.data ?? []).find((f) => f.name === integ?.config.functionName);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <Link href={routes.detail("apigateway", "route", r.id)} className="font-mono text-primary hover:underline">
                      {String(r.config.routeKey)}
                    </Link>
                    <span className="text-muted-foreground">→</span>
                    {integ ? (
                      fn ? (
                        <Link href={routes.detail("lambda", "function", fn.id)} className="text-primary hover:underline">
                          λ {fn.name}
                        </Link>
                      ) : (
                        <span className="text-destructive">function {String(integ.config.functionName)} (missing)</span>
                      )
                    ) : (
                      <span className="text-destructive">no integration</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SendIcon className="size-4" /> Try it
          </CardTitle>
          <CardDescription>Sends a real HTTP request to the invoke URL from your browser.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pb-5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28 space-y-1.5">
              <Label htmlFor="try-method">Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="try-method" aria-label="Method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {myStages.length > 1 && (
              <div className="w-32 space-y-1.5">
                <Label htmlFor="try-stage">Stage</Label>
                <Select value={chosenStage} onValueChange={setStage}>
                  <SelectTrigger id="try-stage" aria-label="Stage">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {myStages.map((s) => (
                      <SelectItem key={s.id} value={s.name}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="try-path">Path and query</Label>
              <Input id="try-path" className="font-mono" value={path ?? firstPath} onChange={(e) => setPath(e.target.value)} />
            </div>
            <Button onClick={send} disabled={sending || myStages.length === 0}>
              {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />} Send
            </Button>
          </div>
          {method !== "GET" && (
            <textarea
              aria-label="Request body"
              placeholder='{"item": "coffee"}'
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          )}
          {response && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={statusVariant(response.status)}>{response.status || "failed"}</Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {response.type} · {response.ms} ms
                </span>
              </div>
              {response.reason && (
                <p className="rounded bg-warning/10 px-2 py-1.5 text-sm">
                  <span className="font-medium">Why: </span>
                  {response.reason}
                </p>
              )}
              <pre className="max-h-64 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{response.body || "(empty body)"}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent requests</CardTitle>
          <CardDescription>Like API Gateway&apos;s access log, plus why a request failed when it did.</CardDescription>
        </CardHeader>
        <CardContent className="pb-5">
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>When</TableHead>
                    <TableHead>Request</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Why</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((r) => (
                    <TableRow key={r.requestId}>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDistanceToNowStrict(new Date(r.at), { addSuffix: true })}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.method} {r.path}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.routeKey ?? "–"}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="max-w-md text-xs whitespace-normal">{r.reason ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

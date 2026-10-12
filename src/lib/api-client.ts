import type { ResolvedServiceDef, ResourceDTO } from "@/engine/types";
import type { Region } from "@/engine/catalog";
import type { ReachabilityInput, ReachabilityResult } from "@/engine/analysis/reachability";
import type { Advice, TutorialInfo, TutorialView } from "@/guide/types";
import type { Diagram } from "@/guide/diagram";
import type { Evaluation } from "@/engine/iam/policy";
import type { AgentView, AppAction, DeployInput, LocalApp, LocalStatus } from "@/local/types";
import { useConsoleStore } from "@/stores/console-store";

export type QueueActionInput =
  | { action: "send"; body: string; delaySeconds?: number; attributes: Record<string, { DataType: string; StringValue: string }> }
  | { action: "receive"; maxNumberOfMessages: number; visibilityTimeout?: number }
  | { action: "delete"; receiptHandle: string }
  | { action: "purge" }
  | { action: "subscribe"; topicArn: string };

export type TableItemsInput =
  | { action: "scan"; indexName?: string; limit?: number }
  | {
      action: "query";
      indexName?: string;
      partitionValue: string | number;
      sort?: { op: "=" | "<" | "<=" | ">" | ">=" | "begins_with" | "between"; value: string | number; value2?: string | number };
      forward?: boolean;
      limit?: number;
    }
  | { action: "put"; item: Record<string, unknown>; mustBeNew?: boolean }
  | { action: "delete"; key: Record<string, unknown> }
  | { action: "statement"; statement: string };

export interface TableItemsResult {
  items?: Record<string, unknown>[];
  count?: number;
  scannedCount?: number;
  more?: boolean;
  expression?: string;
  ranAs?: string;
  index?: string;
  translated?: { keyCondition?: string; filter?: string; update?: string; condition?: string };
}

export interface MetricQuery {
  id: string;
  namespace: string;
  name: string;
  dimensions: { Name: string; Value: string }[];
  stat: "Average" | "Sum" | "Minimum" | "Maximum" | "SampleCount";
  period?: number;
}

export interface MetricSeries {
  id: string;
  period: number;
  unit: string | null;
  simulated: boolean;
  points: { t: number; v: number }[];
}

export interface DnsTestResult {
  dns: {
    question: { name: string; type: string };
    status: "NOERROR" | "NXDOMAIN" | "SERVFAIL";
    answers: { name: string; type: string; ttl: number; value: string }[];
    authority: { name: string; type: string; ttl: number; value: string }[];
    steps: string[];
    zoneId: string | null;
  };
  http?: { ok: true; status: number; statusText: string; servedBy: string; contentType: string | null; body: string } | { ok: false; error: string; reason: string };
}

export interface LearnerProgress {
  tutorials: Record<string, { steps: number; total: number; completedAt?: string }>;
  challenges: Record<string, { score: number; seconds: number; hints: number; at: string }>;
}

export interface ChallengeInfo {
  id: string;
  title: string;
  level: "beginner" | "intermediate" | "advanced";
  minutes: number;
  summary: string;
}

export interface ChallengeView extends ChallengeInfo {
  region: string;
  story: string;
  goal: string;
  facts: string[];
  tools: string[];
  hints: string[];
  hintCount: number;
  solved: boolean;
  explanation?: string;
  status?: string;
}

export interface IamPolicyOption {
  name: string;
  arn: string;
  description: string;
  managed: boolean;
}

export interface SimulateResponse {
  result: Evaluation;
  policies: { name: string; arn: string; via: string }[];
}
import type { ObjectInfo } from "@/engine/objects";
import type { TargetHealth } from "@/engine/analysis/health";
import type { LoadTestResult } from "@/engine/analysis/loadtest";
import type { DbConnectInput, DbConnectResult } from "@/engine/analysis/dbconnect";
import type { InvokeResult } from "@/engine/lambda/invoke";
import type { PublishResult } from "@/engine/sns/publish";
import type { QueueCounts, ReceivedMessage } from "@/engine/sqs/queue";
import type { PlannedChange } from "@/engine/cloudformation/deploy";

export type { ObjectInfo };

const objectUrl = (bucket: string, key: string) =>
  `/api/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** The IAM identity the console is acting as, sent with every request so permissions apply. */
export function identityHeader(): Record<string, string> {
  const { identity, workspace } = useConsoleStore.getState();
  return { "x-cloudlab-identity": identity || "root", "x-cloudlab-workspace": workspace ?? "lab" };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...identityHeader(), ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(err.code ?? "RequestFailed", err.message ?? res.statusText, res.status, err.details);
  }
  return body as T;
}

export interface ServicesResponse {
  region: string;
  regions: Region[];
  services: ResolvedServiceDef[];
}

export interface MeResponse {
  providers: ("github" | "google")[];
  user: { name: string; email: string; image: string | null } | null;
}

export const api = {
  localStatus: () => request<LocalStatus>(`/api/local`),
  localPair: () => request<{ agent: AgentView; token: string }>(`/api/local/pair`, { method: "POST" }),
  localDisconnect: () => request<void>(`/api/local/pair`, { method: "DELETE" }),
  localDeploy: (input: DeployInput) => request<LocalApp>(`/api/local/apps`, { method: "POST", body: JSON.stringify(input) }),
  localSetDomain: (id: string, domain: string | null) =>
    request<LocalApp>(`/api/local/apps/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ domain }) }),
  localAction: (id: string, action: AppAction) =>
    request<LocalApp | void>(`/api/local/apps/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) }),
  me: () => request<MeResponse>(`/api/me`),

  services: (region: string) => request<ServicesResponse>(`/api/services?region=${encodeURIComponent(region)}`),

  listResources: (filter: { service?: string; type?: string; region?: string }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
    return request<{ items: ResourceDTO[] }>(`/api/resources?${params}`);
  },

  getResource: (id: string) =>
    request<{ item: ResourceDTO; referencedBy: ResourceDTO[] }>(`/api/resources/${encodeURIComponent(id)}`),

  createResource: (input: { service: string; type: string; region: string; config: Record<string, unknown> }) =>
    request<{ item: ResourceDTO }>(`/api/resources`, { method: "POST", body: JSON.stringify(input) }),

  updateResource: (id: string, config: Record<string, unknown>) =>
    request<{ item: ResourceDTO }>(`/api/resources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ config }),
    }),

  deleteResource: (id: string) =>
    request<{ deleted: string }>(`/api/resources/${encodeURIComponent(id)}`, { method: "DELETE" }),

  resetLab: (region: string) =>
    request<{ region: string; removed: number }>(`/api/lab/reset`, { method: "POST", body: JSON.stringify({ region }) }),

  guide: (region: string) => request<{ advice: Advice }>(`/api/guide?region=${encodeURIComponent(region)}`),

  tutorials: () => request<{ tutorials: TutorialInfo[] }>(`/api/guide/tutorials`),

  tutorial: (id: string, region: string) =>
    request<{ tutorial: TutorialView }>(
      `/api/guide/tutorials/${encodeURIComponent(id)}?region=${encodeURIComponent(region)}`,
    ),

  checkReachability: (id: string, input: ReachabilityInput) =>
    request<{ result: ReachabilityResult }>(`/api/resources/${encodeURIComponent(id)}/reachability`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  targetHealth: (id: string) => request<{ targets: TargetHealth[] }>(`/api/resources/${encodeURIComponent(id)}/health`),

  testRequests: (id: string, input: { port?: number; count?: number }) =>
    request<{ result: LoadTestResult }>(`/api/resources/${encodeURIComponent(id)}/test-requests`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  writeVolumeFile: (id: string, input: { path: string; content: string }) =>
    request<{ files: { path: string; content: string; modifiedAt: string }[] }>(`/api/resources/${encodeURIComponent(id)}/files`, { method: "POST", body: JSON.stringify(input) }),

  diagram: (region: string) => request<{ diagram: Diagram }>(`/api/diagram?region=${encodeURIComponent(region)}`),

  progress: () => request<{ progress: LearnerProgress }>(`/api/progress`),
  saveProgress: (
    input: { kind: "tutorial"; id: string; steps: number; total: number } | { kind: "challenge"; id: string; score: number; seconds: number; hints: number },
  ) => request<{ progress: LearnerProgress }>(`/api/progress`, { method: "POST", body: JSON.stringify(input) }),

  challenges: () => request<{ challenges: ChallengeInfo[] }>(`/api/challenges`),
  challenge: (id: string, hints: number) => request<{ challenge: ChallengeView }>(`/api/challenges/${encodeURIComponent(id)}?hints=${hints}`),
  startChallenge: (id: string) => request<{ challenge: ChallengeView }>(`/api/challenges/${encodeURIComponent(id)}`, { method: "POST" }),

  dnsTest: (input: { name: string; type: string; http: boolean; path?: string }) =>
    request<DnsTestResult>(`/api/route53/test`, { method: "POST", body: JSON.stringify(input) }),

  healthCheckStatus: (id: string) => request<{ healthy: boolean; report: string; checkedAt: string }>(`/api/route53/health-checks/${encodeURIComponent(id)}/status`),

  metrics: (input: { region: string; minutes: number; queries: MetricQuery[] }) =>
    request<{ series: MetricSeries[]; from: number; to: number; account: string }>(`/api/metrics/query`, { method: "POST", body: JSON.stringify(input) }),

  logEvents: (q: { region: string; group: string; pattern?: string; stream?: string; minutes?: number }) =>
    request<{ events: { id: number; stream: string; timestamp: number; ingestedAt: number; message: string }[] }>(
      `/api/logs/events?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`,
    ),

  logStreams: (region: string, group: string) =>
    request<{ streams: { stream: string; firstEventTimestamp: number; lastEventTimestamp: number; storedBytes: number }[] }>(
      `/api/logs/streams?region=${encodeURIComponent(region)}&group=${encodeURIComponent(group)}`,
    ),

  publish: (id: string, input: { message: string; subject?: string; messageStructure?: "json"; attributes: Record<string, { DataType: string; StringValue: string }> }) =>
    request<{ result: PublishResult }>(`/api/resources/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify(input) }),

  queueCounts: (id: string) => request<{ counts: QueueCounts }>(`/api/resources/${encodeURIComponent(id)}/messages`),

  queueAction: (id: string, input: QueueActionInput) =>
    request<{ sent?: { MessageId: string }; messages?: ReceivedMessage[]; movedToDlq?: number; subscriptionArn?: string }>(`/api/resources/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  previewChanges: (id: string, input: { templateBody: string; parameters: { key: string; value?: string }[] }) =>
    request<{ changes: PlannedChange[] }>(`/api/resources/${encodeURIComponent(id)}/changes`, { method: "POST", body: JSON.stringify(input) }),

  tableItems: (id: string, input: TableItemsInput) =>
    request<TableItemsResult>(`/api/resources/${encodeURIComponent(id)}/items`, { method: "POST", body: JSON.stringify(input) }),

  confirmSubscription: (id: string) => request<{ subscriptionArn: string }>(`/api/resources/${encodeURIComponent(id)}/confirm`, { method: "POST" }),

  invoke: (id: string, event: unknown) =>
    request<{ result: InvokeResult }>(`/api/resources/${encodeURIComponent(id)}/invoke`, { method: "POST", body: JSON.stringify({ event }) }),

  addPermission: (id: string, input: { statementId: string; principal: string; sourceArn?: string }) =>
    request<{ statement: unknown }>(`/api/resources/${encodeURIComponent(id)}/permissions`, { method: "POST", body: JSON.stringify(input) }),

  removePermission: (id: string, statementId: string) =>
    request<{ removed: string }>(`/api/resources/${encodeURIComponent(id)}/permissions?statementId=${encodeURIComponent(statementId)}`, {
      method: "DELETE",
    }),

  dbConnect: (id: string, input: DbConnectInput) =>
    request<{ result: DbConnectResult }>(`/api/resources/${encodeURIComponent(id)}/db-connect`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listObjects: (bucket: string, prefix: string) =>
    request<{ objects: ObjectInfo[]; prefixes: string[] }>(
      `/api/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}`,
    ),

  /** Uploads raw bytes; the file's own type becomes the object's Content-Type. */
  putObject: (bucket: string, key: string, body: Blob, contentType?: string) =>
    request<{ object: ObjectInfo }>(objectUrl(bucket, key), {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType || body.type || "" },
    }),

  deleteObject: (bucket: string, key: string) => request<{ deleted: boolean }>(objectUrl(bucket, key), { method: "DELETE" }),

  deletePrefix: (bucket: string, prefix: string) =>
    request<{ deleted: string[] }>(`/api/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}`, {
      method: "DELETE",
    }),

  objectDownloadUrl: objectUrl,

  iamPolicies: () => request<{ policies: IamPolicyOption[] }>(`/api/iam/policies`),

  /** Checks an identity before switching to it ("root", "user/dev", "role/admin"). */
  whoami: (identity: string) =>
    request<{ identity: unknown; arn: string }>(`/api/iam/whoami`, { headers: { "x-cloudlab-identity": identity } }),

  simulate: (input: { kind: "user" | "group" | "role"; name: string; action: string; resource: string }) =>
    request<SimulateResponse>(`/api/iam/simulate`, { method: "POST", body: JSON.stringify(input) }),

  /** Lists resources as the root user, for the identity switcher. */
  listAsRoot: (service: string, type: string) =>
    request<{ items: ResourceDTO[] }>(`/api/resources?service=${service}&type=${type}&region=global`, {
      headers: { "x-cloudlab-identity": "root" },
    }),

  runAction: (id: string, action: string) =>
    request<{ item: ResourceDTO }>(`/api/resources/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
};

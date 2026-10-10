import type { ResolvedServiceDef, ResourceDTO } from "@/engine/types";
import type { Region } from "@/engine/catalog";
import type { ReachabilityInput, ReachabilityResult } from "@/engine/analysis/reachability";
import type { Advice, TutorialInfo, TutorialView } from "@/guide/types";
import type { Evaluation } from "@/engine/iam/policy";
import { useConsoleStore } from "@/stores/console-store";

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
  return { "x-cloudlab-identity": useConsoleStore.getState().identity || "root" };
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

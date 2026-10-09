import type { ResolvedServiceDef, ResourceDTO } from "@/engine/types";
import type { Region } from "@/engine/catalog";
import type { ReachabilityInput, ReachabilityResult } from "@/engine/analysis/reachability";
import type { Advice, TutorialInfo, TutorialView } from "@/guide/types";

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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
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

export const api = {
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

  runAction: (id: string, action: string) =>
    request<{ item: ResourceDTO }>(`/api/resources/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
};

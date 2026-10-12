import { api, ApiError, identityHeader, type ObjectInfo } from "@/lib/api-client";

/**
 * Where a bucket's objects live. Buckets in simulated regions keep them on
 * CloudLab's servers; buckets in My computer (local) keep them as files on the
 * learner's computer, where the console talks to the CloudLab agent directly
 * (http://127.0.0.1, with the agent's key), so files never leave that computer.
 */
export interface ObjectsBackend {
  /** Tells query caches apart. */
  id: string;
  list(bucket: string, prefix: string): Promise<{ objects: ObjectInfo[]; prefixes: string[] }>;
  put(bucket: string, key: string, body: Blob, contentType?: string): Promise<{ object: ObjectInfo }>;
  remove(bucket: string, key: string): Promise<unknown>;
  removePrefix(bucket: string, prefix: string): Promise<unknown>;
  download(bucket: string, key: string): Promise<Blob>;
}

export const serverObjects: ObjectsBackend = {
  id: "server",
  list: api.listObjects,
  put: api.putObject,
  remove: api.deleteObject,
  removePrefix: api.deletePrefix,
  async download(bucket, key) {
    // Through fetch, so the request carries the IAM identity being acted as (s3:GetObject is checked).
    const res = await fetch(api.objectDownloadUrl(bucket, key), { headers: identityHeader() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body?.error?.code ?? "DownloadFailed", body?.error?.message ?? res.statusText, res.status);
    }
    return res.blob();
  },
};

export interface LocalApiInfo {
  port: number;
  key: string;
}

const unreachable = () =>
  new ApiError(
    "AgentUnreachable",
    "Can't reach the CloudLab agent on this computer. Is it running here? This bucket's files are on the computer where the agent runs, so open CloudLab on that computer. (If your browser asked to allow access to devices on your network, allow it.)",
    0,
  );

export function localObjects(info: LocalApiInfo): ObjectsBackend {
  const base = `http://127.0.0.1:${info.port}/s3`;
  const path = (bucket: string, key = "") => `${base}/${encodeURIComponent(bucket)}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  const call = async (url: string, init: RequestInit = {}) => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { "x-cloudlab-key": info.key, ...init.headers } });
    } catch {
      throw unreachable();
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body?.error?.code ?? "RequestFailed", body?.error?.message ?? res.statusText, res.status);
    }
    return res;
  };
  return {
    id: `local:${info.port}`,
    async list(bucket, prefix) {
      return (await call(`${path(bucket)}?prefix=${encodeURIComponent(prefix)}&delimiter=%2F`)).json();
    },
    async put(bucket, key, body, contentType) {
      return (await call(path(bucket, key), { method: "PUT", body, headers: { "content-type": contentType || body.type || "binary/octet-stream" } })).json();
    },
    async remove(bucket, key) {
      return call(path(bucket, key), { method: "DELETE" });
    },
    async removePrefix(bucket, prefix) {
      return (await call(`${path(bucket)}?prefix=${encodeURIComponent(prefix)}`, { method: "DELETE" })).json();
    },
    async download(bucket, key) {
      return (await call(path(bucket, key))).blob();
    },
  };
}

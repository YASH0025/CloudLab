import { createHash } from "node:crypto";
import type { Engine } from "./engine";
import { EngineError } from "./errors";
import type { ResourceStore } from "./store";
import type { Resource } from "./types";

/**
 * Objects in buckets: put, get, list, copy and delete with S3's rules and
 * errors, plus static website serving. Each object is a resource (so it counts
 * as a dependency of its bucket and moves with the account); its bytes live in
 * blob storage so listing a bucket never loads file contents.
 */

/** CloudLab's limits. Real S3 allows 5 TB per object; a practice lab doesn't need that. */
export const LIMITS = {
  objectBytes: 1024 * 1024,
  objectsPerBucket: 500,
  accountBytes: 25 * 1024 * 1024,
};

export interface ObjectInfo {
  key: string;
  size: number;
  /** MD5 of the content, hex, like S3's ETag for simple uploads. */
  etag: string;
  contentType: string;
  lastModified: string;
}

const MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  woff2: "font/woff2",
};

/** Guesses a content type from the key's extension, as `aws s3 cp` does. */
export function guessContentType(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "binary/octet-stream";
}

/** Object IDs are derived from bucket and key, so the same key always maps to the same object. */
export function objectId(bucket: string, key: string): string {
  return `obj-${createHash("sha1").update(`${bucket}\n${key}`).digest("hex").slice(0, 17)}`;
}

const info = (r: Resource): ObjectInfo => ({
  key: r.name,
  size: Number(r.attributes.size ?? 0),
  etag: String(r.attributes.etag ?? ""),
  contentType: String(r.config.contentType ?? "binary/octet-stream"),
  lastModified: String(r.attributes.lastModified ?? r.updatedAt),
});

const noSuchKey = () => new EngineError("NoSuchKey", "The specified key does not exist.", 404);

export interface WebsiteResponse {
  status: number;
  contentType: string;
  body: Buffer;
  location?: string;
}

export class ObjectStorage {
  constructor(
    private engine: Engine,
    private store: ResourceStore,
    private now: () => Date,
  ) {}

  /** The account's bucket, or NoSuchBucket. */
  bucket(accountId: string, name: string): Promise<Resource> {
    return this.engine.getTyped(accountId, name, "storage", "bucket");
  }

  private async objectsIn(accountId: string, bucket: string): Promise<Resource[]> {
    const all = await this.store.list(accountId, { service: "storage", type: "object" });
    return all.filter((o) => o.config.bucket === bucket);
  }

  /** Keeps the bucket's object count and size up to date for the console. */
  private async refreshBucket(accountId: string, bucket: Resource) {
    const objects = await this.objectsIn(accountId, bucket.id);
    const current = await this.store.get(accountId, bucket.id);
    if (!current) return;
    await this.store.update({
      ...current,
      attributes: {
        ...current.attributes,
        objectCount: objects.length,
        totalBytes: objects.reduce((n, o) => n + Number(o.attributes.size ?? 0), 0),
      },
    });
  }

  async put(accountId: string, bucketName: string, key: string, data: Buffer, contentType?: string): Promise<ObjectInfo> {
    const bucket = await this.bucket(accountId, bucketName);
    if (!key) throw new EngineError("InvalidArgument", "Object key must not be empty.");
    if (Buffer.byteLength(key) > 1024) throw new EngineError("KeyTooLongError", "Your key is too long");
    if (data.length > LIMITS.objectBytes) {
      throw new EngineError(
        "EntityTooLarge",
        `Your proposed upload exceeds the maximum allowed size (CloudLab allows ${LIMITS.objectBytes / 1024 / 1024} MB per object).`,
      );
    }

    const id = objectId(bucket.id, key);
    const existing = await this.store.get(accountId, id);
    if (!existing) {
      const inBucket = await this.objectsIn(accountId, bucket.id);
      if (inBucket.length >= LIMITS.objectsPerBucket) {
        throw new EngineError(
          "ServiceQuotaExceededException",
          `CloudLab keeps up to ${LIMITS.objectsPerBucket} objects per bucket. Delete some, or use another bucket.`,
        );
      }
    }
    const buckets = await this.store.list(accountId, { service: "storage", type: "bucket" });
    const used = buckets.reduce((n, b) => n + Number(b.attributes.totalBytes ?? 0), 0) - Number(existing?.attributes.size ?? 0);
    if (used + data.length > LIMITS.accountBytes) {
      throw new EngineError(
        "ServiceQuotaExceededException",
        `CloudLab keeps up to ${LIMITS.accountBytes / 1024 / 1024} MB of files per account. Delete some objects first.`,
      );
    }

    const nowIso = this.now().toISOString();
    const attributes = { size: data.length, etag: createHash("md5").update(data).digest("hex"), lastModified: nowIso };
    const config = { bucket: bucket.id, name: key, contentType: contentType || guessContentType(key) };
    await this.store.putBlob(accountId, id, data.toString("base64"));
    if (existing) {
      // S3 has no "already exists": a put replaces the object.
      await this.store.update({ ...existing, config, attributes, updatedAt: nowIso });
    } else {
      await this.store.insert({
        id,
        accountId,
        region: bucket.region,
        service: "storage",
        type: "object",
        name: key,
        state: null,
        pendingState: null,
        transitionAt: null,
        config,
        attributes,
        refs: [bucket.id],
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
    await this.refreshBucket(accountId, bucket);
    return { key, size: data.length, etag: attributes.etag, contentType: config.contentType, lastModified: nowIso };
  }

  async head(accountId: string, bucketName: string, key: string): Promise<ObjectInfo> {
    const bucket = await this.bucket(accountId, bucketName);
    const r = await this.store.get(accountId, objectId(bucket.id, key));
    if (!r) throw noSuchKey();
    return info(r);
  }

  async get(accountId: string, bucketName: string, key: string): Promise<{ info: ObjectInfo; data: Buffer }> {
    const meta = await this.head(accountId, bucketName, key);
    const data = await this.store.getBlob(accountId, objectId(bucketName, key));
    return { info: meta, data: Buffer.from(data ?? "", "base64") };
  }

  /** Keys under `prefix`, grouped into "folders" at `delimiter` like ListObjectsV2. */
  async list(
    accountId: string,
    bucketName: string,
    opts: { prefix?: string; delimiter?: string } = {},
  ): Promise<{ objects: ObjectInfo[]; prefixes: string[] }> {
    const bucket = await this.bucket(accountId, bucketName);
    const prefix = opts.prefix ?? "";
    const objects: ObjectInfo[] = [];
    const prefixes = new Set<string>();
    const items = (await this.objectsIn(accountId, bucket.id)).filter((o) => o.name.startsWith(prefix)).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const o of items) {
      const rest = o.name.slice(prefix.length);
      const cut = opts.delimiter ? rest.indexOf(opts.delimiter) : -1;
      if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + opts.delimiter!.length));
      else objects.push(info(o));
    }
    return { objects, prefixes: [...prefixes].sort() };
  }

  /** Deletes one object. Like S3, deleting a key that doesn't exist succeeds. Returns whether it existed. */
  async delete(accountId: string, bucketName: string, key: string): Promise<boolean> {
    const bucket = await this.bucket(accountId, bucketName);
    const id = objectId(bucket.id, key);
    const existed = !!(await this.store.get(accountId, id));
    if (existed) {
      await this.store.delete(accountId, id);
      await this.store.deleteBlob(accountId, id);
      await this.refreshBucket(accountId, bucket);
    }
    return existed;
  }

  /** Deletes every object under a prefix (all of them by default). Returns the deleted keys. */
  async deleteAll(accountId: string, bucketName: string, prefix = ""): Promise<string[]> {
    const bucket = await this.bucket(accountId, bucketName);
    const doomed = (await this.objectsIn(accountId, bucket.id)).filter((o) => o.name.startsWith(prefix));
    for (const o of doomed) {
      await this.store.delete(accountId, o.id);
      await this.store.deleteBlob(accountId, o.id);
    }
    await this.refreshBucket(accountId, bucket);
    return doomed.map((o) => o.name).sort();
  }

  async copy(accountId: string, from: { bucket: string; key: string }, to: { bucket: string; key: string }): Promise<ObjectInfo> {
    const { info: meta, data } = await this.get(accountId, from.bucket, from.key);
    return this.put(accountId, to.bucket, to.key, data, meta.contentType);
  }

  // ---------- static website hosting ----------

  /**
   * Serves a request to a bucket's website the way S3 website endpoints do:
   * index documents for "folders", a redirect for a folder without its slash,
   * the error document (or S3's own error page) for missing keys, and 403 when
   * the bucket isn't public.
   */
  async website(bucketName: string, path: string): Promise<WebsiteResponse> {
    const bucket = await this.store.getAny(bucketName);
    if (!bucket || bucket.service !== "storage" || bucket.type !== "bucket") {
      return errorPage(404, "NoSuchBucket", "The specified bucket does not exist", { BucketName: bucketName });
    }
    if (!bucket.config.websiteEnabled) {
      return errorPage(404, "NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", {
        BucketName: bucketName,
      });
    }
    if (bucket.config.blockPublicAccess || !bucket.config.publicRead) {
      return errorPage(403, "AccessDenied", "Access Denied", {});
    }
    const account = bucket.accountId;
    const index = String(bucket.config.indexDocument || "index.html");
    const load = async (key: string) => {
      const r = await this.store.get(account, objectId(bucket.id, key));
      if (!r) return null;
      const data = await this.store.getBlob(account, r.id);
      return { info: info(r), data: Buffer.from(data ?? "", "base64") };
    };

    const key = path === "" || path.endsWith("/") ? path + index : path;
    const found = await load(key);
    if (found) return { status: 200, contentType: found.info.contentType, body: found.data };
    if (!path.endsWith("/") && path !== "" && (await load(`${path}/${index}`))) {
      return { status: 302, contentType: "text/plain", body: Buffer.from(""), location: `${path.split("/").pop()}/` };
    }
    const errorKey = bucket.config.errorDocument ? String(bucket.config.errorDocument) : "";
    const custom = errorKey ? await load(errorKey) : null;
    if (custom) return { status: 404, contentType: custom.info.contentType, body: custom.data };
    return errorPage(404, "NoSuchKey", "The specified key does not exist.", { Key: key });
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(status: number, code: string, message: string, extra: Record<string, string>): WebsiteResponse {
  const title = `${status} ${status === 403 ? "Forbidden" : "Not Found"}`;
  const items = [["Code", code], ["Message", message], ...Object.entries(extra)]
    .map(([k, v]) => `<li>${escape(k)}: ${escape(v)}</li>`)
    .join("");
  const html = `<html><head><title>${title}</title></head><body><h1>${title}</h1><ul>${items}</ul><hr/></body></html>`;
  return { status, contentType: "text/html", body: Buffer.from(html) };
}

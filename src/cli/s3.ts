import { EngineError } from "@/engine/errors";
import type { ObjectInfo } from "@/engine/objects";
import type { CliContext, Command } from "./commands";
import { LocalPathError, parseShorthand, UsageError } from "./parse";
import { ownerId } from "./present";

/**
 * S3 commands: the high-level `aws s3` ones (mb, rb, ls, cp, rm, website) and
 * the `aws s3api` ones. Output and error text follow the real CLI, e.g.
 * "upload: index.html to s3://bucket/index.html".
 */

interface S3Path {
  bucket: string;
  key: string;
}

const isS3 = (p: string | undefined) => !!p && p.startsWith("s3://");

function parseS3(uri: string): S3Path {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!m) throw new UsageError(`invalid S3 URI '${uri}'; expected s3://bucket-name/key`);
  return { bucket: m[1], key: m[2] };
}

/** `s3://bucket` with no key, for mb, rb and website. */
function bucketOnly(uri: string | undefined): string {
  if (!uri) throw new UsageError("the following arguments are required: path");
  const p = parseS3(uri);
  if (p.key) throw new UsageError(`${uri} is not a bucket: remove the key part after the bucket name`);
  return p.bucket;
}

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** Contents of a local file the terminal sent with the command. */
function localFile(ctx: CliContext, path: string): Buffer {
  const data = ctx.files?.[path];
  if (data === undefined) throw new LocalPathError(path);
  return Buffer.from(data, "base64");
}

function download(ctx: CliContext, filename: string, data: Buffer, contentType: string) {
  if (ctx.effects) ctx.effects.download = { filename, data: data.toString("base64"), contentType };
}

const objects = (ctx: CliContext) => ctx.engine.objects;

/** "2026-10-10 18:00:00", the CLI's listing timestamp. */
const stamp = (iso: string) => iso.slice(0, 19).replace("T", " ");

function humanSize(n: number): string {
  const units = ["Bytes", "KiB", "MiB", "GiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} Bytes` : `${v.toFixed(1)} ${units[i]}`;
}

const etag = (o: ObjectInfo) => `"${o.etag}"`;

const PUBLIC_READ = (bucket: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "PublicReadGetObject", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` },
    ],
  });

/** Whether a bucket policy grants everyone s3:GetObject on the bucket's objects. */
function grantsPublicRead(policyText: string, bucket: string): boolean {
  let policy: { Statement?: unknown };
  try {
    policy = JSON.parse(policyText);
  } catch {
    throw new EngineError("MalformedPolicy", "Policies must be valid JSON and the first byte must be '{'");
  }
  if (!policy || typeof policy !== "object" || !policy.Statement) {
    throw new EngineError("MalformedPolicy", "Missing required field Statement");
  }
  const list = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  for (const st of list(policy.Statement as Record<string, unknown>[])) {
    for (const r of list(st.Resource as string | string[])) {
      const m = /^arn:(?:aws|lab):s3:::([^/]+)/.exec(String(r));
      if (!m || m[1] !== bucket) throw new EngineError("MalformedPolicy", "Policy has invalid resource");
    }
  }
  return list(policy.Statement as Record<string, unknown>[]).some((st) => {
    const principal = st.Principal as unknown;
    const everyone = principal === "*" || (typeof principal === "object" && principal !== null && list((principal as { AWS?: string }).AWS).includes("*"));
    const actions = list(st.Action as string | string[]);
    const resources = list(st.Resource as string | string[]);
    return (
      st.Effect === "Allow" &&
      everyone &&
      actions.some((a) => a === "s3:GetObject" || a === "s3:*" || a === "*") &&
      resources.some((r) => /\/\*$/.test(String(r)))
    );
  });
}

const cmd = (c: Command) => c;

export const S3_COMMANDS: Command[] = [
  // ---------- aws s3 ----------
  cmd({
    service: "s3",
    operation: "mb",
    apiName: "CreateBucket",
    summary: "Make a bucket",
    usage: "s3://<bucket>",
    mutates: true,
    async run(args, ctx) {
      const name = bucketOnly(args.positionals[0]);
      if (ctx.effects) ctx.effects.failurePrefix = `make_bucket failed: s3://${name} `;
      await ctx.engine.create(ctx.accountId, { service: "storage", type: "bucket", region: ctx.region, config: { name } });
      return `make_bucket: ${name}`;
    },
  }),
  cmd({
    service: "s3",
    operation: "rb",
    apiName: "DeleteBucket",
    summary: "Remove a bucket (--force deletes its objects first)",
    usage: "s3://<bucket> [--force]",
    mutates: true,
    async run(args, ctx) {
      const name = bucketOnly(args.positionals[0]);
      if (ctx.effects) ctx.effects.failurePrefix = `remove_bucket failed: s3://${name} `;
      await objects(ctx).bucket(ctx.accountId, name);
      const lines: string[] = [];
      if (args.has("force")) {
        for (const key of await objects(ctx).deleteAll(ctx.accountId, name)) lines.push(`delete: s3://${name}/${key}`);
      }
      await ctx.engine.remove(ctx.accountId, name);
      lines.push(`remove_bucket: ${name}`);
      return lines.join("\n");
    },
  }),
  cmd({
    service: "s3",
    operation: "ls",
    apiName: "ListObjectsV2",
    summary: "List buckets, or the objects in a bucket",
    usage: "[s3://<bucket>[/<prefix>]] [--recursive] [--human-readable] [--summarize]",
    mutates: false,
    async run(args, ctx) {
      const target = args.positionals[0];
      if (!target) {
        const buckets = await ctx.engine.list(ctx.accountId, { service: "storage", type: "bucket" });
        return buckets.map((b) => `${stamp(b.createdAt)} ${b.id}`).join("\n");
      }
      const { bucket, key: prefix } = parseS3(target);
      const recursive = args.has("recursive");
      const { objects: items, prefixes } = await objects(ctx).list(ctx.accountId, bucket, {
        prefix,
        delimiter: recursive ? undefined : "/",
      });
      // Without a trailing slash, "s3://b/images" lists what starts with "images" at that level.
      const base = recursive ? "" : prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const size = (n: number) => (args.has("human-readable") ? humanSize(n).padStart(10) : String(n).padStart(10));
      const lines = [
        ...prefixes.map((p) => `${"".padStart(27)}PRE ${p.slice(base.length)}`),
        ...items.map((o) => `${stamp(o.lastModified)} ${size(o.size)} ${recursive ? o.key : o.key.slice(base.length)}`),
      ];
      if (args.has("summarize")) {
        const total = items.reduce((n, o) => n + o.size, 0);
        lines.push("", `Total Objects: ${items.length}`, `   Total Size: ${args.has("human-readable") ? humanSize(total) : total}`);
      }
      return lines.join("\n");
    },
  }),
  cmd({
    service: "s3",
    operation: "cp",
    apiName: "PutObject",
    summary: "Copy a file to, from or between buckets",
    usage: "<source> <destination> [--recursive] [--content-type <type>]",
    mutates: true,
    async run(args, ctx) {
      const [src, dest] = args.positionals;
      if (!src || !dest) throw new UsageError("the following arguments are required: paths");
      const lines: string[] = [];
      const fx = ctx.effects;

      // Upload: local file → bucket.
      if (!isS3(src) && isS3(dest)) {
        if (args.has("recursive")) {
          throw new UsageError("this terminal uploads one file at a time; use the bucket's Upload button in the console for folders");
        }
        const to = parseS3(dest);
        const key = !to.key || to.key.endsWith("/") ? to.key + baseName(src) : to.key;
        if (fx) fx.failurePrefix = `upload failed: ${src} to s3://${to.bucket}/${key} `;
        if (fx) fx.failureExitCode = 1;
        await objects(ctx).put(ctx.accountId, to.bucket, key, localFile(ctx, src), args.one("content-type"));
        return `upload: ${src} to s3://${to.bucket}/${key}`;
      }

      // Download: bucket → local file, or "-" for the terminal.
      if (isS3(src) && !isS3(dest)) {
        if (fx) fx.apiName = "GetObject";
        const from = parseS3(src);
        if (args.has("recursive")) throw new UsageError("this terminal downloads one file at a time");
        if (!from.key) throw new UsageError(`${src} is a bucket, not an object; add the key, e.g. ${src.replace(/\/$/, "")}/index.html`);
        if (fx) fx.failureExitCode = 1;
        if (fx) fx.failurePrefix = `download failed: ${src} to ${dest} `;
        const { info, data } = await objects(ctx).get(ctx.accountId, from.bucket, from.key);
        if (dest === "-") return data.toString("utf8");
        const filename = dest === "." || dest.endsWith("/") ? baseName(from.key) : baseName(dest);
        download(ctx, filename, data, info.contentType);
        const shown = dest === "." || dest === "./" ? `./${filename}` : dest.endsWith("/") ? `${dest}${filename}` : dest;
        return `download: ${src} to ${shown}`;
      }

      // Copy between buckets (or within one).
      if (isS3(src) && isS3(dest)) {
        if (fx) fx.apiName = "CopyObject";
        const from = parseS3(src);
        const to = parseS3(dest);
        if (args.has("recursive")) {
          const { objects: items } = await objects(ctx).list(ctx.accountId, from.bucket, { prefix: from.key });
          for (const o of items) {
            const rel = o.key.slice(from.key.length).replace(/^\//, "");
            const key = to.key && !to.key.endsWith("/") ? `${to.key}/${rel}` : to.key + rel;
            await objects(ctx).copy(ctx.accountId, { bucket: from.bucket, key: o.key }, { bucket: to.bucket, key });
            lines.push(`copy: s3://${from.bucket}/${o.key} to s3://${to.bucket}/${key}`);
          }
          return lines.join("\n");
        }
        const key = !to.key || to.key.endsWith("/") ? to.key + baseName(from.key) : to.key;
        if (fx) fx.failurePrefix = `copy failed: ${src} to s3://${to.bucket}/${key} `;
        if (fx) fx.failureExitCode = 1;
        await objects(ctx).copy(ctx.accountId, from, { bucket: to.bucket, key });
        return `copy: ${src} to s3://${to.bucket}/${key}`;
      }

      throw new UsageError("Error: Invalid argument type: one of the paths must be an S3 URI (s3://bucket/key)");
    },
  }),
  cmd({
    service: "s3",
    operation: "rm",
    apiName: "DeleteObject",
    summary: "Delete an object (--recursive for everything under a prefix)",
    usage: "s3://<bucket>/<key> [--recursive]",
    mutates: true,
    async run(args, ctx) {
      const target = args.positionals[0];
      if (!target) throw new UsageError("the following arguments are required: paths");
      const { bucket, key } = parseS3(target);
      if (args.has("recursive")) {
        const keys = await objects(ctx).deleteAll(ctx.accountId, bucket, key);
        return keys.map((k) => `delete: s3://${bucket}/${k}`).join("\n");
      }
      if (!key) throw new UsageError(`${target} is a bucket; add a key, or use --recursive to empty it`);
      await objects(ctx).delete(ctx.accountId, bucket, key);
      return `delete: s3://${bucket}/${key}`;
    },
  }),
  cmd({
    service: "s3",
    operation: "website",
    apiName: "PutBucketWebsite",
    summary: "Turn on static website hosting for a bucket",
    usage: "s3://<bucket> --index-document index.html [--error-document error.html]",
    mutates: true,
    async run(args, ctx) {
      const name = bucketOnly(args.positionals[0]);
      const b = await objects(ctx).bucket(ctx.accountId, name);
      await ctx.engine.update(ctx.accountId, b.id, {
        websiteEnabled: true,
        indexDocument: args.one("index-document") ?? "index.html",
        errorDocument: args.one("error-document") ?? "",
      });
    },
  }),

  // ---------- aws s3api: buckets ----------
  cmd({
    service: "s3api",
    operation: "create-bucket",
    apiName: "CreateBucket",
    summary: "Create a bucket",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("bucket");
      await ctx.engine.create(ctx.accountId, { service: "storage", type: "bucket", region: ctx.region, config: { name } });
      return { Location: `/${name}` };
    },
  }),
  cmd({
    service: "s3api",
    operation: "list-buckets",
    apiName: "ListBuckets",
    summary: "List buckets",
    mutates: false,
    async run(_args, ctx) {
      const buckets = await ctx.engine.list(ctx.accountId, { service: "storage", type: "bucket" });
      return {
        Buckets: buckets.map((b) => ({ Name: b.id, CreationDate: b.createdAt })),
        Owner: { ID: ownerId(ctx.accountId) },
      };
    },
  }),
  cmd({
    service: "s3api",
    operation: "delete-bucket",
    apiName: "DeleteBucket",
    summary: "Delete an empty bucket",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      await ctx.engine.remove(ctx.accountId, b.id);
    },
  }),
  cmd({
    service: "s3api",
    operation: "put-bucket-versioning",
    apiName: "PutBucketVersioning",
    summary: "Enable or suspend versioning",
    usage: "--bucket <name> --versioning-configuration Status=Enabled|Suspended",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      const status = String(parseShorthand(args.required("versioning-configuration")).Status ?? "");
      if (status !== "Enabled" && status !== "Suspended") {
        throw new EngineError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
      }
      await ctx.engine.update(ctx.accountId, b.id, { versioning: status });
    },
  }),
  cmd({
    service: "s3api",
    operation: "get-bucket-versioning",
    apiName: "GetBucketVersioning",
    summary: "Show a bucket's versioning status",
    usage: "--bucket <name>",
    mutates: false,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      return b.config.versioning === "Disabled" ? {} : { Status: b.config.versioning };
    },
  }),

  // ---------- aws s3api: objects ----------
  cmd({
    service: "s3api",
    operation: "put-object",
    apiName: "PutObject",
    summary: "Upload a file as an object",
    usage: "--bucket <name> --key <key> [--body <file>] [--content-type <type>]",
    mutates: true,
    async run(args, ctx) {
      const body = args.one("body");
      const data = body ? localFile(ctx, body) : Buffer.alloc(0);
      const o = await objects(ctx).put(ctx.accountId, args.required("bucket"), args.required("key"), data, args.one("content-type") ?? (body ? undefined : "binary/octet-stream"));
      return { ETag: etag(o), ServerSideEncryption: "AES256" };
    },
  }),
  cmd({
    service: "s3api",
    operation: "get-object",
    apiName: "GetObject",
    summary: "Download an object to a file",
    usage: "--bucket <name> --key <key> <outfile>",
    mutates: false,
    async run(args, ctx) {
      const bucket = args.required("bucket");
      const key = args.required("key");
      const outfile = args.positionals[0];
      if (!outfile) throw new UsageError("the following arguments are required: outfile");
      const { info, data } = await objects(ctx).get(ctx.accountId, bucket, key);
      download(ctx, baseName(outfile), data, info.contentType);
      return {
        AcceptRanges: "bytes",
        LastModified: info.lastModified,
        ContentLength: info.size,
        ETag: etag(info),
        ContentType: info.contentType,
        ServerSideEncryption: "AES256",
        Metadata: {},
      };
    },
  }),
  cmd({
    service: "s3api",
    operation: "head-object",
    apiName: "HeadObject",
    summary: "Show an object's metadata",
    usage: "--bucket <name> --key <key>",
    mutates: false,
    async run(args, ctx) {
      try {
        const info = await objects(ctx).head(ctx.accountId, args.required("bucket"), args.required("key"));
        return {
          AcceptRanges: "bytes",
          LastModified: info.lastModified,
          ContentLength: info.size,
          ETag: etag(info),
          ContentType: info.contentType,
          ServerSideEncryption: "AES256",
          Metadata: {},
        };
      } catch (e) {
        // HEAD responses have no body, so the CLI only sees the status code.
        if (e instanceof EngineError && (e.code === "NoSuchKey" || e.code === "NoSuchBucket")) throw new EngineError("404", "Not Found", 404);
        throw e;
      }
    },
  }),
  cmd({
    service: "s3api",
    operation: "list-objects-v2",
    apiName: "ListObjectsV2",
    summary: "List objects in a bucket",
    usage: "--bucket <name> [--prefix <prefix>] [--delimiter /]",
    mutates: false,
    async run(args, ctx) {
      const bucket = args.required("bucket");
      const prefix = args.one("prefix") ?? "";
      const delimiter = args.one("delimiter");
      const { objects: items, prefixes } = await objects(ctx).list(ctx.accountId, bucket, { prefix, delimiter });
      return {
        ...(items.length
          ? {
              Contents: items.map((o) => ({ Key: o.key, LastModified: o.lastModified, ETag: etag(o), Size: o.size, StorageClass: "STANDARD" })),
            }
          : {}),
        Name: bucket,
        Prefix: prefix,
        ...(delimiter ? { Delimiter: delimiter } : {}),
        MaxKeys: 1000,
        ...(prefixes.length ? { CommonPrefixes: prefixes.map((p) => ({ Prefix: p })) } : {}),
        KeyCount: items.length + prefixes.length,
      };
    },
  }),
  cmd({
    service: "s3api",
    operation: "copy-object",
    apiName: "CopyObject",
    summary: "Copy an object",
    usage: "--copy-source <bucket>/<key> --bucket <name> --key <key>",
    mutates: true,
    async run(args, ctx) {
      const source = args.required("copy-source").replace(/^\//, "");
      const slash = source.indexOf("/");
      if (slash < 1) throw new EngineError("InvalidArgument", "Invalid copy source object key");
      const o = await objects(ctx).copy(
        ctx.accountId,
        { bucket: source.slice(0, slash), key: decodeURIComponent(source.slice(slash + 1)) },
        { bucket: args.required("bucket"), key: args.required("key") },
      );
      return { CopyObjectResult: { ETag: etag(o), LastModified: o.lastModified } };
    },
  }),
  cmd({
    service: "s3api",
    operation: "delete-object",
    apiName: "DeleteObject",
    summary: "Delete an object",
    usage: "--bucket <name> --key <key>",
    mutates: true,
    async run(args, ctx) {
      await objects(ctx).delete(ctx.accountId, args.required("bucket"), args.required("key"));
    },
  }),

  // ---------- aws s3api: website, policy and public access ----------
  cmd({
    service: "s3api",
    operation: "put-bucket-website",
    apiName: "PutBucketWebsite",
    summary: "Configure static website hosting",
    usage: "--bucket <name> --website-configuration '{\"IndexDocument\":{\"Suffix\":\"index.html\"},\"ErrorDocument\":{\"Key\":\"error.html\"}}'",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      const raw = args.required("website-configuration");
      let conf: { IndexDocument?: { Suffix?: string }; ErrorDocument?: { Key?: string } };
      try {
        conf = raw.trim().startsWith("{")
          ? JSON.parse(raw)
          : {
              IndexDocument: { Suffix: /IndexDocument=\{Suffix=([^},]+)/.exec(raw)?.[1] },
              ErrorDocument: { Key: /ErrorDocument=\{Key=([^},]+)/.exec(raw)?.[1] },
            };
      } catch {
        throw new UsageError(`Error parsing parameter '--website-configuration': Invalid JSON: ${raw}`);
      }
      await ctx.engine.update(ctx.accountId, b.id, {
        websiteEnabled: true,
        indexDocument: conf.IndexDocument?.Suffix ?? "",
        errorDocument: conf.ErrorDocument?.Key ?? "",
      });
    },
  }),
  cmd({
    service: "s3api",
    operation: "get-bucket-website",
    apiName: "GetBucketWebsite",
    summary: "Show a bucket's website configuration",
    usage: "--bucket <name>",
    mutates: false,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      if (!b.config.websiteEnabled) {
        throw new EngineError("NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", 404);
      }
      return {
        IndexDocument: { Suffix: b.config.indexDocument },
        ...(b.config.errorDocument ? { ErrorDocument: { Key: b.config.errorDocument } } : {}),
      };
    },
  }),
  cmd({
    service: "s3api",
    operation: "delete-bucket-website",
    apiName: "DeleteBucketWebsite",
    summary: "Turn off static website hosting",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      await ctx.engine.update(ctx.accountId, b.id, { websiteEnabled: false });
    },
  }),
  cmd({
    service: "s3api",
    operation: "put-bucket-policy",
    apiName: "PutBucketPolicy",
    summary: "Attach a bucket policy (CloudLab understands public-read policies)",
    usage: "--bucket <name> --policy '<json>'",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      if (!grantsPublicRead(args.required("policy"), b.id)) {
        throw new EngineError(
          "MalformedPolicy",
          `CloudLab only simulates public-read policies: Effect Allow, Principal "*", Action s3:GetObject, Resource arn:aws:s3:::${b.id}/*`,
        );
      }
      await ctx.engine.update(ctx.accountId, b.id, { publicRead: true });
    },
  }),
  cmd({
    service: "s3api",
    operation: "get-bucket-policy",
    apiName: "GetBucketPolicy",
    summary: "Show a bucket's policy",
    usage: "--bucket <name>",
    mutates: false,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      if (!b.config.publicRead) throw new EngineError("NoSuchBucketPolicy", "The bucket policy does not exist", 404);
      return { Policy: PUBLIC_READ(b.id) };
    },
  }),
  cmd({
    service: "s3api",
    operation: "delete-bucket-policy",
    apiName: "DeleteBucketPolicy",
    summary: "Remove a bucket's policy",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      await ctx.engine.update(ctx.accountId, b.id, { publicRead: false });
    },
  }),
  cmd({
    service: "s3api",
    operation: "put-public-access-block",
    apiName: "PutPublicAccessBlock",
    summary: "Block or allow public access",
    usage:
      "--bucket <name> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      const conf = parseShorthand(args.required("public-access-block-configuration"));
      const on = (k: string) => String(conf[k]).toLowerCase() === "true" || conf[k] === (true as unknown);
      // Bucket policies are what CloudLab simulates, so the two policy settings decide.
      await ctx.engine.update(ctx.accountId, b.id, { blockPublicAccess: on("BlockPublicPolicy") || on("RestrictPublicBuckets") });
    },
  }),
  cmd({
    service: "s3api",
    operation: "get-public-access-block",
    apiName: "GetPublicAccessBlock",
    summary: "Show a bucket's public access settings",
    usage: "--bucket <name>",
    mutates: false,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      if (!b.config.blockPublicAccess) {
        throw new EngineError("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found", 404);
      }
      return {
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
      };
    },
  }),
  cmd({
    service: "s3api",
    operation: "delete-public-access-block",
    apiName: "DeletePublicAccessBlock",
    summary: "Remove a bucket's public access block",
    usage: "--bucket <name>",
    mutates: true,
    async run(args, ctx) {
      const b = await objects(ctx).bucket(ctx.accountId, args.required("bucket"));
      await ctx.engine.update(ctx.accountId, b.id, { blockPublicAccess: false });
    },
  }),
];


// ---------- IAM permissions for each command ----------

type Perm = { action: string; resource: string };
const bucketArn = (b: string) => `arn:aws:s3:::${b}`;
const objectArn = (b: string, k: string) => `arn:aws:s3:::${b}/${k}`;

/** Bucket and key from --bucket/--key, or from the first s3:// path. */
function target(args: Parameters<NonNullable<Command["permissions"]>>[0]): S3Path {
  const uri = args.positionals.find(isS3);
  const fromUri = uri ? parseS3(uri) : { bucket: "", key: "" };
  return { bucket: args.one("bucket") ?? fromUri.bucket, key: args.one("key") ?? fromUri.key };
}

/** Simple commands: one action on the bucket or on the object. */
const SIMPLE: Record<string, [string, "bucket" | "object" | "all"]> = {
  "s3:mb": ["s3:CreateBucket", "bucket"],
  "s3:website": ["s3:PutBucketWebsite", "bucket"],
  "s3api:create-bucket": ["s3:CreateBucket", "bucket"],
  "s3api:list-buckets": ["s3:ListAllMyBuckets", "all"],
  "s3api:delete-bucket": ["s3:DeleteBucket", "bucket"],
  "s3api:put-bucket-versioning": ["s3:PutBucketVersioning", "bucket"],
  "s3api:get-bucket-versioning": ["s3:GetBucketVersioning", "bucket"],
  "s3api:put-object": ["s3:PutObject", "object"],
  "s3api:get-object": ["s3:GetObject", "object"],
  "s3api:head-object": ["s3:GetObject", "object"],
  "s3api:list-objects-v2": ["s3:ListBucket", "bucket"],
  "s3api:delete-object": ["s3:DeleteObject", "object"],
  "s3api:put-bucket-website": ["s3:PutBucketWebsite", "bucket"],
  "s3api:get-bucket-website": ["s3:GetBucketWebsite", "bucket"],
  "s3api:delete-bucket-website": ["s3:DeleteBucketWebsite", "bucket"],
  "s3api:put-bucket-policy": ["s3:PutBucketPolicy", "bucket"],
  "s3api:get-bucket-policy": ["s3:GetBucketPolicy", "bucket"],
  "s3api:delete-bucket-policy": ["s3:DeleteBucketPolicy", "bucket"],
  "s3api:put-public-access-block": ["s3:PutBucketPublicAccessBlock", "bucket"],
  "s3api:get-public-access-block": ["s3:GetBucketPublicAccessBlock", "bucket"],
  "s3api:delete-public-access-block": ["s3:PutBucketPublicAccessBlock", "bucket"],
};

const PERMISSIONS: Record<string, NonNullable<Command["permissions"]>> = {
  "s3:ls": (args) => {
    const t = target(args);
    return t.bucket ? [{ action: "s3:ListBucket", resource: bucketArn(t.bucket) }] : [{ action: "s3:ListAllMyBuckets", resource: "*" }];
  },
  "s3:rb": (args) => {
    const { bucket } = target(args);
    const perms: Perm[] = [{ action: "s3:DeleteBucket", resource: bucketArn(bucket) }];
    if (args.has("force")) perms.unshift({ action: "s3:ListBucket", resource: bucketArn(bucket) }, { action: "s3:DeleteObject", resource: objectArn(bucket, "*") });
    return perms;
  },
  "s3:rm": (args) => {
    const { bucket, key } = target(args);
    return args.has("recursive")
      ? [{ action: "s3:ListBucket", resource: bucketArn(bucket) }, { action: "s3:DeleteObject", resource: objectArn(bucket, `${key}*`) }]
      : [{ action: "s3:DeleteObject", resource: objectArn(bucket, key) }];
  },
  "s3:cp": (args) => {
    const [src, dest] = args.positionals;
    const perms: Perm[] = [];
    if (isS3(src)) {
      const f = parseS3(src);
      perms.push({ action: "s3:GetObject", resource: objectArn(f.bucket, args.has("recursive") ? `${f.key}*` : f.key) });
    }
    if (isS3(dest)) {
      const t = parseS3(dest);
      const key = !t.key || t.key.endsWith("/") ? t.key + (src && !args.has("recursive") ? baseName(isS3(src) ? parseS3(src).key : src) : "*") : t.key;
      perms.push({ action: "s3:PutObject", resource: objectArn(t.bucket, key) });
    }
    return perms;
  },
  "s3api:copy-object": (args) => {
    const source = (args.one("copy-source") ?? "").replace(/^\//, "");
    return [
      { action: "s3:GetObject", resource: `arn:aws:s3:::${source}` },
      { action: "s3:PutObject", resource: objectArn(args.one("bucket") ?? "", args.one("key") ?? "") },
    ];
  },
};

for (const c of S3_COMMANDS) {
  const id = `${c.service}:${c.operation}`;
  const simple = SIMPLE[id];
  c.permissions =
    PERMISSIONS[id] ??
    (simple
      ? (args) => {
          const t = target(args);
          const resource = simple[1] === "all" ? "*" : simple[1] === "bucket" ? bucketArn(t.bucket) : objectArn(t.bucket, t.key);
          return [{ action: simple[0], resource }];
        }
      : undefined);
}

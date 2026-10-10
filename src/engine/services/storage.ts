import { EngineError } from "../errors";
import type { ResourceTypeDef, ServiceDef } from "../types";

/**
 * Bucket naming rules. Like the real service, any broken rule gives the same
 * terse error; the specific rule goes into `details` for the console form.
 */
function checkBucketName(name: string) {
  const fail = (rule: string) => {
    throw new EngineError("InvalidBucketName", "The specified bucket is not valid.", 400, [
      { field: "name", message: `Bucket names ${rule}` },
    ]);
  };
  if (name.length < 3 || name.length > 63) fail("must be between 3 and 63 characters long.");
  if (!/^[a-z0-9.-]+$/.test(name)) fail("may only contain lowercase letters, numbers, dots and hyphens.");
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) fail("must begin and end with a letter or number.");
  if (name.includes("..")) fail("must not contain two adjacent dots.");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) fail("must not be formatted as an IP address.");
  if (name.startsWith("xn--")) fail("must not start with 'xn--'.");
  if (name.startsWith("sthree-")) fail("must not start with 'sthree-'.");
  if (name.endsWith("-s3alias") || name.endsWith("--ol-s3")) fail("uses a reserved suffix.");
}

const bucket: ResourceTypeDef = {
  service: "storage",
  type: "bucket",
  label: "Bucket",
  pluralLabel: "Buckets",
  description: "A container for objects. Bucket names are unique across every account on the platform.",
  idPrefix: "bucket",
  idFromName: true,
  notFoundCode: "NoSuchBucket",
  apiNoun: "bucket",
  dependencyError: () => new EngineError("BucketNotEmpty", "The bucket you tried to delete is not empty", 409),
  fields: [
    {
      key: "name",
      label: "Bucket name",
      type: "string",
      required: true,
      immutable: true,
      placeholder: "my-app-assets-2026",
      description: "3–63 lowercase letters, numbers, dots and hyphens. Must be globally unique.",
    },
    {
      key: "versioning",
      label: "Versioning",
      type: "enum",
      required: true,
      default: "Disabled",
      options: [
        { value: "Disabled", label: "Disabled" },
        { value: "Enabled", label: "Enabled" },
        { value: "Suspended", label: "Suspended" },
      ],
      description: "Keep every version of an object. Once enabled, it can be suspended but never disabled.",
    },
    {
      key: "blockPublicAccess",
      label: "Block all public access",
      type: "boolean",
      default: true,
      description: "Recommended. Prevents objects from being made public by policy or ACL.",
    },
    {
      key: "publicRead",
      label: "Bucket policy: public read",
      type: "boolean",
      default: false,
      description:
        "Adds a bucket policy that lets anyone read (s3:GetObject) every object. Needed for a public website. Only allowed when Block all public access is off.",
    },
    {
      key: "websiteEnabled",
      label: "Static website hosting",
      type: "boolean",
      default: false,
      description: "Serve the bucket's files as a website. Visitors also need public read access.",
    },
    {
      key: "indexDocument",
      label: "Index document",
      type: "string",
      maxLength: 1024,
      default: "index.html",
      placeholder: "index.html",
      description: "Returned for the site's root and for any 'folder/' address.",
    },
    {
      key: "errorDocument",
      label: "Error document",
      type: "string",
      maxLength: 1024,
      placeholder: "error.html",
      description: "Optional. Returned when a page doesn't exist.",
    },
  ],
  columns: [
    { label: "Versioning", path: "config.versioning" },
    { label: "Public access", path: "attributes.access" },
    { label: "Objects", path: "attributes.objectCount" },
  ],
  async validate({ config, existing, ctx }) {
    const name = config.name as string;
    checkBucketName(name);
    if (!existing) {
      const taken = await ctx.existsGlobally(name);
      if (taken) {
        throw taken.accountId === ctx.accountId
          ? new EngineError(
              "BucketAlreadyOwnedByYou",
              "Your previous request to create the named bucket succeeded and you already own it.",
              409,
            )
          : new EngineError(
              "BucketAlreadyExists",
              "The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.",
              409,
            );
      }
    }
    // Adding a public policy while public access is blocked is refused. (Blocking access on a bucket that
    // already has one is allowed: the block simply wins.)
    if (config.publicRead && config.blockPublicAccess && !existing?.config.publicRead) {
      throw new EngineError(
        "AccessDenied",
        `User: arn:lab:iam::${ctx.accountId}:user/learner is not authorized to perform: s3:PutBucketPolicy on resource: "arn:lab:s3:::${name}" because public policies are blocked by the BlockPublicPolicy block public access setting.`,
        403,
        [{ field: "publicRead", message: "Turn off Block all public access first." }],
      );
    }
    if (config.websiteEnabled && !config.indexDocument) {
      throw new EngineError("InvalidArgument", "A value for IndexDocument Suffix must be provided if RedirectAllRequestsTo is empty", 400, [
        { field: "indexDocument", message: "Enter an index document, e.g. index.html." },
      ]);
    }
    if (typeof config.indexDocument === "string" && config.indexDocument.includes("/")) {
      throw new EngineError("InvalidArgument", "The IndexDocument Suffix is not well formed", 400, [
        { field: "indexDocument", message: "Use a file name without slashes, e.g. index.html." },
      ]);
    }
    // The real API only accepts Enabled or Suspended, so "back to Disabled" can't even be expressed.
    const before = existing?.config.versioning;
    if ((before === "Enabled" || before === "Suspended") && config.versioning === "Disabled") {
      throw new EngineError(
        "MalformedXML",
        "The XML you provided was not well-formed or did not validate against our published schema",
        400,
        [{ field: "versioning", message: "Once enabled, versioning can be suspended but never disabled." }],
      );
    }
  },
  async derive({ id, config, existing, ctx }) {
    // Blocking public access overrides a public policy, as in the real service.
    const isPublic = !config.blockPublicAccess && config.publicRead === true;
    return {
      arn: `arn:lab:s3:::${id}`,
      endpoint: `https://${id}.storage.cloudlab.local`,
      access: isPublic ? "Public" : config.blockPublicAccess ? "Blocked" : "Objects can be public",
      websiteEndpoint: config.websiteEnabled ? `http://${id}.s3-website.${ctx.region}.cloudlab.local` : null,
      objectCount: existing?.attributes.objectCount ?? 0,
      totalBytes: existing?.attributes.totalBytes ?? 0,
    };
  },
};

export const storageService: ServiceDef = {
  id: "storage",
  label: "Object Storage",
  modelledOn: "S3",
  description: "Buckets for files, backups and static assets.",
  category: "Storage",
  types: [bucket],
};

/**
 * An object in a bucket. Objects are managed through the bucket's own screens and
 * the S3 commands, not the generic console pages; the bytes live in blob storage.
 * The resource's name is the object's key.
 */
export const objectType: ResourceTypeDef = {
  service: "storage",
  type: "object",
  label: "Object",
  pluralLabel: "Objects",
  description: "A file stored in a bucket under a key such as images/logo.png.",
  idPrefix: "obj",
  notFoundCode: "NoSuchKey",
  notFoundMessage: () => "The specified key does not exist.",
  apiNoun: "object",
  hidden: true,
  fields: [
    { key: "bucket", label: "Bucket", type: "ref", required: true, immutable: true, ref: { service: "storage", type: "bucket" } },
    { key: "name", label: "Key", type: "string", required: true, immutable: true, maxLength: 1024 },
    { key: "contentType", label: "Content type", type: "string", maxLength: 255 },
  ],
  columns: [],
};

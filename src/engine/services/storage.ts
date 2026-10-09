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
  ],
  columns: [
    { label: "Versioning", path: "config.versioning" },
    { label: "Public access", path: "attributes.access" },
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
  async derive({ id, config }) {
    return {
      arn: `arn:lab:s3:::${id}`,
      endpoint: `https://${id}.storage.cloudlab.local`,
      access: config.blockPublicAccess ? "Blocked" : "Objects can be public",
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

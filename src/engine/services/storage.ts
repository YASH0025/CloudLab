import { EngineError } from "../errors";
import type { ResourceTypeDef, ServiceDef } from "../types";

/** Bucket naming rules, checked one by one so the learner sees exactly which rule failed. */
function checkBucketName(name: string) {
  const fail = (message: string) => {
    throw new EngineError("InvalidBucketName", `Bucket name '${name}': ${message}`);
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
      description: "Keep every version of an object. Once enabled, it can be suspended but not disabled.",
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
          ? new EngineError("BucketAlreadyOwnedByYou", `You already own a bucket named '${name}'.`, 409)
          : new EngineError(
              "BucketAlreadyExists",
              `The bucket name '${name}' is already taken by another account. Bucket names are global; try another.`,
              409,
            );
      }
    }
    const before = existing?.config.versioning;
    if ((before === "Enabled" || before === "Suspended") && config.versioning === "Disabled") {
      throw new EngineError(
        "IllegalVersioningConfigurationException",
        "Versioning cannot be disabled once it has been enabled. Suspend it instead.",
      );
    }
    if (!existing && config.versioning === "Suspended") {
      throw new EngineError(
        "IllegalVersioningConfigurationException",
        "A new bucket's versioning can be Disabled or Enabled, not Suspended.",
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

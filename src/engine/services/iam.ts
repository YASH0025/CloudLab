import { EngineError } from "../errors";
import { decryptSecret, encryptSecret, newSecretAccessKey } from "../iam/secrets";
import { managedByArn, MANAGED_POLICIES } from "../iam/managed";
import { parsePolicy, type PolicyDocument } from "../iam/policy";
import { accountNumber, iamId } from "../ids";
import type { FieldDef, HookContext, Resource, ResourceTypeDef, ServiceDef } from "../types";

/**
 * IAM: who can do what. Users (people), groups (sets of users), roles (identities
 * that services or people assume), policies (permission documents) and access keys.
 * IAM is global: its resources don't belong to a region.
 */

const arnOf = (kind: string) => (r: { name: string }, account: string) => `arn:aws:iam::${account}:${kind}/${r.name}`;

const conflict = (message: string) => new EngineError("DeleteConflict", message, 409);
const noSuchEntity = (message: string) => new EngineError("NoSuchEntity", message, 404);

/** Names allowed by IAM: letters, digits and +=,.@_- */
const nameField = (label: string, max: number, placeholder: string): FieldDef => ({
  key: "name",
  label,
  type: "string",
  required: true,
  immutable: true,
  maxLength: max,
  pattern: "^[\\w+=,.@-]+$",
  patternMessage: `${label} may contain letters, numbers and the characters +=,.@_-`,
  placeholder,
});

const policiesField: FieldDef = {
  key: "policyArns",
  label: "Permissions policies",
  type: "policies",
  description: "AWS managed policies and your own. Up to 10.",
};

/** The policy document behind an ARN: AWS managed, or one of the account's own. */
export async function policyByArn(arn: string, accountId: string, list: HookContext["list"]): Promise<{ name: string; document: PolicyDocument } | null> {
  const m = managedByArn(arn);
  if (m) return { name: m.name, document: m.document };
  const own = (await list("iam", "policy")).find((p) => p.attributes.arn === arn);
  return own ? { name: own.name, document: parsePolicy(String(own.config.document)) } : null;
}

async function checkUnique(ctx: HookContext, type: string, name: string, existing: Resource | null, noun: string) {
  if (existing) return;
  const taken = (await ctx.list("iam", type)).some((r) => r.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new EngineError("EntityAlreadyExists", `${noun} with name ${name} already exists.`, 409);
}

async function checkPolicies(ctx: HookContext, config: Record<string, unknown>, quotaName: string) {
  const arns = (config.policyArns as string[] | undefined) ?? [];
  if (new Set(arns).size !== arns.length) throw new EngineError("InvalidInput", "The same policy is listed twice.");
  if (arns.length > 10) throw new EngineError("LimitExceeded", `Cannot exceed quota for ${quotaName}: 10`);
  for (const arn of arns) {
    if (!(await policyByArn(arn, ctx.accountId, ctx.list))) {
      throw noSuchEntity(`Policy ${arn} does not exist or is not attachable.`);
    }
  }
}

/** Principals a role's trust policy lets in: services ("ec2.amazonaws.com") and accounts. */
export function trustedPrincipals(trustPolicy: string): { services: string[]; aws: string[] } {
  const doc = parsePolicy(trustPolicy, "trust");
  const services: string[] = [];
  const aws: string[] = [];
  for (const st of doc.Statement) {
    if (st.Effect !== "Allow" || !(st.Action ?? []).some((a) => a === "sts:AssumeRole" || a === "sts:*" || a === "*")) continue;
    const p = st.Principal as string | { Service?: string | string[]; AWS?: string | string[] };
    if (p === "*") aws.push("*");
    else if (p && typeof p === "object") {
      services.push(...[p.Service ?? []].flat());
      aws.push(...[p.AWS ?? []].flat());
    }
  }
  return { services, aws };
}

const EC2_TRUST = JSON.stringify(
  {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
  },
  null,
  2,
);

// ---------- users ----------

const user: ResourceTypeDef = {
  service: "iam",
  type: "user",
  label: "User",
  pluralLabel: "Users",
  description: "A person (or app) with long-term credentials. Give people only the permissions they need, preferably through groups.",
  idPrefix: "AIDA",
  makeId: () => iamId("AIDA"),
  global: true,
  notFoundCode: "NoSuchEntity",
  notFoundMessage: () => "The user cannot be found.",
  apiNoun: "user",
  fields: [
    nameField("User name", 64, "dev"),
    {
      key: "groups",
      label: "Groups",
      type: "ref",
      ref: { service: "iam", type: "group", multiple: true, by: "name" },
      description: "The user gets every permission of every group it's in.",
    },
    policiesField,
  ],
  columns: [
    { label: "Groups", path: "attributes.groupCount" },
    { label: "Policies", path: "attributes.policyCount" },
    { label: "ARN", path: "attributes.arn", mono: true },
  ],
  iam: {
    create: "iam:CreateUser",
    read: "iam:ListUsers",
    update: (changed) => [
      ...(changed.includes("groups") ? ["iam:AddUserToGroup"] : []),
      ...(changed.includes("policyArns") ? ["iam:AttachUserPolicy"] : []),
    ],
    delete: "iam:DeleteUser",
    arn: arnOf("user"),
  },
  async validate({ config, existing, ctx }) {
    await checkUnique(ctx, "user", config.name as string, existing, "User");
    await checkPolicies(ctx, config, "PoliciesPerUser");
    if (((config.groups as string[]) ?? []).length > 10) throw new EngineError("LimitExceeded", "Cannot exceed quota for GroupsPerUser: 10");
  },
  async derive({ id, config, existing, ctx }) {
    return {
      arn: `arn:aws:iam::${accountNumber(ctx.accountId)}:user/${config.name}`,
      userId: existing?.attributes.userId ?? id,
      groupCount: ((config.groups as string[]) ?? []).length,
      policyCount: ((config.policyArns as string[]) ?? []).length,
    };
  },
  async beforeDelete({ resource, ctx }) {
    // The API refuses to delete a user that still has anything attached; the console's
    // "Delete user" in AWS removes those first, but here learners see why.
    if (((resource.config.policyArns as string[]) ?? []).length) throw conflict("Cannot delete entity, must detach all policies first.");
    if (((resource.config.groups as string[]) ?? []).length) throw conflict("Cannot delete entity, must remove user from all groups first.");
    if ((await ctx.list("iam", "access-key")).some((k) => k.config.userName === resource.name)) {
      throw conflict("Cannot delete entity, must delete access keys first.");
    }
  },
};

// ---------- groups ----------

const group: ResourceTypeDef = {
  service: "iam",
  type: "group",
  label: "Group",
  pluralLabel: "User groups",
  description: "A set of users that share permissions. Attach policies to groups, not to individual users.",
  idPrefix: "AGPA",
  makeId: () => iamId("AGPA"),
  global: true,
  notFoundCode: "NoSuchEntity",
  notFoundMessage: () => "The group cannot be found.",
  apiNoun: "group",
  fields: [nameField("Group name", 128, "developers"), policiesField],
  columns: [
    { label: "Policies", path: "attributes.policyCount" },
    { label: "ARN", path: "attributes.arn", mono: true },
  ],
  iam: {
    create: "iam:CreateGroup",
    read: "iam:ListGroups",
    update: "iam:AttachGroupPolicy",
    delete: "iam:DeleteGroup",
    arn: arnOf("group"),
  },
  async validate({ config, existing, ctx }) {
    await checkUnique(ctx, "group", config.name as string, existing, "Group");
    await checkPolicies(ctx, config, "PoliciesPerGroup");
  },
  async derive({ id, config, existing, ctx }) {
    return {
      arn: `arn:aws:iam::${accountNumber(ctx.accountId)}:group/${config.name}`,
      groupId: existing?.attributes.groupId ?? id,
      policyCount: ((config.policyArns as string[]) ?? []).length,
    };
  },
  async beforeDelete({ resource, ctx }) {
    if ((await ctx.list("iam", "user")).some((u) => ((u.config.groups as string[]) ?? []).includes(resource.name))) {
      throw conflict("Cannot delete entity, must remove users from group first.");
    }
    if (((resource.config.policyArns as string[]) ?? []).length) throw conflict("Cannot delete entity, must detach all policies first.");
  },
};

// ---------- roles ----------

const role: ResourceTypeDef = {
  service: "iam",
  type: "role",
  label: "Role",
  pluralLabel: "Roles",
  description:
    "An identity with permissions but no password or keys. Services (like an EC2 instance) or people assume it to get temporary credentials.",
  idPrefix: "AROA",
  makeId: () => iamId("AROA"),
  global: true,
  notFoundCode: "NoSuchEntity",
  notFoundMessage: () => "The role cannot be found.",
  apiNoun: "role",
  fields: [
    nameField("Role name", 64, "web-server-role"),
    { key: "description", label: "Description", type: "string", maxLength: 1000, placeholder: "Lets web servers read the assets bucket" },
    {
      key: "trustPolicy",
      label: "Trust policy",
      type: "json",
      required: true,
      default: EC2_TRUST,
      description:
        "Who may assume the role. The default lets EC2 instances use it. To let your IAM users switch to it, use the principal {\"AWS\": \"arn:aws:iam::<account>:root\"}.",
    },
    policiesField,
  ],
  columns: [
    { label: "Trusted", path: "attributes.trusted" },
    { label: "Policies", path: "attributes.policyCount" },
    { label: "ARN", path: "attributes.arn", mono: true },
  ],
  iam: {
    create: "iam:CreateRole",
    read: "iam:ListRoles",
    update: (changed) => [
      ...(changed.includes("trustPolicy") ? ["iam:UpdateAssumeRolePolicy"] : []),
      ...(changed.includes("policyArns") ? ["iam:AttachRolePolicy"] : []),
      ...(changed.includes("description") ? ["iam:UpdateRole"] : []),
    ],
    delete: "iam:DeleteRole",
    arn: arnOf("role"),
  },
  async validate({ config, existing, ctx }) {
    await checkUnique(ctx, "role", config.name as string, existing, "Role");
    trustedPrincipals(String(config.trustPolicy));
    await checkPolicies(ctx, config, "PoliciesPerRole");
  },
  async derive({ id, config, existing, ctx }) {
    const t = trustedPrincipals(String(config.trustPolicy));
    return {
      arn: `arn:aws:iam::${accountNumber(ctx.accountId)}:role/${config.name}`,
      roleId: existing?.attributes.roleId ?? id,
      trusted: [...t.services, ...t.aws].join(", ") || "nobody",
      policyCount: ((config.policyArns as string[]) ?? []).length,
    };
  },
  async beforeDelete({ resource, ctx }) {
    if (((resource.config.policyArns as string[]) ?? []).length) throw conflict("Cannot delete entity, must detach all policies first.");
    const inUse = (await ctx.listAll("compute", "instance")).some((i) => i.config.iamRole === resource.name);
    if (inUse) throw conflict("Cannot delete entity, must remove roles from instance profile first.");
  },
};

// ---------- customer managed policies ----------

const policy: ResourceTypeDef = {
  service: "iam",
  type: "policy",
  label: "Policy",
  pluralLabel: "Policies",
  description: "A permissions document you write: which actions are allowed (or denied) on which resources. Attach it to users, groups or roles.",
  idPrefix: "ANPA",
  makeId: () => iamId("ANPA"),
  global: true,
  notFoundCode: "NoSuchEntity",
  notFoundMessage: () => "Policy does not exist or is not attachable.",
  apiNoun: "policy",
  fields: [
    nameField("Policy name", 128, "read-assets-bucket"),
    { key: "description", label: "Description", type: "string", maxLength: 1000, immutable: true },
    {
      key: "document",
      label: "Policy document",
      type: "json",
      required: true,
      default: JSON.stringify(
        {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"] }],
        },
        null,
        2,
      ),
      description: "JSON with Version and Statement. Each statement has Effect, Action and Resource. Saving a change creates a new version.",
    },
  ],
  columns: [
    { label: "Version", path: "attributes.defaultVersionId" },
    { label: "ARN", path: "attributes.arn", mono: true },
  ],
  iam: {
    create: "iam:CreatePolicy",
    read: "iam:ListPolicies",
    update: "iam:CreatePolicyVersion",
    delete: "iam:DeletePolicy",
    arn: arnOf("policy"),
  },
  invalidValue({ field }) {
    return field.key === "document" ? new EngineError("MalformedPolicyDocument", "The policy failed legacy parsing") : undefined;
  },
  async validate({ config, existing, ctx }) {
    await checkUnique(ctx, "policy", config.name as string, existing, "A policy");
    parsePolicy(String(config.document));
  },
  async derive({ id, config, existing, ctx }) {
    const changed = existing && existing.config.document !== config.document;
    const version = existing ? Number(String(existing.attributes.defaultVersionId ?? "v1").slice(1)) + (changed ? 1 : 0) : 1;
    if (version > 5) throw new EngineError("LimitExceeded", "A managed policy can have up to 5 versions. Before you create a new version, you must delete an existing version.");
    return {
      arn: `arn:aws:iam::${accountNumber(ctx.accountId)}:policy/${config.name}`,
      policyId: existing?.attributes.policyId ?? id,
      defaultVersionId: `v${version}`,
    };
  },
  async beforeDelete({ resource, ctx }) {
    const arn = resource.attributes.arn as string;
    const holders = [...(await ctx.list("iam", "user")), ...(await ctx.list("iam", "group")), ...(await ctx.list("iam", "role"))];
    if (holders.some((h) => ((h.config.policyArns as string[]) ?? []).includes(arn))) {
      throw conflict("Cannot delete a policy attached to entities.");
    }
  },
};

// ---------- access keys ----------

const accessKey: ResourceTypeDef = {
  service: "iam",
  type: "access-key",
  label: "Access key",
  pluralLabel: "Access keys",
  description:
    "Long-term credentials for the CLI and SDKs: an access key ID plus a secret shown only once. Prefer roles where you can, and never commit keys to code.",
  idPrefix: "AKIA",
  makeId: () => iamId("AKIA", 16),
  global: true,
  notFoundCode: "NoSuchEntity",
  notFoundMessage: (id) => `The Access Key with id ${id} cannot be found.`,
  apiNoun: "access key",
  revealOnce: ["secretAccessKey"],
  privateAttributes: ["secretEncrypted"],
  fields: [
    { key: "userName", label: "User", type: "ref", required: true, immutable: true, ref: { service: "iam", type: "user", by: "name" } },
    {
      key: "status",
      label: "Status",
      type: "enum",
      required: true,
      default: "Active",
      options: [
        { value: "Active", label: "Active" },
        { value: "Inactive", label: "Inactive" },
      ],
      description: "Deactivate a key before deleting it, to check nothing still uses it.",
    },
  ],
  columns: [
    { label: "User", path: "config.userName" },
    { label: "Status", path: "config.status" },
  ],
  iam: {
    create: "iam:CreateAccessKey",
    read: "iam:ListAccessKeys",
    update: "iam:UpdateAccessKey",
    delete: "iam:DeleteAccessKey",
    arn: (r, account) => `arn:aws:iam::${account}:user/${r.config.userName}`,
  },
  async validate({ config, existing, ctx }) {
    if (existing) return;
    const keys = (await ctx.list("iam", "access-key")).filter((k) => k.config.userName === config.userName);
    if (keys.length >= 2) throw new EngineError("LimitExceeded", "Cannot exceed quota for AccessKeysPerUser: 2", 409);
  },
  async derive({ existing }) {
    if (existing) return existing.attributes;
    const secret = newSecretAccessKey();
    // Kept encrypted (never shown again) so request signatures can be checked later.
    return { secretEncrypted: encryptSecret(secret), secretAccessKey: secret, lastUsed: null };
  },
};

/** An access key's secret, for checking signatures. */
export const accessKeySecret = (key: Resource) => decryptSecret(String(key.attributes.secretEncrypted));

export const iamService: ServiceDef = {
  id: "iam",
  label: "Identity & Access",
  modelledOn: "IAM",
  description: "Users, groups, roles and the policies that decide who can do what.",
  category: "Security",
  types: [user, group, role, policy, accessKey],
};

export { MANAGED_POLICIES };

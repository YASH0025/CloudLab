import { EngineError } from "@/engine/errors";
import { check, resolvePrincipal, rolePrincipal, type Identity } from "@/engine/iam/authorize";
import { MANAGED_POLICIES, managedByArn } from "@/engine/iam/managed";
import { accountNumber } from "@/engine/ids";
import type { Resource } from "@/engine/types";
import type { CliContext, Command } from "./commands";
import { LocalPathError, UsageError } from "./parse";

/**
 * `aws iam` and `aws sts`. IAM is addressed by name (users, groups, roles) and
 * by ARN (policies), and its errors are NoSuchEntity, EntityAlreadyExists and
 * DeleteConflict, as in the real service.
 */

const list = (ctx: CliContext, type: string) => ctx.engine.list(ctx.accountId, { service: "iam", type, region: "global" });

async function byName(ctx: CliContext, type: "user" | "group" | "role", name: string): Promise<Resource> {
  const found = (await list(ctx, type)).find((r) => r.name === name);
  if (!found) throw new EngineError("NoSuchEntity", `The ${type} with name ${name} cannot be found.`, 404);
  return found;
}

async function customPolicy(ctx: CliContext, arn: string): Promise<Resource | undefined> {
  return (await list(ctx, "policy")).find((p) => p.attributes.arn === arn);
}

/** --policy-document '{"Version":…}' or file://policy.json (the terminal asks for the file). */
function documentArg(ctx: CliContext, value: string): string {
  const m = /^file:\/\/(.+)$/.exec(value);
  if (!m) return value;
  const data = ctx.files?.[m[1]];
  if (data === undefined) throw new LocalPathError(m[1]);
  return Buffer.from(data, "base64").toString("utf8");
}

const create = (ctx: CliContext, type: string, config: Record<string, unknown>) =>
  ctx.engine.create(ctx.accountId, { service: "iam", type, region: "global", config });

const update = (ctx: CliContext, r: Resource, patch: Record<string, unknown>) => ctx.engine.update(ctx.accountId, r.id, patch);

// ---------- output shapes ----------

const userOut = (u: Resource) => ({ Path: "/", UserName: u.name, UserId: u.attributes.userId, Arn: u.attributes.arn, CreateDate: u.createdAt });
const groupOut = (g: Resource) => ({ Path: "/", GroupName: g.name, GroupId: g.attributes.groupId, Arn: g.attributes.arn, CreateDate: g.createdAt });
const roleOut = (r: Resource) => ({
  Path: "/",
  RoleName: r.name,
  RoleId: r.attributes.roleId,
  Arn: r.attributes.arn,
  CreateDate: r.createdAt,
  AssumeRolePolicyDocument: JSON.parse(String(r.config.trustPolicy)),
  ...(r.config.description ? { Description: r.config.description } : {}),
  MaxSessionDuration: 3600,
});

async function attachmentCount(ctx: CliContext, arn: string) {
  const holders = [...(await list(ctx, "user")), ...(await list(ctx, "group")), ...(await list(ctx, "role"))];
  return holders.filter((h) => ((h.config.policyArns as string[]) ?? []).includes(arn)).length;
}

async function policyOut(ctx: CliContext, p: Resource) {
  return {
    PolicyName: p.name,
    PolicyId: p.attributes.policyId,
    Arn: p.attributes.arn,
    Path: "/",
    DefaultVersionId: p.attributes.defaultVersionId,
    AttachmentCount: await attachmentCount(ctx, String(p.attributes.arn)),
    PermissionsBoundaryUsageCount: 0,
    IsAttachable: true,
    ...(p.config.description ? { Description: p.config.description } : {}),
    CreateDate: p.createdAt,
    UpdateDate: p.updatedAt,
  };
}

async function attachedOut(ctx: CliContext, arns: string[]) {
  const out = [];
  for (const arn of arns) {
    const name = managedByArn(arn)?.name ?? (await customPolicy(ctx, arn))?.name ?? arn.split("/").pop();
    out.push({ PolicyName: name, PolicyArn: arn });
  }
  return { AttachedPolicies: out };
}

// ---------- attach / detach for users, groups and roles ----------

const OWNER_OPTION = { user: "user-name", group: "group-name", role: "role-name" } as const;

function attachCommands(kind: "user" | "group" | "role", noun: string): Command[] {
  const option = OWNER_OPTION[kind];
  return [
    {
      service: "iam",
      operation: `attach-${kind}-policy`,
      apiName: `Attach${noun}Policy`,
      summary: `Attach a policy to a ${kind}`,
      usage: `--${option} <name> --policy-arn <arn>`,
      mutates: true,
      async run(args, ctx) {
        const owner = await byName(ctx, kind, args.required(option));
        const arn = args.required("policy-arn");
        const current = (owner.config.policyArns as string[]) ?? [];
        // Attaching something already attached succeeds quietly.
        if (!current.includes(arn)) await update(ctx, owner, { policyArns: [...current, arn] });
      },
    },
    {
      service: "iam",
      operation: `detach-${kind}-policy`,
      apiName: `Detach${noun}Policy`,
      summary: `Detach a policy from a ${kind}`,
      usage: `--${option} <name> --policy-arn <arn>`,
      mutates: true,
      async run(args, ctx) {
        const owner = await byName(ctx, kind, args.required(option));
        const arn = args.required("policy-arn");
        const current = (owner.config.policyArns as string[]) ?? [];
        if (!current.includes(arn)) throw new EngineError("NoSuchEntity", `Policy ${arn} was not found.`, 404);
        await update(ctx, owner, { policyArns: current.filter((a) => a !== arn) });
      },
    },
    {
      service: "iam",
      operation: `list-attached-${kind}-policies`,
      apiName: `ListAttached${noun}Policies`,
      summary: `List the policies attached to a ${kind}`,
      usage: `--${option} <name>`,
      mutates: false,
      async run(args, ctx) {
        const owner = await byName(ctx, kind, args.required(option));
        return attachedOut(ctx, (owner.config.policyArns as string[]) ?? []);
      },
    },
  ];
}

/** The identity the terminal is using, as STS reports it. */
function callerIdentity(ctx: CliContext) {
  const account = accountNumber(ctx.accountId);
  const p = ctx.principal;
  if (!p || p.identity.kind === "root") return { UserId: account, Account: account, Arn: `arn:aws:iam::${account}:root` };
  return { UserId: p.identity.kind === "user" ? p.identity.name.toUpperCase() : `AROA${account}:cloudlab-session`, Account: account, Arn: p.arn };
}

const cmd = (c: Command) => c;

export const IAM_COMMANDS: Command[] = [
  cmd({
    service: "sts",
    operation: "get-caller-identity",
    apiName: "GetCallerIdentity",
    summary: "Show which identity the terminal is using",
    mutates: false,
    async run(_args, ctx) {
      return callerIdentity(ctx);
    },
  }),

  // ---------- users ----------
  cmd({
    service: "iam",
    operation: "create-user",
    apiName: "CreateUser",
    summary: "Create an IAM user",
    usage: "--user-name <name>",
    mutates: true,
    async run(args, ctx) {
      return { User: userOut(await create(ctx, "user", { name: args.required("user-name") })) };
    },
  }),
  cmd({
    service: "iam",
    operation: "get-user",
    apiName: "GetUser",
    summary: "Show a user (yourself if no name is given)",
    usage: "[--user-name <name>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("user-name") ?? (ctx.principal?.identity.kind === "user" ? ctx.principal.identity.name : undefined);
      if (!name) {
        const account = accountNumber(ctx.accountId);
        return { User: { UserId: account, Arn: `arn:aws:iam::${account}:root`, CreateDate: new Date(0).toISOString() } };
      }
      return { User: userOut(await byName(ctx, "user", name)) };
    },
  }),
  cmd({
    service: "iam",
    operation: "list-users",
    apiName: "ListUsers",
    summary: "List IAM users",
    mutates: false,
    async run(_args, ctx) {
      return { Users: (await list(ctx, "user")).map(userOut) };
    },
  }),
  cmd({
    service: "iam",
    operation: "delete-user",
    apiName: "DeleteUser",
    summary: "Delete a user (detach policies, leave groups and delete keys first)",
    usage: "--user-name <name>",
    mutates: true,
    async run(args, ctx) {
      const u = await byName(ctx, "user", args.required("user-name"));
      await ctx.engine.remove(ctx.accountId, u.id);
    },
  }),

  // ---------- groups ----------
  cmd({
    service: "iam",
    operation: "create-group",
    apiName: "CreateGroup",
    summary: "Create a group",
    usage: "--group-name <name>",
    mutates: true,
    async run(args, ctx) {
      return { Group: groupOut(await create(ctx, "group", { name: args.required("group-name") })) };
    },
  }),
  cmd({
    service: "iam",
    operation: "get-group",
    apiName: "GetGroup",
    summary: "Show a group and its users",
    usage: "--group-name <name>",
    mutates: false,
    async run(args, ctx) {
      const g = await byName(ctx, "group", args.required("group-name"));
      const users = (await list(ctx, "user")).filter((u) => ((u.config.groups as string[]) ?? []).includes(g.name));
      return { Users: users.map(userOut), Group: groupOut(g) };
    },
  }),
  cmd({
    service: "iam",
    operation: "list-groups",
    apiName: "ListGroups",
    summary: "List groups",
    mutates: false,
    async run(_args, ctx) {
      return { Groups: (await list(ctx, "group")).map(groupOut) };
    },
  }),
  cmd({
    service: "iam",
    operation: "list-groups-for-user",
    apiName: "ListGroupsForUser",
    summary: "List the groups a user is in",
    usage: "--user-name <name>",
    mutates: false,
    async run(args, ctx) {
      const u = await byName(ctx, "user", args.required("user-name"));
      const names = (u.config.groups as string[]) ?? [];
      return { Groups: (await list(ctx, "group")).filter((g) => names.includes(g.name)).map(groupOut) };
    },
  }),
  cmd({
    service: "iam",
    operation: "add-user-to-group",
    apiName: "AddUserToGroup",
    summary: "Add a user to a group",
    usage: "--group-name <name> --user-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await byName(ctx, "group", args.required("group-name"));
      const u = await byName(ctx, "user", args.required("user-name"));
      const groups = (u.config.groups as string[]) ?? [];
      if (!groups.includes(g.name)) await update(ctx, u, { groups: [...groups, g.name] });
    },
  }),
  cmd({
    service: "iam",
    operation: "remove-user-from-group",
    apiName: "RemoveUserFromGroup",
    summary: "Remove a user from a group",
    usage: "--group-name <name> --user-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await byName(ctx, "group", args.required("group-name"));
      const u = await byName(ctx, "user", args.required("user-name"));
      const groups = (u.config.groups as string[]) ?? [];
      if (!groups.includes(g.name)) {
        throw new EngineError("NoSuchEntity", `The user with name ${u.name} cannot be found in group ${g.name}.`, 404);
      }
      await update(ctx, u, { groups: groups.filter((x) => x !== g.name) });
    },
  }),
  cmd({
    service: "iam",
    operation: "delete-group",
    apiName: "DeleteGroup",
    summary: "Delete a group (remove its users and policies first)",
    usage: "--group-name <name>",
    mutates: true,
    async run(args, ctx) {
      const g = await byName(ctx, "group", args.required("group-name"));
      await ctx.engine.remove(ctx.accountId, g.id);
    },
  }),

  // ---------- roles ----------
  cmd({
    service: "iam",
    operation: "create-role",
    apiName: "CreateRole",
    summary: "Create a role with a trust policy",
    usage: "--role-name <name> --assume-role-policy-document <json|file://path> [--description <text>]",
    mutates: true,
    async run(args, ctx) {
      const r = await create(ctx, "role", {
        name: args.required("role-name"),
        trustPolicy: documentArg(ctx, args.required("assume-role-policy-document")),
        description: args.one("description"),
      });
      return { Role: roleOut(r) };
    },
  }),
  cmd({
    service: "iam",
    operation: "get-role",
    apiName: "GetRole",
    summary: "Show a role",
    usage: "--role-name <name>",
    mutates: false,
    async run(args, ctx) {
      return { Role: roleOut(await byName(ctx, "role", args.required("role-name"))) };
    },
  }),
  cmd({
    service: "iam",
    operation: "list-roles",
    apiName: "ListRoles",
    summary: "List roles",
    mutates: false,
    async run(_args, ctx) {
      return { Roles: (await list(ctx, "role")).map(roleOut) };
    },
  }),
  cmd({
    service: "iam",
    operation: "update-assume-role-policy",
    apiName: "UpdateAssumeRolePolicy",
    summary: "Replace a role's trust policy",
    usage: "--role-name <name> --policy-document <json|file://path>",
    mutates: true,
    async run(args, ctx) {
      const r = await byName(ctx, "role", args.required("role-name"));
      await update(ctx, r, { trustPolicy: documentArg(ctx, args.required("policy-document")) });
    },
  }),
  cmd({
    service: "iam",
    operation: "delete-role",
    apiName: "DeleteRole",
    summary: "Delete a role (detach its policies first)",
    usage: "--role-name <name>",
    mutates: true,
    async run(args, ctx) {
      const r = await byName(ctx, "role", args.required("role-name"));
      await ctx.engine.remove(ctx.accountId, r.id);
    },
  }),

  ...attachCommands("user", "User"),
  ...attachCommands("group", "Group"),
  ...attachCommands("role", "Role"),

  // ---------- policies ----------
  cmd({
    service: "iam",
    operation: "create-policy",
    apiName: "CreatePolicy",
    summary: "Create a customer managed policy",
    usage: "--policy-name <name> --policy-document <json|file://path> [--description <text>]",
    mutates: true,
    async run(args, ctx) {
      const p = await create(ctx, "policy", {
        name: args.required("policy-name"),
        document: documentArg(ctx, args.required("policy-document")),
        description: args.one("description"),
      });
      return { Policy: await policyOut(ctx, p) };
    },
  }),
  cmd({
    service: "iam",
    operation: "get-policy",
    apiName: "GetPolicy",
    summary: "Show a policy",
    usage: "--policy-arn <arn>",
    mutates: false,
    async run(args, ctx) {
      const arn = args.required("policy-arn");
      const m = managedByArn(arn);
      if (m) {
        return {
          Policy: { PolicyName: m.name, Arn: m.arn, Path: "/", DefaultVersionId: "v1", AttachmentCount: await attachmentCount(ctx, arn), IsAttachable: true, Description: m.description },
        };
      }
      const p = await customPolicy(ctx, arn);
      if (!p) throw new EngineError("NoSuchEntity", `Policy ${arn} was not found.`, 404);
      return { Policy: await policyOut(ctx, p) };
    },
  }),
  cmd({
    service: "iam",
    operation: "get-policy-version",
    apiName: "GetPolicyVersion",
    summary: "Show a policy's document",
    usage: "--policy-arn <arn> --version-id <v1>",
    mutates: false,
    async run(args, ctx) {
      const arn = args.required("policy-arn");
      const version = args.required("version-id");
      const m = managedByArn(arn);
      const p = m ? null : await customPolicy(ctx, arn);
      if (!m && !p) throw new EngineError("NoSuchEntity", `Policy ${arn} was not found.`, 404);
      const current = m ? "v1" : String(p!.attributes.defaultVersionId);
      if (version !== current) {
        throw new EngineError("NoSuchEntity", `Policy ${arn} version ${version} does not exist or is not attachable.`, 404);
      }
      return {
        PolicyVersion: {
          Document: m ? m.document : JSON.parse(String(p!.config.document)),
          VersionId: current,
          IsDefaultVersion: true,
          CreateDate: p?.updatedAt ?? new Date(0).toISOString(),
        },
      };
    },
  }),
  cmd({
    service: "iam",
    operation: "create-policy-version",
    apiName: "CreatePolicyVersion",
    summary: "Change a policy's document (becomes the new default version)",
    usage: "--policy-arn <arn> --policy-document <json|file://path> [--set-as-default]",
    mutates: true,
    async run(args, ctx) {
      const arn = args.required("policy-arn");
      const p = await customPolicy(ctx, arn);
      if (!p) throw new EngineError("NoSuchEntity", `Policy ${arn} was not found.`, 404);
      const updated = await update(ctx, p, { document: documentArg(ctx, args.required("policy-document")) });
      return { PolicyVersion: { VersionId: updated.attributes.defaultVersionId, IsDefaultVersion: true, CreateDate: updated.updatedAt } };
    },
  }),
  cmd({
    service: "iam",
    operation: "list-policies",
    apiName: "ListPolicies",
    summary: "List policies (--scope Local for yours, AWS for managed)",
    usage: "[--scope All|AWS|Local] [--only-attached]",
    mutates: false,
    async run(args, ctx) {
      const scope = args.one("scope") ?? "All";
      if (!["All", "AWS", "Local"].includes(scope)) {
        throw new EngineError("ValidationError", `1 validation error detected: Value '${scope}' at 'scope' failed to satisfy constraint: Member must satisfy enum value set: [All, AWS, Local]`);
      }
      const out = [];
      if (scope !== "Local") {
        for (const m of MANAGED_POLICIES) {
          out.push({ PolicyName: m.name, Arn: m.arn, Path: "/", DefaultVersionId: "v1", AttachmentCount: await attachmentCount(ctx, m.arn), IsAttachable: true });
        }
      }
      if (scope !== "AWS") for (const p of await list(ctx, "policy")) out.push(await policyOut(ctx, p));
      return { Policies: args.has("only-attached") ? out.filter((p) => p.AttachmentCount > 0) : out };
    },
  }),
  cmd({
    service: "iam",
    operation: "delete-policy",
    apiName: "DeletePolicy",
    summary: "Delete a customer managed policy (detach it everywhere first)",
    usage: "--policy-arn <arn>",
    mutates: true,
    async run(args, ctx) {
      const arn = args.required("policy-arn");
      if (managedByArn(arn)) throw new EngineError("AccessDenied", `Cannot delete AWS managed policy ${arn}.`, 403);
      const p = await customPolicy(ctx, arn);
      if (!p) throw new EngineError("NoSuchEntity", `Policy ${arn} was not found.`, 404);
      await ctx.engine.remove(ctx.accountId, p.id);
    },
  }),

  // ---------- access keys ----------
  cmd({
    service: "iam",
    operation: "create-access-key",
    apiName: "CreateAccessKey",
    summary: "Create an access key for a user (the secret is shown once)",
    usage: "--user-name <name>",
    mutates: true,
    async run(args, ctx) {
      const u = await byName(ctx, "user", args.required("user-name"));
      const k = await create(ctx, "access-key", { userName: u.name });
      return { AccessKey: { UserName: u.name, AccessKeyId: k.id, Status: k.config.status, SecretAccessKey: k.attributes.secretAccessKey, CreateDate: k.createdAt } };
    },
  }),
  cmd({
    service: "iam",
    operation: "list-access-keys",
    apiName: "ListAccessKeys",
    summary: "List a user's access keys",
    usage: "--user-name <name>",
    mutates: false,
    async run(args, ctx) {
      const u = await byName(ctx, "user", args.required("user-name"));
      const keys = (await list(ctx, "access-key")).filter((k) => k.config.userName === u.name);
      return { AccessKeyMetadata: keys.map((k) => ({ UserName: u.name, AccessKeyId: k.id, Status: k.config.status, CreateDate: k.createdAt })) };
    },
  }),
  cmd({
    service: "iam",
    operation: "update-access-key",
    apiName: "UpdateAccessKey",
    summary: "Activate or deactivate an access key",
    usage: "--access-key-id <id> --status Active|Inactive [--user-name <name>]",
    mutates: true,
    async run(args, ctx) {
      const id = args.required("access-key-id");
      const k = (await list(ctx, "access-key")).find((x) => x.id === id);
      if (!k) throw new EngineError("NoSuchEntity", `The Access Key with id ${id} cannot be found.`, 404);
      const status = args.required("status");
      if (status !== "Active" && status !== "Inactive") {
        throw new EngineError("ValidationError", `1 validation error detected: Value '${status}' at 'status' failed to satisfy constraint: Member must satisfy enum value set: [Active, Inactive]`);
      }
      await update(ctx, k, { status });
    },
  }),
  cmd({
    service: "iam",
    operation: "delete-access-key",
    apiName: "DeleteAccessKey",
    summary: "Delete an access key",
    usage: "--access-key-id <id> [--user-name <name>]",
    mutates: true,
    async run(args, ctx) {
      const id = args.required("access-key-id");
      const k = (await list(ctx, "access-key")).find((x) => x.id === id);
      if (!k) throw new EngineError("NoSuchEntity", `The Access Key with id ${id} cannot be found.`, 404);
      await ctx.engine.remove(ctx.accountId, k.id);
    },
  }),

  // ---------- policy simulator ----------
  cmd({
    service: "iam",
    operation: "simulate-principal-policy",
    apiName: "SimulatePrincipalPolicy",
    summary: "Check whether a user or role may perform actions",
    usage: "--policy-source-arn <user-or-role-arn> --action-names <action> ... [--resource-arns <arn> ...]",
    mutates: false,
    async run(args, ctx) {
      const source = args.required("policy-source-arn");
      const m = /^arn:aws:iam::\d{12}:(user|role)\/(.+)$/.exec(source);
      if (!m) throw new EngineError("InvalidInput", `Invalid ARN: ${source}. Use a user or role ARN.`);
      const identity: Identity = { kind: m[1] as "user" | "role", name: m[2] };
      const actions = args.list("action-names");
      if (actions.length === 0) throw new UsageError("the following arguments are required: --action-names");
      const resources = args.list("resource-arns");
      // A role is checked as itself, whatever its trust policy says.
      const principal =
        identity.kind === "role"
          ? await rolePrincipal(ctx.engine, ctx.accountId, await byName(ctx, "role", identity.name))
          : await resolvePrincipal(ctx.engine, ctx.accountId, identity);
      const results = [];
      for (const action of actions) {
        for (const resource of resources.length ? resources : ["*"]) {
          const e = check(principal, action, resource);
          results.push({
            EvalActionName: action,
            EvalResourceName: resource,
            EvalDecision: e.decision,
            MatchedStatements: e.matched.map((s) => ({ SourcePolicyId: s.policy, SourcePolicyType: "IAM Policy" })),
            MissingContextValues: [],
          });
        }
      }
      return { EvaluationResults: results };
    },
  }),
];

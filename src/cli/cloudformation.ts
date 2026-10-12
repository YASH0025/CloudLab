import { randomUUID } from "node:crypto";
import { IAM_TYPES, previewChanges, type PlannedChange, type StackEvent, type StackOutput, type StackResource } from "@/engine/cloudformation/deploy";
import { parseTemplate, validationError } from "@/engine/cloudformation/template";
import { EngineError } from "@/engine/errors";
import type { Resource } from "@/engine/types";
import type { Args, CliContext, Command } from "./commands";
import { ClientSideError, LocalPathError, parseShorthand, UsageError } from "./parse";

/**
 * `aws cloudformation`: stacks from templates (create, update, delete,
 * describe, events, resources), change sets to preview an update, template
 * validation, and `wait` for a stack to settle.
 */

const cmd = (c: Command) => c;

const stacks = (ctx: CliContext) => ctx.engine.list(ctx.accountId, { service: "cloudformation", type: "stack", region: ctx.region });

async function stackByName(ctx: CliContext, nameOrId: string): Promise<Resource> {
  const s = (await stacks(ctx)).find((x) => x.name === nameOrId || x.id === nameOrId);
  if (!s) throw validationError(`Stack with id ${nameOrId} does not exist`);
  return s;
}

function templateArg(ctx: CliContext, args: Args): string | undefined {
  const raw = args.one("template-body");
  if (raw === undefined) {
    if (args.has("template-url")) throw validationError("CloudLab can't fetch templates from S3 URLs: pass --template-body file://template.yaml");
    return undefined;
  }
  const m = /^file:\/\/(.+)$/.exec(raw);
  if (!m) return raw;
  const data = ctx.files?.[m[1]];
  if (data === undefined) throw new LocalPathError(m[1]);
  return Buffer.from(data, "base64").toString("utf8");
}

/** --parameters ParameterKey=Env,ParameterValue=prod ParameterKey=Size,UsePreviousValue=true (or JSON). */
function parametersArg(args: Args): { key: string; value?: string; usePrevious?: boolean }[] {
  const raw = args.raw("parameters");
  let items: Record<string, unknown>[];
  if (raw.length === 1 && raw[0].trim().startsWith("[")) {
    try {
      items = JSON.parse(raw[0]);
    } catch {
      throw new UsageError("Error parsing parameter '--parameters': Invalid JSON");
    }
  } else items = raw.map((r) => parseShorthand(r) as Record<string, unknown>);
  return items.map((p) => {
    if (!p.ParameterKey) throw new UsageError("Error parsing parameter '--parameters': Expected ParameterKey=<name>,ParameterValue=<value>");
    return { key: String(p.ParameterKey), value: p.ParameterValue === undefined ? undefined : String(p.ParameterValue), usePrevious: String(p.UsePreviousValue) === "true" };
  });
}

const capabilitiesOk = (args: Args) => args.list("capabilities").some((c) => c === "CAPABILITY_IAM" || c === "CAPABILITY_NAMED_IAM");

/** CAPABILITY_IAM doesn't cover IAM resources with custom names. */
function checkNamedIam(args: Args, body: string) {
  const caps = args.list("capabilities");
  if (!caps.includes("CAPABILITY_IAM") || caps.includes("CAPABILITY_NAMED_IAM")) return;
  const t = parseTemplate(body);
  const named = Object.values(t.Resources).some((r) => IAM_TYPES.includes(r.Type) && r.Properties && ("RoleName" in r.Properties || "UserName" in r.Properties || "GroupName" in r.Properties));
  if (named) throw new EngineError("InsufficientCapabilitiesException", "Requires capabilities : [CAPABILITY_NAMED_IAM]", 400);
}

const reasonOf = (s: Resource) => ((s.attributes.events as StackEvent[] | undefined) ?? []).find((e) => e.logicalId === s.name && e.status === s.state)?.reason;

function stackOut(s: Resource) {
  const outputs = (s.attributes.outputs as StackOutput[] | undefined) ?? [];
  const params = (s.attributes.parametersResolved as Record<string, string> | undefined) ?? {};
  const reason = reasonOf(s);
  return {
    StackId: s.id,
    StackName: s.name,
    ...(s.attributes.description ? { Description: s.attributes.description } : {}),
    Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    CreationTime: s.createdAt,
    ...(s.attributes.lastOperation === "UPDATE" ? { LastUpdatedTime: s.updatedAt } : {}),
    RollbackConfiguration: {},
    StackStatus: s.state,
    ...(reason ? { StackStatusReason: reason } : {}),
    DisableRollback: s.config.disableRollback === true,
    NotificationARNs: [],
    ...(s.config.acknowledgeIam ? { Capabilities: ["CAPABILITY_NAMED_IAM"] } : {}),
    ...(outputs.length
      ? { Outputs: outputs.map((o) => ({ OutputKey: o.key, OutputValue: o.value, ...(o.description ? { Description: o.description } : {}), ...(o.exportName ? { ExportName: o.exportName } : {}) })) }
      : {}),
    Tags: [],
    EnableTerminationProtection: s.config.terminationProtection === true,
    DriftInformation: { StackDriftStatus: "NOT_CHECKED" },
  };
}

interface ChangeSet {
  name: string;
  id: string;
  templateBody: string;
  parameters: { key: string; value?: string }[];
  acknowledgeIam: boolean;
  changes: PlannedChange[];
  createdAt: string;
}

function changeSetOut(s: Resource, cs: ChangeSet) {
  return {
    Changes: cs.changes.map((c) => ({
      Type: "Resource",
      ResourceChange: {
        Action: c.action,
        LogicalResourceId: c.logicalId,
        ...(c.physicalId ? { PhysicalResourceId: c.physicalId } : {}),
        ResourceType: c.type,
        ...(c.action === "Modify" ? { Replacement: c.replacement, Scope: ["Properties"], Details: (c.details ?? "").split(", ").filter(Boolean).map((Name) => ({ Target: { Attribute: "Properties", Name, RequiresRecreation: c.replacement === "True" ? "Always" : "Never" } })) } : {}),
      },
    })),
    ChangeSetName: cs.name,
    ChangeSetId: cs.id,
    StackId: s.id,
    StackName: s.name,
    CreationTime: cs.createdAt,
    ExecutionStatus: "AVAILABLE",
    Status: "CREATE_COMPLETE",
  };
}

const changeSetsOf = (s: Resource) => (s.attributes.changeSets as ChangeSet[] | undefined) ?? [];

export const CLOUDFORMATION_COMMANDS: Command[] = [
  cmd({
    service: "cloudformation",
    operation: "create-stack",
    apiName: "CreateStack",
    summary: "Create a stack: every resource in the template, in dependency order",
    usage:
      "--stack-name <name> --template-body <file://template.yaml> [--parameters ParameterKey=<k>,ParameterValue=<v> ...] [--capabilities CAPABILITY_IAM | CAPABILITY_NAMED_IAM] [--disable-rollback] [--enable-termination-protection] [--template-url <url>]",
    mutates: true,
    async run(args, ctx) {
      const body = templateArg(ctx, args);
      if (body === undefined) throw validationError("Either Template URL or Template Body must be specified.");
      checkNamedIam(args, body);
      const s = await ctx.engine.create(ctx.accountId, {
        service: "cloudformation",
        type: "stack",
        region: ctx.region,
        config: {
          name: args.required("stack-name"),
          templateBody: body,
          parameters: parametersArg(args).map(({ key, value }) => ({ key, value })),
          acknowledgeIam: capabilitiesOk(args),
          disableRollback: args.bool("disable-rollback") === true,
          terminationProtection: args.bool("enable-termination-protection") === true,
        },
      });
      return { StackId: s.id };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "update-stack",
    apiName: "UpdateStack",
    summary: "Apply a changed template or parameters to a stack",
    usage: "--stack-name <name> (--template-body <file://template.yaml> | --use-previous-template) [--parameters ParameterKey=<k>,ParameterValue=<v> | ParameterKey=<k>,UsePreviousValue=true ...] [--capabilities CAPABILITY_IAM]",
    mutates: true,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const body = args.bool("use-previous-template") ? String(s.config.templateBody) : templateArg(ctx, args);
      if (body === undefined) throw validationError("Either Template URL or Template Body must be specified.");
      checkNamedIam(args, body);
      const previous = (s.attributes.parametersResolved as Record<string, string> | undefined) ?? {};
      const parameters = parametersArg(args).map(({ key, value, usePrevious }) => ({ key, value: usePrevious ? previous[key] : value }));
      await ctx.engine.update(ctx.accountId, s.id, { templateBody: body, parameters, acknowledgeIam: capabilitiesOk(args) });
      return { StackId: s.id };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "delete-stack",
    apiName: "DeleteStack",
    summary: "Delete a stack and the resources it created",
    usage: "--stack-name <name> [--retain-resources <logical-id> ...]",
    mutates: true,
    async run(args, ctx) {
      const name = args.required("stack-name");
      const s = (await stacks(ctx)).find((x) => x.name === name || x.id === name);
      if (!s) return; // Deleting a stack that doesn't exist succeeds quietly.
      const retain = args.list("retain-resources");
      if (retain.length && s.state !== "DELETE_FAILED") throw validationError("Invalid operation on stack: RetainResources can only be specified when a stack is in the DELETE_FAILED state");
      try {
        await ctx.engine.remove(ctx.accountId, s.id, { params: { retainResources: retain } });
      } catch (e) {
        // On AWS DeleteStack only starts the work; a resource that won't go shows up as DELETE_FAILED, not as an error here.
        if (e instanceof EngineError && e.code === "DeleteFailed") return;
        throw e;
      }
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "describe-stacks",
    apiName: "DescribeStacks",
    summary: "Show stacks: status, parameters and outputs",
    usage: "[--stack-name <name>]",
    mutates: false,
    async run(args, ctx) {
      const name = args.one("stack-name");
      if (name) return { Stacks: [stackOut(await stackByName(ctx, name))] };
      return { Stacks: (await stacks(ctx)).map(stackOut) };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "list-stacks",
    apiName: "ListStacks",
    summary: "List stacks with their status",
    usage: "[--stack-status-filter <status> ...]",
    mutates: false,
    async run(args, ctx) {
      const filter = args.list("stack-status-filter");
      return {
        StackSummaries: (await stacks(ctx))
          .filter((s) => !filter.length || filter.includes(String(s.state)))
          .map((s) => ({ StackId: s.id, StackName: s.name, ...(s.attributes.description ? { TemplateDescription: s.attributes.description } : {}), CreationTime: s.createdAt, StackStatus: s.state, DriftInformation: { StackDriftStatus: "NOT_CHECKED" } })),
      };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "list-exports",
    apiName: "ListExports",
    summary: "Values stacks export for other stacks to import (Outputs with an Export name)",
    usage: "",
    mutates: false,
    async run(_args, ctx) {
      const all = await stacks(ctx);
      return {
        Exports: all.flatMap((s) =>
          ((s.attributes.outputs as StackOutput[] | undefined) ?? []).flatMap((o) => (o.exportName ? [{ ExportingStackId: s.id, Name: o.exportName, Value: o.value }] : [])),
        ),
      };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "list-imports",
    apiName: "ListImports",
    summary: "Stacks that import an exported value (they block deleting it)",
    usage: "--export-name <name>",
    mutates: false,
    async run(args, ctx) {
      const name = args.required("export-name");
      const users = (await stacks(ctx)).filter((s) => ((s.attributes.imports as string[] | undefined) ?? []).includes(name));
      if (users.length === 0) throw validationError(`Export '${name}' is not imported by any stack.`);
      return { Imports: users.map((s) => s.name) };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "describe-stack-events",
    apiName: "DescribeStackEvents",
    summary: "What happened, newest first: each resource created, updated, failed or deleted",
    usage: "--stack-name <name>",
    mutates: false,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      return {
        StackEvents: ((s.attributes.events as StackEvent[] | undefined) ?? []).map((e, i, all) => ({
          StackId: s.id,
          EventId: e.logicalId === s.name ? `${randomUUID()}` : `${e.logicalId}-${e.status}-${all.length - i}`,
          StackName: s.name,
          LogicalResourceId: e.logicalId,
          PhysicalResourceId: e.physicalId,
          ResourceType: e.type,
          Timestamp: e.timestamp,
          ResourceStatus: e.status,
          ...(e.reason ? { ResourceStatusReason: e.reason } : {}),
        })),
      };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "list-stack-resources",
    apiName: "ListStackResources",
    summary: "The resources a stack created, with their physical IDs",
    usage: "--stack-name <name>",
    mutates: false,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      return {
        StackResourceSummaries: ((s.attributes.resources as StackResource[] | undefined) ?? []).map((r) => ({
          LogicalResourceId: r.logicalId,
          PhysicalResourceId: r.physicalId,
          ResourceType: r.type,
          LastUpdatedTimestamp: r.timestamp,
          ResourceStatus: r.status,
          DriftInformation: { StackResourceDriftStatus: "NOT_CHECKED" },
        })),
      };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "describe-stack-resources",
    apiName: "DescribeStackResources",
    summary: "The resources a stack created",
    usage: "--stack-name <name> [--logical-resource-id <id>]",
    mutates: false,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const only = args.one("logical-resource-id");
      return {
        StackResources: ((s.attributes.resources as StackResource[] | undefined) ?? [])
          .filter((r) => !only || r.logicalId === only)
          .map((r) => ({ StackName: s.name, StackId: s.id, LogicalResourceId: r.logicalId, PhysicalResourceId: r.physicalId, ResourceType: r.type, Timestamp: r.timestamp, ResourceStatus: r.status })),
      };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "get-template",
    apiName: "GetTemplate",
    summary: "The template a stack was created or last updated with",
    usage: "--stack-name <name>",
    mutates: false,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const body = String(s.config.templateBody);
      let parsed: unknown = body;
      if (body.trim().startsWith("{")) parsed = JSON.parse(body);
      return { TemplateBody: parsed, StagesAvailable: ["Original", "Processed"] };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "validate-template",
    apiName: "ValidateTemplate",
    summary: "Check a template's format and list its parameters (doesn't check resource properties)",
    usage: "--template-body <file://template.yaml>",
    mutates: false,
    async run(args, ctx) {
      const body = templateArg(ctx, args);
      if (body === undefined) throw validationError("Either Template URL or Template Body must be specified.");
      const t = parseTemplate(body);
      const iam = Object.entries(t.Resources).filter(([, r]) => IAM_TYPES.includes(r.Type));
      const named = iam.some(([, r]) => r.Properties && ("RoleName" in r.Properties || "UserName" in r.Properties));
      return {
        Parameters: Object.entries(t.Parameters ?? {}).map(([k, p]) => ({ ParameterKey: k, ...(p.Default !== undefined ? { DefaultValue: String(p.Default) } : {}), NoEcho: p.NoEcho === true, ...(p.Description ? { Description: p.Description } : {}) })),
        ...(t.Description ? { Description: t.Description } : {}),
        ...(iam.length
          ? {
              Capabilities: [named ? "CAPABILITY_NAMED_IAM" : "CAPABILITY_IAM"],
              CapabilitiesReason: `The following resource(s) require capabilities: [${[...new Set(iam.map(([, r]) => r.Type))].join(", ")}]`,
            }
          : {}),
      };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "create-change-set",
    apiName: "CreateChangeSet",
    summary: "Preview what an update would add, modify (and whether it replaces) or remove",
    usage: "--stack-name <name> --change-set-name <name> (--template-body <file://t.yaml> | --use-previous-template) [--parameters …] [--capabilities CAPABILITY_IAM]",
    mutates: true,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const name = args.required("change-set-name");
      if (!/^[a-zA-Z][-a-zA-Z0-9]*$/.test(name)) throw validationError(`1 validation error detected: Value '${name}' at 'changeSetName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z][-a-zA-Z0-9]*`);
      if (changeSetsOf(s).some((c) => c.name === name)) throw new EngineError("AlreadyExistsException", `ChangeSet ${name} already exists`, 400);
      const body = args.bool("use-previous-template") ? String(s.config.templateBody) : templateArg(ctx, args);
      if (body === undefined) throw validationError("Either Template URL or Template Body must be specified.");
      const previous = (s.attributes.parametersResolved as Record<string, string> | undefined) ?? {};
      const parameters = parametersArg(args).map(({ key, value, usePrevious }) => ({ key, value: usePrevious ? previous[key] : value }));
      const changes = await previewChanges(ctx.engine, s, body, Object.fromEntries(parameters.map((p) => [p.key, p.value ?? ""])));
      const cs: ChangeSet = {
        name,
        id: s.id.replace(":stack/", ":changeSet/").replace(/\/[^/]+\/[^/]+$/, `/${name}/${randomUUID()}`),
        templateBody: body,
        parameters,
        acknowledgeIam: capabilitiesOk(args),
        changes,
        createdAt: ctx.engine.now().toISOString(),
      };
      await ctx.engine.setAttributes(ctx.accountId, s.id, { changeSets: [...changeSetsOf(s), cs] });
      return { Id: cs.id, StackId: s.id };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "describe-change-set",
    apiName: "DescribeChangeSet",
    summary: "Show a change set's changes",
    usage: "--stack-name <name> --change-set-name <name>",
    mutates: false,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const name = args.required("change-set-name");
      const cs = changeSetsOf(s).find((c) => c.name === name || c.id === name);
      if (!cs) throw new EngineError("ChangeSetNotFound", `ChangeSet [${name}] does not exist`, 404);
      return changeSetOut(s, cs);
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "execute-change-set",
    apiName: "ExecuteChangeSet",
    summary: "Apply a change set to its stack",
    usage: "--stack-name <name> --change-set-name <name>",
    mutates: true,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const name = args.required("change-set-name");
      const cs = changeSetsOf(s).find((c) => c.name === name || c.id === name);
      if (!cs) throw new EngineError("ChangeSetNotFound", `ChangeSet [${name}] does not exist`, 404);
      // Executing uses up every change set of the stack, as on AWS.
      await ctx.engine.setAttributes(ctx.accountId, s.id, { changeSets: [] });
      await ctx.engine.update(ctx.accountId, s.id, { templateBody: cs.templateBody, parameters: cs.parameters, acknowledgeIam: cs.acknowledgeIam });
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "update-termination-protection",
    apiName: "UpdateTerminationProtection",
    summary: "Turn termination protection on or off",
    usage: "--stack-name <name> (--enable-termination-protection | --no-enable-termination-protection)",
    mutates: true,
    async run(args, ctx) {
      const s = await stackByName(ctx, args.required("stack-name"));
      const on = args.bool("enable-termination-protection");
      if (on === undefined) throw new UsageError("one of the arguments --enable-termination-protection --no-enable-termination-protection is required");
      if ((s.config.terminationProtection === true) !== on) await ctx.engine.update(ctx.accountId, s.id, { terminationProtection: on });
      return { StackId: s.id };
    },
  }),
  cmd({
    service: "cloudformation",
    operation: "wait",
    apiName: "DescribeStacks",
    summary: "Wait for a stack to finish: wait stack-create-complete | stack-update-complete | stack-delete-complete --stack-name <name>",
    usage: "<stack-create-complete|stack-update-complete|stack-delete-complete> --stack-name <name>",
    mutates: false,
    async run(args, ctx) {
      const which = args.positionals[0];
      const want: Record<string, { ok: string[]; name: string }> = {
        "stack-create-complete": { ok: ["CREATE_COMPLETE"], name: "StackCreateComplete" },
        "stack-update-complete": { ok: ["UPDATE_COMPLETE"], name: "StackUpdateComplete" },
        "stack-delete-complete": { ok: [], name: "StackDeleteComplete" },
      };
      const w = want[which ?? ""];
      if (!w) throw new UsageError(`argument wait_name: Invalid choice, valid choices are:\n\n${Object.keys(want).join(" | ")}`);
      const name = args.required("stack-name");
      const s = (await stacks(ctx)).find((x) => x.name === name || x.id === name);
      if (which === "stack-delete-complete") {
        if (s) throw new ClientSideError("\n" + `Waiter ${w.name} failed: Waiter encountered a terminal failure state: For expression "Stacks[].StackStatus" we matched expected path: "${s.state}" at least once`);
        return;
      }
      if (!s) throw new ClientSideError("\n" + `Waiter ${w.name} failed: Waiter encountered a terminal failure state: Stack with id ${name} does not exist`);
      if (!w.ok.includes(String(s.state))) {
        throw new ClientSideError("\n" + `Waiter ${w.name} failed: Waiter encountered a terminal failure state: For expression "Stacks[].StackStatus" we matched expected path: "${s.state}" at least once`);
      }
    },
  }),
];

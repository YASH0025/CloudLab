import { availabilityZones } from "../catalog";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import { getTypeDef } from "../registry";
import type { Resource } from "../types";
import { HANDLERS, type Handler, type HandlerContext } from "./resources";
import {
  evaluateConditions,
  orderResources,
  parseTemplate,
  resolve,
  resolveParameters,
  validationError,
  type Json,
  type ResolveContext,
  type Template,
} from "./template";

/**
 * Running a stack: creating its resources in dependency order, updating them
 * (in place or by replacement), deleting them in reverse, and rolling back
 * when something fails. Every step is recorded as a stack event, the way the
 * CloudFormation console shows it.
 */

export interface StackResource {
  logicalId: string;
  type: string;
  /** What Ref returns / what the console shows: an ID, name, ARN or URL. */
  physicalId: string;
  /** The console resource it became (absent for types that only change another resource). */
  resourceId?: string;
  /** Where that console resource lives, for links. */
  service?: string;
  consoleType?: string;
  status: string;
  reason?: string;
  timestamp: string;
  /** The resolved properties it was created with, to compare on update and to undo. */
  props: Record<string, Json>;
}

export interface StackEvent {
  timestamp: string;
  logicalId: string;
  physicalId: string;
  type: string;
  status: string;
  reason?: string;
}

export interface StackOutput {
  key: string;
  value: string;
  description?: string;
  exportName?: string;
}

const KEEP_EVENTS = 200;
const params = (stack: Resource): Record<string, string> =>
  Object.fromEntries(((stack.config.parameters as { key: string; value?: string }[] | undefined) ?? []).map((p) => [p.key, p.value ?? ""]));

class Run {
  events: StackEvent[];
  resources: Map<string, StackResource>;
  imports = new Set<string>();

  constructor(
    readonly engine: Engine,
    readonly stack: Resource,
  ) {
    this.events = [...((stack.attributes.events as StackEvent[] | undefined) ?? [])];
    this.resources = new Map(((stack.attributes.resources as StackResource[] | undefined) ?? []).map((r) => [r.logicalId, r]));
  }

  get accountId() {
    return this.stack.accountId;
  }
  get region() {
    return this.stack.region;
  }
  now() {
    return this.engine.now().toISOString();
  }

  event(logicalId: string, type: string, physicalId: string, status: string, reason?: string) {
    this.events.unshift({ timestamp: this.now(), logicalId, physicalId, type, status, ...(reason ? { reason } : {}) });
  }
  stackEvent(status: string, reason?: string) {
    this.event(this.stack.name, "AWS::CloudFormation::Stack", this.stack.id, status, reason);
  }

  async save(extra: Record<string, unknown> = {}) {
    await this.engine.setAttributes(this.accountId, this.stack.id, {
      events: this.events.slice(0, KEEP_EVENTS),
      resources: [...this.resources.values()],
      ...extra,
    });
  }

  handlerContext(logicalId: string): HandlerContext {
    return { engine: this.engine, accountId: this.accountId, region: this.region, stackName: this.stack.name, logicalId };
  }

  resolveContext(t: Template, p: Record<string, string>, conditions: Record<string, boolean>): ResolveContext {
    return {
      params: p,
      pseudo: {
        "AWS::Region": this.region,
        "AWS::AccountId": accountNumber(this.accountId),
        "AWS::StackName": this.stack.name,
        "AWS::StackId": this.stack.id,
        "AWS::Partition": "aws",
        "AWS::URLSuffix": "amazonaws.com",
      },
      mappings: t.Mappings,
      conditions,
      azs: availabilityZones(this.region),
      ref: (id) => {
        const r = this.resources.get(id);
        if (!r) throw validationError(`Template error: instance of Fn::GetAtt or Ref references undefined resource ${id}`);
        return r.physicalId;
      },
      getAtt: (id, attr) => {
        const r = this.resources.get(id);
        if (!r) throw validationError(`Template error: instance of Fn::GetAtt references undefined resource ${id}`);
        const fn = HANDLERS[r.type]?.attrs?.[attr];
        if (!fn) throw validationError(`Template error: resource ${id} does not support attribute type ${attr} in Fn::GetAtt`);
        const live = this.live.get(id);
        if (!live) throw validationError(`Template error: resource ${id} has no attributes yet`);
        return fn(live);
      },
      importValue: (name) => {
        const v = this.exports.get(name);
        if (v === undefined) throw validationError(`No export named ${name} found.`);
        this.imports.add(name);
        return v;
      },
    };
  }

  /** The console resources, freshly read, so GetAtt sees attributes assigned after creation (a public IP). */
  live = new Map<string, Resource>();
  exports = new Map<string, string>();

  async refreshLive(id: string) {
    const r = this.resources.get(id);
    if (r?.resourceId) {
      const res = await this.engine.get(this.accountId, r.resourceId).catch(() => null);
      if (res) this.live.set(id, res);
    }
  }

  async loadExports() {
    const stacks = await this.engine.list(this.accountId, { service: "cloudformation", type: "stack", region: this.region });
    for (const s of stacks) {
      if (s.id === this.stack.id) continue;
      for (const o of (s.attributes.outputs as StackOutput[] | undefined) ?? []) if (o.exportName) this.exports.set(o.exportName, o.value);
    }
  }
}

/** Template, parameters and the resources that are on, as of the stack's current settings. */
export function plan(stack: Resource) {
  const t = parseTemplate(String(stack.config.templateBody));
  const p = resolveParameters(t, params(stack));
  return { t, p };
}

function checkProps(h: Handler, logicalId: string, props: Record<string, Json>) {
  const extra = Object.keys(props).filter((k) => !h.props.includes(k));
  if (extra.length) throw validationError(`Properties validation failed for resource ${logicalId} with message: #: extraneous key [${extra[0]}] is not permitted`);
  const missing = (h.required ?? []).filter((k) => props[k] === undefined);
  if (missing.length) throw validationError(`Properties validation failed for resource ${logicalId} with message: #: required key [${missing[0]}] not found`);
}

/** What CloudFormation shows when a service call fails. */
function handlerMessage(e: unknown, type: string): string {
  if (e instanceof EngineError) {
    if (e.code === "ValidationError" && /^(Properties validation|Template error)/.test(e.message)) return e.message;
    const service = type.split("::")[1];
    return `Resource handler returned message: "${e.message}" (Service: ${service}, Status Code: ${e.status ?? 400}, Error Code: ${e.code})`;
  }
  return `Internal Failure: ${String(e)}`;
}

/** Whether new settings change a field that can't be changed in place. */
function needsReplacement(h: Handler, existing: Resource | null, config: Record<string, unknown>): boolean {
  if (!h.service || !h.type || !existing) return false;
  const def = getTypeDef(h.service, h.type);
  const norm = (v: unknown) => JSON.stringify(v === "" || v === null || v === undefined ? null : v);
  return def.fields.some((f) => f.immutable && f.key in config && config[f.key] !== undefined && norm(config[f.key]) !== norm(existing.config[f.key]));
}

async function createOne(run: Run, logicalId: string, type: string, props: Record<string, Json>): Promise<StackResource> {
  const h = HANDLERS[type];
  const c = run.handlerContext(logicalId);
  checkProps(h, logicalId, props);
  if (h.apply) {
    const physicalId = await h.apply(props, c);
    return { logicalId, type, physicalId, status: "CREATE_COMPLETE", timestamp: run.now(), props };
  }
  const config = await h.config!(props, c);
  const created = await run.engine.create(
    run.accountId,
    { service: h.service!, type: h.type!, region: run.region, config },
    { settled: true, system: { stack: run.stack.id, logicalId } },
  );
  const live = await run.engine.get(run.accountId, created.id);
  run.live.set(logicalId, live);
  return { logicalId, type, physicalId: h.ref(live), resourceId: created.id, service: h.service, consoleType: h.type, status: "CREATE_COMPLETE", timestamp: run.now(), props };
}

async function deleteOne(run: Run, r: StackResource) {
  const h = HANDLERS[r.type];
  if (h?.undo) return h.undo(r.physicalId, r.props, run.handlerContext(r.logicalId));
  if (!r.resourceId) return;
  const exists = await run.engine.get(run.accountId, r.resourceId).catch(() => null);
  if (!exists) return; // already gone: deleted outside CloudFormation
  // Instances are terminated, not deleted, as CloudFormation does.
  if (exists.type === "instance") {
    if (exists.state !== "terminated") await run.engine.runAction(run.accountId, exists.id, "terminate");
    return;
  }
  await run.engine.remove(run.accountId, r.resourceId);
}

/** Creates every resource of a new stack; on failure, deletes what was made (unless rollback is disabled). */
export async function createStack(engine: Engine, stack: Resource) {
  const run = new Run(engine, stack);
  await run.loadExports();
  run.stackEvent("CREATE_IN_PROGRESS", "User Initiated");
  const { t, p } = plan(stack);
  const conditions = evaluateConditions(t, run.resolveContext(t, p, {}) as never);
  const ctx = run.resolveContext(t, p, conditions);
  const active = Object.keys(t.Resources).filter((id) => !t.Resources[id].Condition || conditions[t.Resources[id].Condition!]);
  const order = orderResources(t, active);
  const created: StackResource[] = [];
  try {
    for (const id of order) {
      const decl = t.Resources[id];
      run.event(id, decl.Type, "", "CREATE_IN_PROGRESS");
      try {
        const props = resolve(decl.Properties ?? {}, ctx) as Record<string, Json>;
        const r = await createOne(run, id, decl.Type, props);
        run.resources.set(id, r);
        created.push(r);
        run.event(id, decl.Type, r.physicalId, "CREATE_IN_PROGRESS", "Resource creation Initiated");
        run.event(id, decl.Type, r.physicalId, "CREATE_COMPLETE");
      } catch (e) {
        run.event(id, decl.Type, "", "CREATE_FAILED", handlerMessage(e, decl.Type));
        throw Object.assign(new Error("failed"), { logicalId: id });
      }
      for (const done of created) await run.refreshLive(done.logicalId);
    }
    const outputs = await resolveOutputs(run, t, ctx, conditions);
    run.stackEvent("CREATE_COMPLETE");
    await run.save({ outputs, imports: [...run.imports], description: t.Description ?? null, parametersResolved: p, lastOperation: "CREATE" });
    await engine.runAction(run.accountId, stack.id, "complete-create");
  } catch (e) {
    const failed = (e as { logicalId?: string }).logicalId;
    const reason = failed ? `The following resource(s) failed to create: [${failed}]. ` : `${handlerMessage(e, "AWS::CloudFormation::Stack")} `;
    if (stack.config.disableRollback === true) {
      run.stackEvent("CREATE_FAILED", `${reason}Rollback disabled: the resources that were created are kept so you can look at them.`);
      await run.save({ lastOperation: "CREATE" });
      await engine.runAction(run.accountId, stack.id, "fail-create");
      return;
    }
    run.stackEvent("ROLLBACK_IN_PROGRESS", `${reason}Rollback requested by user.`);
    for (const r of [...created].reverse()) {
      run.event(r.logicalId, r.type, r.physicalId, "DELETE_IN_PROGRESS");
      try {
        await deleteOne(run, r);
        run.event(r.logicalId, r.type, r.physicalId, "DELETE_COMPLETE");
        run.resources.delete(r.logicalId);
      } catch (err) {
        run.event(r.logicalId, r.type, r.physicalId, "DELETE_FAILED", handlerMessage(err, r.type));
      }
    }
    run.stackEvent("ROLLBACK_COMPLETE");
    await run.save({ outputs: [], lastOperation: "CREATE" });
    await engine.runAction(run.accountId, stack.id, "rollback-create");
  }
}

async function resolveOutputs(run: Run, t: Template, ctx: ResolveContext, conditions: Record<string, boolean>): Promise<StackOutput[]> {
  const out: StackOutput[] = [];
  const others = await run.engine.list(run.accountId, { service: "cloudformation", type: "stack", region: run.region });
  for (const [key, o] of Object.entries(t.Outputs ?? {})) {
    if (o.Condition && !conditions[o.Condition]) continue;
    const value = resolve(o.Value, ctx);
    const exportName = o.Export ? String(resolve(o.Export.Name, ctx)) : undefined;
    if (exportName) {
      const owner = others.find((s) => s.id !== run.stack.id && ((s.attributes.outputs as StackOutput[] | undefined) ?? []).some((x) => x.exportName === exportName));
      if (owner) throw validationError(`Export with name ${exportName} is already exported by stack ${owner.name}`);
    }
    out.push({ key, value: Array.isArray(value) ? value.join(",") : String(value), ...(o.Description ? { description: o.Description } : {}), ...(exportName ? { exportName } : {}) });
  }
  return out;
}

// ---------- updates ----------

export interface PlannedChange {
  action: "Add" | "Modify" | "Remove";
  logicalId: string;
  type: string;
  physicalId?: string;
  /** For Modify: whether the resource is replaced (a new one created, the old deleted). */
  replacement?: "True" | "False";
  /** Why it's replaced, or which properties change. */
  details?: string;
}

/**
 * Applies a new template/parameters to a running stack: new resources are
 * created, changed ones updated in place or replaced, removed ones deleted
 * at the end (cleanup). If anything fails, everything goes back.
 */
export async function updateStack(engine: Engine, stack: Resource, previous: Resource) {
  const run = new Run(engine, stack);
  await run.loadExports();
  run.stackEvent("UPDATE_IN_PROGRESS", "User Initiated");
  await engine.runAction(run.accountId, stack.id, "begin-update");

  const undo: (() => Promise<void>)[] = [];
  const cleanup: StackResource[] = [];
  try {
    const { t, p } = plan(stack);
    for (const r of run.resources.values()) await run.refreshLive(r.logicalId);
    const conditions = evaluateConditions(t, run.resolveContext(t, p, {}) as never);
    const ctx = run.resolveContext(t, p, conditions);
    const active = Object.keys(t.Resources).filter((id) => !t.Resources[id].Condition || conditions[t.Resources[id].Condition!]);
    const order = orderResources(t, active);
    const before = new Map(run.resources);

    for (const id of order) {
      const decl = t.Resources[id];
      const old = before.get(id);
      let props: Record<string, Json>;
      try {
        props = resolve(decl.Properties ?? {}, ctx) as Record<string, Json>;
      } catch (e) {
        run.event(id, decl.Type, old?.physicalId ?? "", old ? "UPDATE_FAILED" : "CREATE_FAILED", handlerMessage(e, decl.Type));
        throw Object.assign(new Error("failed"), { logicalId: id });
      }
      if (!old || old.type !== decl.Type) {
        run.event(id, decl.Type, "", "CREATE_IN_PROGRESS");
        try {
          const r = await createOne(run, id, decl.Type, props);
          run.resources.set(id, r);
          undo.push(async () => deleteOne(run, r));
          run.event(id, decl.Type, r.physicalId, "CREATE_COMPLETE");
          if (old) cleanup.push(old);
        } catch (e) {
          run.event(id, decl.Type, "", "CREATE_FAILED", handlerMessage(e, decl.Type));
          throw Object.assign(new Error("failed"), { logicalId: id });
        }
        await run.refreshLive(id);
        continue;
      }
      if (JSON.stringify(props) === JSON.stringify(old.props)) continue;

      const h = HANDLERS[decl.Type];
      run.event(id, decl.Type, old.physicalId, "UPDATE_IN_PROGRESS");
      try {
        checkProps(h, id, props);
        if (h.apply) {
          // Types that only change another resource: undo the old change, apply the new one.
          await h.undo!(old.physicalId, old.props, run.handlerContext(id));
          const physicalId = await h.apply(props, run.handlerContext(id));
          run.resources.set(id, { ...old, physicalId, props, status: "UPDATE_COMPLETE", timestamp: run.now() });
          undo.push(async () => {
            await h.undo!(physicalId, props, run.handlerContext(id));
            await h.apply!(old.props, run.handlerContext(id));
          });
        } else {
          const existing = old.resourceId ? await engine.get(run.accountId, old.resourceId).catch(() => null) : null;
          // Keep the generated name: an unnamed resource keeps its physical name across updates.
          const config = await h.config!(props, run.handlerContext(id));
          if (existing && h.nameProp && props[h.nameProp] === undefined) config.name = existing.name;
          if (needsReplacement(h, existing, config) || !existing) {
            if (h.nameProp && props[h.nameProp] !== undefined && existing && String(props[h.nameProp]) === existing.name) {
              throw validationError(`CloudFormation cannot update a stack when a custom-named resource requires replacing. Rename ${String(props[h.nameProp])} and update the stack again.`);
            }
            if (existing && h.nameProp && props[h.nameProp] === undefined) delete config.name;
            const fresh = await createOne(run, id, decl.Type, props);
            run.event(id, decl.Type, fresh.physicalId, "UPDATE_IN_PROGRESS", "Requested update requires the creation of a new physical resource; hence creating one.");
            run.resources.set(id, { ...fresh, status: "UPDATE_COMPLETE" });
            undo.push(async () => deleteOne(run, fresh));
            cleanup.push(old);
          } else {
            const prior = { ...existing.config };
            await engine.update(run.accountId, existing.id, config);
            const live = await engine.get(run.accountId, existing.id);
            run.live.set(id, live);
            run.resources.set(id, { ...old, physicalId: h.ref(live), props, status: "UPDATE_COMPLETE", timestamp: run.now() });
            undo.push(async () => {
              await engine.update(run.accountId, existing.id, prior);
            });
          }
        }
        run.event(id, decl.Type, run.resources.get(id)!.physicalId, "UPDATE_COMPLETE");
        await run.refreshLive(id);
      } catch (e) {
        run.event(id, decl.Type, old.physicalId, "UPDATE_FAILED", handlerMessage(e, decl.Type));
        throw Object.assign(new Error("failed"), { logicalId: id });
      }
    }

    // Removed from the template: deleted during cleanup, after everything else worked.
    for (const [id, r] of before) if (!order.includes(id)) cleanup.push(r);
    const outputs = await resolveOutputs(run, t, ctx, conditions);

    run.stackEvent("UPDATE_COMPLETE_CLEANUP_IN_PROGRESS");
    for (const r of cleanup.reverse()) {
      run.event(r.logicalId, r.type, r.physicalId, "DELETE_IN_PROGRESS");
      try {
        await deleteOne(run, r);
        run.event(r.logicalId, r.type, r.physicalId, "DELETE_COMPLETE");
      } catch (e) {
        // Cleanup failures don't fail the update; the old resource is left behind.
        run.event(r.logicalId, r.type, r.physicalId, "DELETE_FAILED", handlerMessage(e, r.type));
      }
      if (!order.includes(r.logicalId)) run.resources.delete(r.logicalId);
    }
    run.stackEvent("UPDATE_COMPLETE");
    await run.save({ outputs, imports: [...run.imports], description: t.Description ?? null, parametersResolved: p, lastOperation: "UPDATE", rollbackConfig: null });
    await engine.runAction(run.accountId, stack.id, "complete-update");
  } catch (e) {
    const failed = (e as { logicalId?: string }).logicalId;
    run.stackEvent("UPDATE_ROLLBACK_IN_PROGRESS", failed ? `The following resource(s) failed to update: [${failed}]. ` : handlerMessage(e, "AWS::CloudFormation::Stack"));
    for (const u of undo.reverse()) await u().catch(() => undefined);
    // The resources are as they were; so is the stack's record of them.
    run.resources = new Map(((previous.attributes.resources as StackResource[] | undefined) ?? []).map((r) => [r.logicalId, r]));
    run.stackEvent("UPDATE_ROLLBACK_COMPLETE");
    // The stack's settings go back too (the flag stops this update from deploying again).
    await run.save({ lastOperation: "UPDATE", rollbackConfig: true });
    await engine.update(run.accountId, stack.id, { templateBody: previous.config.templateBody, parameters: previous.config.parameters, acknowledgeIam: previous.config.acknowledgeIam });
    await engine.setAttributes(run.accountId, stack.id, { rollbackConfig: null });
    await engine.runAction(run.accountId, stack.id, "rollback-update");
  }
}

/** What an update would do, without doing it (a change set). */
export async function previewChanges(engine: Engine, stack: Resource, templateBody: string, given: Record<string, string>): Promise<PlannedChange[]> {
  const run = new Run(engine, stack);
  await run.loadExports();
  const t = parseTemplate(templateBody);
  const p = resolveParameters(t, given);
  for (const r of run.resources.values()) await run.refreshLive(r.logicalId);
  const conditions = evaluateConditions(t, run.resolveContext(t, p, {}) as never);
  const active = Object.keys(t.Resources).filter((id) => !t.Resources[id].Condition || conditions[t.Resources[id].Condition!]);
  const order = orderResources(t, active);
  // Refs to resources that don't exist yet, or will be replaced, resolve to a placeholder: their value will change.
  const ctx = run.resolveContext(t, p, conditions);
  const fresh = new Set<string>();
  const safeCtx: ResolveContext = {
    ...ctx,
    ref: (id) => (run.resources.has(id) && !fresh.has(id) ? ctx.ref(id) : `{{${id}}}`),
    getAtt: (id, attr) => (run.live.has(id) && !fresh.has(id) ? ctx.getAtt(id, attr) : `{{${id}.${attr}}}`),
  };
  const changes: PlannedChange[] = [];
  for (const id of order) {
    const decl = t.Resources[id];
    const old = run.resources.get(id);
    if (!old || old.type !== decl.Type) {
      if (old) changes.push({ action: "Remove", logicalId: id, type: old.type, physicalId: old.physicalId });
      changes.push({ action: "Add", logicalId: id, type: decl.Type });
      fresh.add(id);
      continue;
    }
    const props = resolve(decl.Properties ?? {}, safeCtx) as Record<string, Json>;
    if (JSON.stringify(props) === JSON.stringify(old.props)) continue;
    const changed = [...new Set([...Object.keys(props), ...Object.keys(old.props)])].filter((k) => JSON.stringify(props[k]) !== JSON.stringify(old.props[k]));
    const h = HANDLERS[decl.Type];
    let replacement: "True" | "False" = "False";
    if (h.config && old.resourceId) {
      const existing = await engine.get(run.accountId, old.resourceId).catch(() => null);
      try {
        const config = await h.config(props, run.handlerContext(id));
        if (existing && h.nameProp && props[h.nameProp] === undefined) config.name = existing.name;
        replacement = needsReplacement(h, existing, config) ? "True" : "False";
      } catch {
        replacement = "False";
      }
    } else if (h.apply) replacement = "True";
    if (replacement === "True") fresh.add(id);
    changes.push({ action: "Modify", logicalId: id, type: decl.Type, physicalId: old.physicalId, replacement, details: changed.join(", ") });
  }
  for (const [id, r] of run.resources) if (!active.includes(id)) changes.push({ action: "Remove", logicalId: id, type: r.type, physicalId: r.physicalId });
  return changes;
}

// ---------- deletion ----------

/** Deletes a stack's resources in reverse order. Throws (and marks DELETE_FAILED) if any can't be deleted. */
export async function deleteStackResources(engine: Engine, stack: Resource, retain: string[] = []) {
  const run = new Run(engine, stack);
  // An export another stack imports can't go away.
  const stacks = await engine.list(stack.accountId, { service: "cloudformation", type: "stack", region: stack.region });
  for (const o of (stack.attributes.outputs as StackOutput[] | undefined) ?? []) {
    if (!o.exportName) continue;
    const user = stacks.find((s) => s.id !== stack.id && ((s.attributes.imports as string[] | undefined) ?? []).includes(o.exportName!));
    if (user) throw validationError(`Export ${o.exportName} cannot be deleted as it is in use by ${user.name}`);
  }
  run.stackEvent("DELETE_IN_PROGRESS", "User Initiated");
  const created = [...run.resources.values()];
  const order = topoReverse(stack, created);
  const failed: string[] = [];
  for (const r of order) {
    const decl = (safeTemplate(stack)?.Resources ?? {})[r.logicalId];
    if (decl?.DeletionPolicy === "Retain" || retain.includes(r.logicalId)) {
      run.event(r.logicalId, r.type, r.physicalId, "DELETE_SKIPPED");
      run.resources.delete(r.logicalId);
      continue;
    }
    run.event(r.logicalId, r.type, r.physicalId, "DELETE_IN_PROGRESS");
    try {
      await deleteOne(run, r);
      run.event(r.logicalId, r.type, r.physicalId, "DELETE_COMPLETE");
      run.resources.delete(r.logicalId);
    } catch (e) {
      run.event(r.logicalId, r.type, r.physicalId, "DELETE_FAILED", handlerMessage(e, r.type));
      failed.push(r.logicalId);
    }
  }
  if (failed.length) {
    const reason = `The following resource(s) failed to delete: [${failed.join(", ")}]. `;
    run.stackEvent("DELETE_FAILED", reason);
    await run.save({ lastOperation: "DELETE" });
    await engine.runAction(stack.accountId, stack.id, "fail-delete");
    throw new EngineError("DeleteFailed", reason.trim(), 400);
  }
}

function safeTemplate(stack: Resource): Template | null {
  try {
    return parseTemplate(String(stack.config.templateBody));
  } catch {
    return null;
  }
}

/** Reverse dependency order, from the template (falling back to reverse creation order). */
function topoReverse(stack: Resource, resources: StackResource[]): StackResource[] {
  const t = safeTemplate(stack);
  if (!t) return [...resources].reverse();
  try {
    const ids = resources.map((r) => r.logicalId).filter((id) => id in t.Resources);
    const order = orderResources(t, ids);
    const byId = new Map(resources.map((r) => [r.logicalId, r]));
    const rest = resources.filter((r) => !order.includes(r.logicalId));
    return [...rest.reverse(), ...order.reverse().map((id) => byId.get(id)!)];
  } catch {
    return [...resources].reverse();
  }
}

export const IAM_TYPES = ["AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy", "AWS::IAM::User", "AWS::IAM::Group", "AWS::IAM::InstanceProfile"];

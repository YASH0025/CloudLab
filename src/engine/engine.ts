import { isRegion } from "./catalog";
import { EngineError, errors } from "./errors";
import { buildSchema, collectRefs } from "./fields";
import { generateId } from "./ids";
import { scheduleTransition, settle } from "./lifecycle";
import { getTypeDef, resolveTypeDef } from "./registry";
import type { ResourceStore } from "./store";
import type { HookContext, Resource, ResourceDTO, ResourceTypeDef } from "./types";

export function toDTO(r: Resource): ResourceDTO {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { accountId, refs, ...dto } = r;
  return dto;
}

function isActive(r: Resource): boolean {
  const def = getTypeDef(r.service, r.type);
  const inactive = def.lifecycle?.inactiveStates ?? [];
  return !r.state || !inactive.includes(r.state);
}

/**
 * The generic resource engine. It knows nothing about any one service: all
 * behaviour comes from the type definitions in the registry.
 */
export class Engine {
  constructor(
    private store: ResourceStore,
    private now: () => Date = () => new Date(),
  ) {}

  private context(accountId: string, region: string): HookContext {
    return {
      accountId,
      region,
      get: (id) => this.get(accountId, id).catch(() => null),
      list: async (service, type) =>
        (await this.list(accountId, { service, type, region })).filter(isActive),
      existsGlobally: (id) => this.store.getAny(id),
    };
  }

  /** Settles pending transitions and writes the new state back. */
  private async settleAndSave(resource: Resource): Promise<Resource> {
    const { resource: settled, changed } = settle(resource, this.now());
    if (changed) await this.store.update(settled);
    return settled;
  }

  private async validateConfig(
    def: ResourceTypeDef,
    region: string,
    config: Record<string, unknown>,
    existing: Resource | null,
    ctx: HookContext,
  ): Promise<Record<string, unknown>> {
    const resolved = resolveTypeDef(def, region);
    const parsed = buildSchema(resolved.fields).safeParse(config);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const fieldErrors = parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
      throw errors.validation(first?.message ?? "Invalid input.", fieldErrors);
    }
    const clean = parsed.data as Record<string, unknown>;

    // Every referenced resource must exist, be the right type, live in the same region and be in use.
    for (const field of def.fields) {
      if (field.type !== "ref" || !field.ref) continue;
      const value = clean[field.key];
      const ids = Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : [];
      for (const id of ids) {
        const target = await this.get(ctx.accountId, id).catch(() => null);
        const targetDef = getTypeDef(field.ref.service, field.ref.type);
        if (!target || target.service !== field.ref.service || target.type !== field.ref.type) {
          throw errors.notFound(targetDef.notFoundCode, id);
        }
        if (target.region !== region) {
          throw errors.invalidParameter(`${targetDef.label} '${id}' is in ${target.region}, not ${region}.`);
        }
        if (!isActive(target)) {
          throw errors.invalidParameter(`${targetDef.label} '${id}' is ${target.state} and cannot be used.`);
        }
      }
    }

    if (def.validate) await def.validate({ config: clean, existing, ctx });
    return clean;
  }

  async list(accountId: string, filter: { service?: string; type?: string; region?: string } = {}) {
    const items = await this.store.list(accountId, filter);
    return Promise.all(items.map((r) => this.settleAndSave(r)));
  }

  async get(accountId: string, id: string): Promise<Resource> {
    const r = await this.store.get(accountId, id);
    if (!r) throw new EngineError("ResourceNotFound", `The resource '${id}' does not exist.`, 404);
    return this.settleAndSave(r);
  }

  async create(
    accountId: string,
    input: { service: string; type: string; region: string; config: Record<string, unknown> },
  ): Promise<Resource> {
    const def = getTypeDef(input.service, input.type);
    if (!isRegion(input.region)) throw errors.invalidParameter(`Unknown region '${input.region}'.`);
    const ctx = this.context(accountId, input.region);
    const config = await this.validateConfig(def, input.region, input.config ?? {}, null, ctx);

    const name = typeof config.name === "string" ? config.name : "";
    const id = def.idFromName ? name : generateId(def.idPrefix);
    if (def.idFromName && (await this.store.getAny(id))) {
      throw new EngineError("AlreadyExists", `A ${def.label.toLowerCase()} named '${id}' already exists.`, 409);
    }

    const attributes = def.derive ? await def.derive({ id, config, existing: null, ctx }) : {};
    const nowIso = this.now().toISOString();
    let resource: Resource = {
      id,
      accountId,
      region: input.region,
      service: def.service,
      type: def.type,
      name,
      state: null,
      pendingState: null,
      transitionAt: null,
      config,
      attributes,
      refs: collectRefs(def.fields, config),
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const life = def.lifecycle?.create;
    if (life) {
      resource = life.settlesTo
        ? scheduleTransition(resource, { via: life.state, to: life.settlesTo, afterMs: life.afterMs }, this.now())
        : { ...resource, state: life.state };
    }

    await this.store.insert(resource);
    return resource;
  }

  async update(accountId: string, id: string, patch: Record<string, unknown>): Promise<Resource> {
    const existing = await this.get(accountId, id);
    const def = getTypeDef(existing.service, existing.type);

    // "", null and undefined all mean "not set", so they count as the same value.
    const norm = (v: unknown) => JSON.stringify(v === "" || v === null || v === undefined ? null : v);
    for (const field of def.fields) {
      if (!(field.key in patch)) continue;
      const changed = norm(patch[field.key]) !== norm(existing.config[field.key]);
      if (!changed) continue;
      if (field.immutable) {
        throw errors.invalidParameter(`${field.label} cannot be changed after creation.`);
      }
      if (field.mutableInStates && (!existing.state || !field.mutableInStates.includes(existing.state))) {
        throw errors.incorrectState(id, existing.state, `change ${field.label.toLowerCase()} (allowed when ${field.mutableInStates.join(" or ")})`);
      }
    }

    const ctx = this.context(accountId, existing.region);
    const config = await this.validateConfig(def, existing.region, { ...existing.config, ...patch }, existing, ctx);
    const attributes = def.derive ? await def.derive({ id, config, existing, ctx }) : existing.attributes;

    const updated: Resource = {
      ...existing,
      name: typeof config.name === "string" ? config.name : existing.name,
      config,
      attributes,
      refs: collectRefs(def.fields, config),
      updatedAt: this.now().toISOString(),
    };
    await this.store.update(updated);
    return updated;
  }

  async runAction(accountId: string, id: string, action: string): Promise<Resource> {
    const existing = await this.get(accountId, id);
    const def = getTypeDef(existing.service, existing.type);
    const actionDef = def.lifecycle?.actions?.[action];
    if (!actionDef) throw errors.unsupportedAction(action);
    if (!existing.state || !actionDef.from.includes(existing.state)) {
      throw errors.incorrectState(id, existing.state, actionDef.label.toLowerCase());
    }
    const updated = scheduleTransition(existing, actionDef, this.now());
    await this.store.update(updated);
    return updated;
  }

  async remove(accountId: string, id: string): Promise<void> {
    const existing = await this.get(accountId, id);
    const def = getTypeDef(existing.service, existing.type);
    const deletable = def.lifecycle?.deletableStates;
    if (deletable && (!existing.state || !deletable.includes(existing.state))) {
      throw errors.incorrectState(id, existing.state, `be deleted (allowed when ${deletable.join(" or ")})`);
    }
    const dependents = (await this.dependents(accountId, id)).filter(isActive);
    if (dependents.length > 0) throw errors.dependency(id, dependents.map((d) => d.id));
    await this.store.delete(accountId, id);
  }

  /** Resources that point at `id`, settled to their current state. */
  async dependents(accountId: string, id: string): Promise<Resource[]> {
    const items = await this.store.findReferencing(accountId, id);
    return Promise.all(items.map((r) => this.settleAndSave(r)));
  }
}

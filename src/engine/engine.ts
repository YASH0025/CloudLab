import type { z } from "zod";
import { isRegion } from "./catalog";
import { EngineError, errors } from "./errors";
import { buildSchema, collectRefs, type IssueKind } from "./fields";
import { generateId } from "./ids";
import { scheduleTransition, settle } from "./lifecycle";
import { getTypeDef, resolveTypeDef, SERVICES } from "./registry";
import type { ResourceStore } from "./store";
import {
  systemOf,
  type FieldDef,
  type HookContext,
  type Resource,
  type ResourceDTO,
  type ResourceTypeDef,
  type SystemApi,
  type SystemInfo,
} from "./types";

export function toDTO(r: Resource): ResourceDTO {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { accountId, refs, ...dto } = r;
  return dto;
}

/** Keeps the platform's `system` markers when attributes are re-derived. */
function keepSystem(attributes: Record<string, unknown>, existing: Resource | null): Record<string, unknown> {
  const system = existing?.attributes.system;
  return system ? { ...attributes, system } : attributes;
}

function isActive(r: Resource): boolean {
  const def = getTypeDef(r.service, r.type);
  const inactive = def.lifecycle?.inactiveStates ?? [];
  return !r.state || !inactive.includes(r.state);
}

// ---------- IDs and the errors the real API gives for them ----------

const ALL_TYPES = () => SERVICES.flatMap((s) => s.types);

/** The resource type an ID belongs to, judged by its prefix (vpc-, subnet-, i-...). */
function typeForId(id: string): ResourceTypeDef | undefined {
  return ALL_TYPES().find((t) => !t.idFromName && id.startsWith(`${t.idPrefix}-`));
}

/** Real IDs are the prefix plus 8 or 17 hex digits. */
function isWellFormed(def: ResourceTypeDef, id: string): boolean {
  return def.idFromName || new RegExp(`^${def.idPrefix}-([0-9a-f]{8}|[0-9a-f]{17})$`).test(id);
}

export function notFoundError(def: ResourceTypeDef, id: string): EngineError {
  if (def.idFromName) return errors.notFound(def.notFoundCode, "The specified bucket does not exist");
  if (def.type === "security-group") return errors.notFound(def.notFoundCode, `The security group '${id}' does not exist`);
  return errors.notFound(def.notFoundCode, `The ${def.apiNoun} ID '${id}' does not exist`);
}

function malformedError(def: ResourceTypeDef, id: string): EngineError {
  const code =
    def.notFoundCode === "InvalidGroup.NotFound" ? "InvalidGroupId.Malformed" : def.notFoundCode.replace(/\.NotFound$/, ".Malformed");
  return errors.malformed(code, id, def.idPrefix);
}

function stateError(def: ResourceTypeDef, message: string) {
  return new EngineError(def.stateErrorCode ?? "IncorrectState", message);
}

// ---------- validation errors in the real API's words ----------

function issueToError(
  def: ResourceTypeDef,
  issue: z.core.$ZodIssue,
  input: Record<string, unknown>,
  region: string,
  details: unknown,
): EngineError {
  const [top, index, sub] = issue.path as (string | number)[];
  let field: FieldDef | undefined = def.fields.find((f) => f.key === top);
  let value: unknown = input[top as string];
  const nested = sub !== undefined && field?.type === "list";
  if (nested) {
    field = field!.item?.find((f) => f.key === sub);
    value = (input[top as string] as Record<string, unknown>[] | undefined)?.[index as number]?.[sub as string];
  }
  if (!field) return errors.invalidParameter(issue.message, details);

  const param = field.param ?? field.key;
  const kind = (issue as { params?: { kind?: IssueKind } }).params?.kind;
  if (kind === "missing") return errors.missingParameter(param, details);

  const custom = def.invalidValue?.({ field, value, region });
  if (custom) return new EngineError(custom.code, custom.message, custom.status, details);

  if (kind === "cidr-range") {
    return new EngineError(field.rangeErrorCode ?? "InvalidParameterValue", `The CIDR '${value}' is invalid.`, 400, details);
  }
  if (kind === "cidr-format" || kind === "cidr-host-bits") {
    return nested
      ? errors.invalidParameter(`CIDR block ${value} is malformed`, details)
      : errors.invalidValue(param, value, "This is not a valid CIDR block.", details);
  }
  if (kind === "enum") return errors.invalidValue(param, value, undefined, details);
  return errors.invalidValue(param, value, issue.message, details);
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
      list: async (service, type) => (await this.list(accountId, { service, type, region })).filter(isActive),
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
      // Friendly per-field messages for the console form; the headline error is the real API's.
      const details = parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
      throw issueToError(def, parsed.error.issues[0], config, region, details);
    }
    const clean = parsed.data as Record<string, unknown>;

    // Referenced resources must be well-formed IDs of the right type, in this region and still in use.
    for (const field of def.fields) {
      if (field.type !== "ref" || !field.ref) continue;
      const value = clean[field.key];
      const ids = Array.isArray(value) ? (value as string[]) : typeof value === "string" ? [value] : [];
      for (const id of ids) {
        const target = await this.getTyped(ctx.accountId, id, field.ref.service, field.ref.type, region);
        if (!isActive(target)) {
          throw errors.invalidParameter(`The ${getTypeDef(target.service, target.type).apiNoun} '${id}' is ${target.state}.`);
        }
      }
    }

    // Same for refs inside list items, e.g. a rule's source security group. Weak ones are left to the service.
    for (const field of def.fields) {
      if (field.type !== "list" || !Array.isArray(clean[field.key])) continue;
      for (const sub of (field.item ?? []).filter((f) => f.type === "ref" && f.ref && !f.ref.weak)) {
        for (const item of clean[field.key] as Record<string, unknown>[]) {
          const id = item?.[sub.key];
          if (typeof id !== "string" || !id) continue;
          if (existing && id === existing.id) continue; // a security group may reference itself
          await this.getTyped(ctx.accountId, id, sub.ref!.service, sub.ref!.type, region);
        }
      }
    }

    if (def.validate) await def.validate({ config: clean, existing, ctx });
    return clean;
  }

  private systemApi(accountId: string, region: string): SystemApi {
    return {
      create: (service, type, config, system) => this.create(accountId, { service, type, region, config }, { system, settled: true }),
      update: (id, patch) => this.update(accountId, id, patch),
    };
  }

  async list(accountId: string, filter: { service?: string; type?: string; region?: string } = {}) {
    const items = await this.store.list(accountId, filter);
    return Promise.all(items.map((r) => this.settleAndSave(r)));
  }

  /** Any resource by ID. Unknown IDs fail the way the real API would for that kind of ID. */
  async get(accountId: string, id: string): Promise<Resource> {
    const r = await this.store.get(accountId, id);
    if (!r) {
      const def = typeForId(id);
      if (def) throw isWellFormed(def, id) ? notFoundError(def, id) : malformedError(def, id);
      throw new EngineError("InvalidID", `The ID '${id}' is not valid`);
    }
    return this.settleAndSave(r);
  }

  /**
   * A resource of a specific type in a specific region. Checks the ID's format
   * first (…Malformed), then existence (…NotFound), like the real API.
   * Resources in another region count as not found, as they do in practice.
   */
  async getTyped(accountId: string, id: string, service: string, type: string, region?: string): Promise<Resource> {
    const def = getTypeDef(service, type);
    if (!isWellFormed(def, id)) throw malformedError(def, id);
    const r = await this.store.get(accountId, id);
    if (!r || r.service !== service || r.type !== type || (region && r.region !== region)) throw notFoundError(def, id);
    return this.settleAndSave(r);
  }

  /**
   * Creates a resource. `options.system` marks platform-made resources (default VPC,
   * main route table...); `options.settled` skips the "pending" phase.
   */
  async create(
    accountId: string,
    input: { service: string; type: string; region: string; config: Record<string, unknown> },
    options: { system?: SystemInfo; settled?: boolean } = {},
  ): Promise<Resource> {
    const def = getTypeDef(input.service, input.type);
    if (!isRegion(input.region)) throw errors.invalidParameter(`Invalid region: '${input.region}'`);
    const ctx = this.context(accountId, input.region);
    const config = await this.validateConfig(def, input.region, input.config ?? {}, null, ctx);

    const name = typeof config.name === "string" ? config.name : "";
    const id = def.idFromName ? name : generateId(def.idPrefix);
    if (def.idFromName && (await this.store.getAny(id))) {
      throw new EngineError("BucketAlreadyExists", "The requested bucket name is not available.", 409);
    }

    const derived = def.derive ? await def.derive({ id, config, existing: null, ctx }) : {};
    const attributes = options.system ? { ...derived, system: options.system } : derived;
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
      resource =
        life.settlesTo && !options.settled
          ? scheduleTransition(resource, { via: life.state, to: life.settlesTo, afterMs: life.afterMs }, this.now())
          : { ...resource, state: life.settlesTo ?? life.state };
    }

    await this.store.insert(resource);
    if (def.afterCreate) await def.afterCreate({ resource, system: this.systemApi(accountId, input.region) });
    return resource;
  }

  async update(accountId: string, id: string, patch: Record<string, unknown>): Promise<Resource> {
    const existing = await this.get(accountId, id);
    const def = getTypeDef(existing.service, existing.type);

    // "", null and undefined all mean "not set", so they count as the same value.
    const norm = (v: unknown) => JSON.stringify(v === "" || v === null || v === undefined ? null : v);
    for (const field of def.fields) {
      if (!(field.key in patch)) continue;
      if (norm(patch[field.key]) === norm(existing.config[field.key])) continue;
      if (field.immutable) {
        throw errors.invalidValue(field.param ?? field.key, patch[field.key], "It can't be changed after the resource is created.");
      }
      if (field.mutableInStates && (!existing.state || !field.mutableInStates.includes(existing.state))) {
        throw stateError(def, `The ${def.apiNoun} '${id}' is not in the '${field.mutableInStates.join("' or '")}' state.`);
      }
    }

    const ctx = this.context(accountId, existing.region);
    const config = await this.validateConfig(def, existing.region, { ...existing.config, ...patch }, existing, ctx);
    const attributes = def.derive ? keepSystem(await def.derive({ id, config, existing, ctx }), existing) : existing.attributes;

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

    // Like the real API, asking for a state you're already in (or heading to) is not an error.
    const alreadyThere =
      existing.state === actionDef.to ||
      (existing.pendingState === actionDef.to && (!actionDef.via || existing.state === actionDef.via));
    if (alreadyThere && actionDef.via !== "rebooting") return existing;

    if (!existing.state || !actionDef.from.includes(existing.state)) {
      throw stateError(def, `The ${def.apiNoun} '${id}' is not in a state from which it can be ${actionDef.pastTense}.`);
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
      throw stateError(def, `The ${def.apiNoun} '${id}' is not in the '${deletable.join("' or '")}' state.`);
    }

    const reason = def.canDelete?.(existing);
    if (reason) throw reason;

    // Resources the platform made for this one (a VPC's main route table and default
    // security group) go with it. A reference blocks deletion unless every field holding
    // it is weak; weak ones are cleaned up instead.
    const owned: Resource[] = [];
    const blocking: Resource[] = [];
    const toPrune: { resource: Resource; fields: FieldDef[] }[] = [];
    for (const d of (await this.dependents(accountId, id)).filter(isActive)) {
      if (d.id === id) continue;
      if (systemOf(d).ownedBy === id) {
        owned.push(d);
        continue;
      }
      const dDef = getTypeDef(d.service, d.type);
      const holding = dDef.fields.filter((f) => {
        if (f.type !== "ref") return false;
        const v = d.config[f.key];
        return v === id || (Array.isArray(v) && v.includes(id));
      });
      if (holding.length > 0 && holding.every((f) => f.ref?.weak)) toPrune.push({ resource: d, fields: holding });
      else blocking.push(d);
    }
    if (blocking.length > 0) {
      throw errors.dependency(
        def.dependencyMessage?.(id) ?? `The ${def.apiNoun} '${id}' has dependencies and cannot be deleted.`,
        blocking.map((b) => b.id),
      );
    }

    // Owned resources must not be in use by anything else either (e.g. a default
    // security group still referenced by another group's rule).
    for (const o of owned) {
      const users = (await this.dependents(accountId, o.id)).filter(
        (d) => isActive(d) && d.id !== o.id && d.id !== id && systemOf(d).ownedBy !== id,
      );
      if (users.length > 0) {
        throw errors.dependency(
          def.dependencyMessage?.(id) ?? `The ${def.apiNoun} '${id}' has dependencies and cannot be deleted.`,
          users.map((u) => u.id),
        );
      }
    }

    await this.store.delete(accountId, id);
    for (const o of owned) await this.store.delete(accountId, o.id);
    for (const { resource, fields } of toPrune) {
      const config = { ...resource.config };
      for (const f of fields) {
        const v = config[f.key];
        config[f.key] = Array.isArray(v) ? v.filter((x) => x !== id) : undefined;
      }
      const dDef = getTypeDef(resource.service, resource.type);
      await this.store.update({
        ...resource,
        config,
        refs: collectRefs(dDef.fields, config),
        attributes: dDef.derive
          ? keepSystem(
              await dDef.derive({ id: resource.id, config, existing: resource, ctx: this.context(accountId, resource.region) }),
              resource,
            )
          : resource.attributes,
        updatedAt: this.now().toISOString(),
      });
    }
  }

  // ---------- default VPCs ----------

  /** The account's default VPC in a region, if it has one. */
  async defaultVpc(accountId: string, region: string): Promise<Resource | undefined> {
    const vpcs = await this.list(accountId, { service: "networking", type: "vpc", region });
    return vpcs.find((v) => systemOf(v).isDefault);
  }

  /**
   * Creates a default VPC like the real one: 172.31.0.0/16, a /20 default subnet in
   * every availability zone with public IPs on, an attached internet gateway and a
   * 0.0.0.0/0 route in the main route table.
   */
  async createDefaultVpc(accountId: string, region: string): Promise<Resource> {
    if (await this.defaultVpc(accountId, region)) {
      throw new EngineError("DefaultVpcAlreadyExists", "A Default VPC already exists for this account in this region.");
    }
    const sys = this.systemApi(accountId, region);
    const vpc = await sys.create("networking", "vpc", { cidrBlock: "172.31.0.0/16", enableDnsHostnames: true }, { isDefault: true });
    const igw = await sys.create("networking", "internet-gateway", { vpcId: vpc.id });
    const main = (await this.list(accountId, { service: "networking", type: "route-table", region })).find(
      (t) => systemOf(t).main && t.config.vpcId === vpc.id,
    );
    if (main) await sys.update(main.id, { routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }] });
    const zones = resolveTypeDef(getTypeDef("networking", "subnet"), region).fields.find((f) => f.key === "availabilityZone")?.options ?? [];
    for (const [i, zone] of zones.entries()) {
      await sys.create(
        "networking",
        "subnet",
        { vpcId: vpc.id, cidrBlock: `172.31.${i * 16}.0/20`, availabilityZone: zone.value, mapPublicIpOnLaunch: true },
        { defaultForAz: true },
      );
    }
    return this.get(accountId, vpc.id);
  }

  /**
   * Makes sure a region has its default VPC the first time the account uses it,
   * like a new AWS account. Runs once per account and region; if the learner later
   * deletes the default VPC it stays deleted, as it would in AWS.
   */
  async ensureDefaults(accountId: string, region: string): Promise<void> {
    if (!isRegion(region)) return;
    if (!(await this.store.tryClaim(`default-vpc:${accountId}:${region}`))) return;
    if (!(await this.defaultVpc(accountId, region))) await this.createDefaultVpc(accountId, region);
  }

  /** Deletes everything the account has in a region; the default VPC comes back on next use. */
  async resetRegion(accountId: string, region: string): Promise<number> {
    const removed = await this.store.deleteRegion(accountId, region);
    await this.store.releaseClaim(`default-vpc:${accountId}:${region}`);
    return removed;
  }

  /**
   * Moves an anonymous visitor's lab into their account when they first sign in.
   * Does nothing if the account already has a lab (a returning user keeps theirs).
   */
  async adoptLab(fromAccountId: string, toAccountId: string): Promise<number> {
    if (fromAccountId === toAccountId) return 0;
    return this.store.transferAccount(fromAccountId, toAccountId);
  }

  /** Resources that point at `id`, settled to their current state. */
  async dependents(accountId: string, id: string): Promise<Resource[]> {
    const items = await this.store.findReferencing(accountId, id);
    return Promise.all(items.map((r) => this.settleAndSave(r)));
  }
}

/**
 * Core types for the generic resource engine.
 *
 * A service (e.g. "compute") owns resource types (e.g. "instance").
 * Each resource type is described by data: its fields, list columns and
 * lifecycle. The engine reads these definitions to validate input, store
 * resources, move them through states and enforce dependencies, so adding
 * a service is mostly writing a definition file.
 */

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "cidr"
  | "ref"
  | "list";

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

/** Catalog lists whose contents depend on the region, resolved at request time. */
export type OptionsSource = "availabilityZones" | "images" | "instanceTypes";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  /** Cannot be changed after creation. */
  immutable?: boolean;
  /** If set, the field can only be changed while the resource is in one of these states. */
  mutableInStates?: string[];
  /** string */
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
  /** number */
  min?: number;
  max?: number;
  /** enum */
  options?: FieldOption[];
  optionsSource?: OptionsSource;
  /** cidr: allowed prefix lengths */
  prefix?: { min: number; max: number };
  /** ref: which resource type it points at, and whether several may be chosen */
  ref?: { service: string; type: string; multiple?: boolean };
  /** list: shape of each item */
  item?: FieldDef[];
  maxItems?: number;
}

export interface CreateLifecycle {
  /** State right after creation. */
  state: string;
  /** If set, the resource settles into this state after `afterMs`. */
  settlesTo?: string;
  afterMs?: number;
}

export interface ActionDef {
  label: string;
  description?: string;
  /** States the action may be started from. */
  from: string[];
  /** Transitional state shown while the action runs (e.g. "stopping"). */
  via?: string;
  /** Final state. */
  to: string;
  afterMs?: number;
  destructive?: boolean;
}

export interface LifecycleDef {
  create: CreateLifecycle;
  actions?: Record<string, ActionDef>;
  /** States in which the resource no longer counts as "in use" (e.g. "terminated"). */
  inactiveStates?: string[];
  /** If set, the resource can only be deleted in these states. */
  deletableStates?: string[];
}

export interface ColumnDef {
  label: string;
  /** Dot path into the resource DTO, e.g. "config.cidrBlock" or "attributes.privateIp". */
  path: string;
  mono?: boolean;
}

/** What a resource looks like to the rest of the app (API, UI, engine hooks). */
export interface Resource {
  id: string;
  accountId: string;
  region: string;
  service: string;
  type: string;
  name: string;
  state: string | null;
  pendingState: string | null;
  transitionAt: string | null;
  config: Record<string, unknown>;
  attributes: Record<string, unknown>;
  refs: string[];
  createdAt: string;
  updatedAt: string;
}

export type ResourceDTO = Omit<Resource, "accountId" | "refs">;

export interface HookContext {
  accountId: string;
  region: string;
  /** Load another resource owned by the same account. */
  get(id: string): Promise<Resource | null>;
  /** List the account's resources of a type in the current region. */
  list(service: string, type: string): Promise<Resource[]>;
  /** Check whether an ID exists in any account (for globally unique names). */
  existsGlobally(id: string): Promise<Resource | null>;
}

export interface ResourceTypeDef {
  service: string;
  type: string;
  label: string;
  pluralLabel: string;
  description: string;
  /** Prefix for generated IDs, e.g. "vpc" produces "vpc-0a1b2c3d4e5f6a7b8". */
  idPrefix: string;
  /** Use the `name` field as the ID instead of generating one (buckets). */
  idFromName?: boolean;
  fields: FieldDef[];
  columns: ColumnDef[];
  lifecycle?: LifecycleDef;
  /** Error code used when a resource of this type is not found. */
  notFoundCode: string;
  /** Extra checks beyond field validation. Throw EngineError to reject. */
  validate?: (input: {
    config: Record<string, unknown>;
    existing: Resource | null;
    ctx: HookContext;
  }) => Promise<void>;
  /** Compute platform-assigned attributes (IPs, ARNs, counts...). */
  derive?: (input: {
    id: string;
    config: Record<string, unknown>;
    existing: Resource | null;
    ctx: HookContext;
  }) => Promise<Record<string, unknown>>;
}

export interface ServiceDef {
  id: string;
  label: string;
  /** What it is modelled on, shown as a hint in the console. */
  modelledOn: string;
  description: string;
  category: "Compute" | "Networking" | "Storage" | "Database" | "Security" | "DevOps" | "Monitoring";
  types: ResourceTypeDef[];
}

/** A resource type definition with region-dependent options filled in, safe to send to the browser. */
export type ResolvedTypeDef = Omit<ResourceTypeDef, "validate" | "derive">;

export interface ResolvedServiceDef extends Omit<ServiceDef, "types"> {
  types: ResolvedTypeDef[];
}

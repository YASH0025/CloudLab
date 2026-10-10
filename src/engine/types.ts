import type { EngineError } from "./errors";

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
  | "list"
  /** A JSON document edited as text, e.g. an IAM policy. */
  | "json"
  /** IAM policy ARNs to attach (AWS managed and the account's own). */
  | "policies";

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
  /** cidr: fix host bits instead of rejecting them (10.0.0.5/16 → 10.0.0.0/16), as the real API does. */
  canonicalize?: boolean;
  /** cidr: error code when the block size is out of range, e.g. "InvalidVpc.Range". */
  rangeErrorCode?: string;
  /** Name of the matching parameter in the real API, used in error messages. Defaults to `key`. */
  param?: string;
  /**
   * ref: which resource type it points at, and whether several may be chosen.
   * A `weak` reference doesn't block deleting its target; it is removed instead
   * (like a route table's subnet association when the subnet is deleted).
   * `by: "name"` stores the target's name instead of its ID (an instance's key pair).
   * Such references are checked when set but never tracked as dependencies.
   */
  ref?: { service: string; type: string; multiple?: boolean; weak?: boolean; by?: "name" };
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
  /** Used in "is not in a state from which it can be …", e.g. "stopped". */
  pastTense: string;
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
  /** Show Yes/No, treating a missing value as No. */
  boolean?: boolean;
}

/**
 * Markers for resources the platform creates itself, kept in `attributes.system`
 * and preserved across updates: default VPCs and subnets, a VPC's main route
 * table and default security group.
 */
export interface SystemInfo {
  isDefault?: boolean;
  defaultForAz?: boolean;
  main?: boolean;
  /** Deleted together with this resource (a VPC owns its main route table and default security group). */
  ownedBy?: string;
  /** Launched and looked after by an Auto Scaling group (its ID). */
  managedBy?: string;
}

export function systemOf(r: { attributes: Record<string, unknown> }): SystemInfo {
  return (r.attributes.system as SystemInfo | undefined) ?? {};
}

/** What hooks can do: read, create and update resources as the platform. */
export interface SystemApi {
  get(id: string): Promise<Resource | null>;
  /** The account's resources of a type in the hook's region. */
  list(service: string, type: string): Promise<Resource[]>;
  create(service: string, type: string, config: Record<string, unknown>, system?: SystemInfo): Promise<Resource>;
  update(id: string, patch: Record<string, unknown>): Promise<Resource>;
  /** Runs a lifecycle action, e.g. terminate an instance. */
  runAction(id: string, action: string): Promise<Resource>;
  /** Merges platform-assigned attributes (e.g. an instance's public IP) without re-validating. */
  setAttributes(id: string, patch: Record<string, unknown>): Promise<void>;
}

/**
 * How the console's generic operations on a type map to IAM actions, e.g.
 * create → "ec2:CreateVpc". `update` may depend on which settings changed.
 */
export interface IamMapping {
  create: string;
  read: string;
  update?: string | ((changed: string[]) => string[]);
  delete: string;
  /** Lifecycle actions, e.g. { stop: "ec2:StopInstances" }. */
  actions?: Record<string, string>;
  /** The resource's ARN, given the 12-digit account number. */
  arn: (r: { id: string; name: string; region: string; config: Record<string, unknown> }, account: string) => string;
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
  /** List the account's resources of a type in every region. */
  listAll(service: string, type: string): Promise<Resource[]>;
  /** The engine's clock (tests control it). */
  now(): Date;
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
  /** Error code used when a resource of this type is not found, e.g. "InvalidVpcID.NotFound". */
  notFoundCode: string;
  /** Message for a missing ID when the real API doesn't use "The <noun> ID '<id>' does not exist". */
  notFoundMessage?: (id: string) => string;
  /** Error code for a badly formed ID, when it isn't the not-found code with ".Malformed". */
  malformedCode?: string;
  /** Message for a badly formed ID, when the default (expecting "prefix-...") doesn't fit, e.g. ARNs. */
  malformedMessage?: (id: string) => string;
  /** How the real API names this type in messages, e.g. "vpc", "internetGateway", "routeTable". */
  apiNoun: string;
  /** Error code for state conflicts. Instances use "IncorrectInstanceState"; most others "IncorrectState". */
  stateErrorCode?: string;
  /** Extra reason a resource can't be deleted yet (e.g. a gateway still attached). Throw-free: return the error. */
  canDelete?: (resource: Resource) => EngineError | undefined;
  /** Not shown in the console's navigation; managed through its own screens (bucket objects). */
  hidden?: boolean;
  /** Attributes the console shows in a panel of their own, not in the summary (scaling activities). */
  panelAttributes?: string[];
  /** Attributes kept on the server and never sent to the browser (e.g. an encrypted secret). */
  privateAttributes?: string[];
  /** Global service (IAM): not tied to a region. Stored under the region "global". */
  global?: boolean;
  /** Builds the resource ID when the real API's format isn't "<prefix>-<hex>" (IAM's AIDA…, load balancer ARNs). */
  makeId?: (input: { name: string; region: string; accountId: string }) => string;
  /** What a well-formed ID looks like, when it isn't "<prefix>-<hex>". */
  idPattern?: RegExp;
  /** IAM actions and ARNs for the console's operations, used to check permissions. */
  iam?: IamMapping;
  /** Async checks before deletion (e.g. IAM's DeleteConflict). Throw to refuse. */
  beforeDelete?: (input: { resource: Resource; ctx: HookContext; force: boolean; system: SystemApi }) => Promise<void>;
  /** The error when dependents block deletion, if not DependencyViolation (e.g. S3's BucketNotEmpty). */
  dependencyError?: (id: string) => EngineError;
  /** Message when deletion is blocked by dependents. Defaults to "The <noun> '<id>' has dependencies and cannot be deleted." */
  dependencyMessage?: (id: string) => string;
  /** Extra checks beyond field validation. Throw EngineError to reject. */
  validate?: (input: {
    config: Record<string, unknown>;
    existing: Resource | null;
    ctx: HookContext;
  }) => Promise<void>;
  /**
   * Maps an invalid field value to the error the real API returns, for cases
   * the generic mapping can't express (e.g. unknown AMI → InvalidAMIID.NotFound).
   */
  invalidValue?: (input: { field: FieldDef; value: unknown; region: string }) => EngineError | undefined;
  /** Runs after a resource is created, e.g. a VPC creating its main route table. */
  afterCreate?: (input: { resource: Resource; system: SystemApi }) => Promise<void>;
  /** Runs after a resource is updated, e.g. an Elastic IP moving to another instance. */
  afterUpdate?: (input: { resource: Resource; previous: Resource; system: SystemApi }) => Promise<void>;
  /** Runs after a resource is deleted. */
  afterDelete?: (input: { resource: Resource; system: SystemApi }) => Promise<void>;
  /** Runs when a lifecycle transition completes, e.g. an instance reaching "stopped". */
  onSettled?: (input: { resource: Resource; from: string | null; system: SystemApi }) => Promise<void>;
  /**
   * Attributes returned once by create and never stored, like a key pair's private key:
   * the real API shows it a single time.
   */
  revealOnce?: string[];
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
export type ResolvedTypeDef = Omit<
  ResourceTypeDef,
  | "validate"
  | "derive"
  | "invalidValue"
  | "dependencyMessage"
  | "canDelete"
  | "afterCreate"
  | "afterUpdate"
  | "afterDelete"
  | "onSettled"
  | "dependencyError"
  | "notFoundMessage"
  | "makeId"
  | "iam"
  | "beforeDelete"
  | "privateAttributes"
  | "idPattern"
  | "malformedMessage"
>;

export interface ResolvedServiceDef extends Omit<ServiceDef, "types"> {
  types: ResolvedTypeDef[];
}

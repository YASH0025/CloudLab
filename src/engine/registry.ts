import { resolveOptions } from "./catalog";
import { errors } from "./errors";
import { computeService } from "./services/compute";
import { iamService } from "./services/iam";
import { networkingService } from "./services/networking";
import { objectType, storageService } from "./services/storage";
import type { FieldDef, ResolvedServiceDef, ResolvedTypeDef, ResourceTypeDef, ServiceDef } from "./types";

/** Every service the platform simulates. Add new service definitions here. */
export const SERVICES: ServiceDef[] = [networkingService, computeService, storageService, iamService];

/** Types managed through their own screens rather than the generic console pages (bucket objects). */
const HIDDEN_TYPES: ResourceTypeDef[] = [objectType];

/** Every resource type, including hidden ones. */
export const allTypes = (): ResourceTypeDef[] => [...SERVICES.flatMap((s) => s.types), ...HIDDEN_TYPES];

export function getTypeDef(service: string, type: string): ResourceTypeDef {
  const def = allTypes().find((t) => t.service === service && t.type === type);
  if (!def) throw errors.unknownType(service, type);
  return def;
}

function resolveFields(fields: FieldDef[], region: string): FieldDef[] {
  return fields.map((f) => {
    const resolved: FieldDef = { ...f };
    if (f.optionsSource) resolved.options = resolveOptions(f.optionsSource, region);
    if (f.item) resolved.item = resolveFields(f.item, region);
    return resolved;
  });
}

/** A type definition with region-dependent options filled in and server-only hooks removed. */
export function resolveTypeDef(def: ResourceTypeDef, region: string): ResolvedTypeDef {
  // Hooks are server-only functions; everything else is plain data.
  const data = Object.fromEntries(Object.entries(def).filter(([, v]) => typeof v !== "function")) as ResolvedTypeDef;
  return { ...data, fields: resolveFields(def.fields, region) };
}

export function resolveServices(region: string): ResolvedServiceDef[] {
  return SERVICES.map((s) => ({ ...s, types: s.types.map((t) => resolveTypeDef(t, region)) }));
}

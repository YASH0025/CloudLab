import { resolveOptions } from "./catalog";
import { errors } from "./errors";
import { computeService } from "./services/compute";
import { networkingService } from "./services/networking";
import { storageService } from "./services/storage";
import type { FieldDef, ResolvedServiceDef, ResolvedTypeDef, ResourceTypeDef, ServiceDef } from "./types";

/** Every service the platform simulates. Add new service definitions here. */
export const SERVICES: ServiceDef[] = [networkingService, computeService, storageService];

export function getTypeDef(service: string, type: string): ResourceTypeDef {
  const def = SERVICES.find((s) => s.id === service)?.types.find((t) => t.type === type);
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { validate, derive, invalidValue, dependencyMessage, canDelete, ...data } = def;
  return { ...data, fields: resolveFields(def.fields, region) };
}

export function resolveServices(region: string): ResolvedServiceDef[] {
  return SERVICES.map((s) => ({ ...s, types: s.types.map((t) => resolveTypeDef(t, region)) }));
}

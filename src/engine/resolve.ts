import { resolveOptions } from "./catalog";
import type { FieldDef, ResolvedServiceDef, ResolvedTypeDef } from "./types";

/**
 * The service catalogue as plain data: every service and resource type with its
 * fields, labels and columns, and none of the engine code behind them. The server
 * builds it once (registry.serviceCatalog) and hands it to the browser, so the
 * console never downloads the engine.
 */
export type ServiceCatalog = ResolvedServiceDef[];

function resolveFields(fields: FieldDef[], region: string): FieldDef[] {
  return fields.map((f) => {
    const resolved: FieldDef = { ...f };
    if (f.optionsSource) resolved.options = resolveOptions(f.optionsSource, region);
    if (f.item) resolved.item = resolveFields(f.item, region);
    return resolved;
  });
}

/** Fills in a region's options (availability zones, images…). */
export const resolveTypeFields = (def: ResolvedTypeDef, region: string): ResolvedTypeDef => ({ ...def, fields: resolveFields(def.fields, region) });

export const resolveCatalog = (catalog: ServiceCatalog, region: string): ResolvedServiceDef[] =>
  catalog.map((s) => ({ ...s, types: s.types.map((t) => resolveTypeFields(t, region)) }));

import { z } from "zod";
import { normalizeCidr, parseCidr } from "./cidr";
import type { FieldDef } from "./types";

/**
 * Builds a Zod schema from field definitions. The same schema validates the
 * console form (React Hook Form) and the API input, so the two never drift.
 *
 * Issues carry `params.kind` so the engine can turn them into the error
 * code the real API would return (MissingParameter, InvalidVpc.Range...).
 */

export type IssueKind = "missing" | "enum" | "cidr-format" | "cidr-range" | "cidr-host-bits";
const kind = (k: IssueKind) => ({ kind: k });

// Empty strings and nulls both mean "not set" (null is how a form clears a field over JSON).
const emptyToUndefined = (v: unknown) =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : typeof v === "string" ? v.trim() : v;

function fieldSchema(field: FieldDef): z.ZodType {
  const required = field.required ?? false;
  let schema: z.ZodType;

  switch (field.type) {
    case "string": {
      let s = z.string();
      if (field.minLength !== undefined)
        s = s.min(field.minLength, `${field.label} must be at least ${field.minLength} characters.`);
      if (field.maxLength !== undefined)
        s = s.max(field.maxLength, `${field.label} must be at most ${field.maxLength} characters.`);
      if (field.pattern)
        s = s.regex(new RegExp(field.pattern), field.patternMessage ?? `${field.label} has an invalid format.`);
      schema = s;
      break;
    }
    case "number": {
      let n = z.number({ error: `${field.label} must be a number.` }).int(`${field.label} must be a whole number.`);
      if (field.min !== undefined) n = n.min(field.min, `${field.label} must be at least ${field.min}.`);
      if (field.max !== undefined) n = n.max(field.max, `${field.label} must be at most ${field.max}.`);
      const toNumber = (v: unknown) => {
        const x = emptyToUndefined(v);
        return typeof x === "string" ? Number(x) : x;
      };
      if (!required) return z.preprocess(toNumber, n.optional());
      return z.preprocess(
        toNumber,
        z.unknown().refine((v) => v !== undefined, { message: `${field.label} is required.`, params: kind("missing") }).pipe(n),
      );
    }
    case "boolean":
      return z.boolean().default((field.default as boolean | undefined) ?? false);
    case "enum": {
      const values = (field.options ?? []).map((o) => o.value);
      schema = z
        .string()
        .refine((v) => values.length === 0 || values.includes(v), {
          message: `Choose a valid ${field.label.toLowerCase()}.`,
          params: kind("enum"),
        });
      break;
    }
    case "cidr": {
      schema = z
        .string()
        .superRefine((value, ctx) => {
          const parsed = parseCidr(value);
          if (!parsed) {
            ctx.addIssue({ code: "custom", message: `Enter a CIDR block like 10.0.0.0/16.`, params: kind("cidr-format") });
            return;
          }
          if (field.prefix && (parsed.prefix < field.prefix.min || parsed.prefix > field.prefix.max)) {
            ctx.addIssue({
              code: "custom",
              message: `The block size must be between /${field.prefix.min} and /${field.prefix.max}.`,
              params: kind("cidr-range"),
            });
            return;
          }
          const normalized = normalizeCidr(value);
          if (!field.canonicalize && normalized !== value.trim()) {
            ctx.addIssue({
              code: "custom",
              message: `${value} is not a network address. Did you mean ${normalized}?`,
              params: kind("cidr-host-bits"),
            });
          }
        })
        // Like the real API, some fields quietly fix host bits: 10.0.0.5/16 becomes 10.0.0.0/16.
        .transform((value) => (field.canonicalize ? (normalizeCidr(value) ?? value) : value.trim()));
      break;
    }
    case "ref": {
      if (field.ref?.multiple) {
        const arr = z.array(z.string());
        if (!required) return arr.default([]);
        return arr
          .refine((a) => a.length > 0, { message: `Select at least one ${field.label.toLowerCase()}.`, params: kind("missing") })
          .default([]);
      }
      schema = z.string();
      break;
    }
    case "list": {
      const item = buildSchema(field.item ?? []);
      let arr = z.array(item);
      if (field.maxItems !== undefined) arr = arr.max(field.maxItems, `At most ${field.maxItems} entries.`);
      return arr.default([]);
    }
    default:
      schema = z.unknown();
  }

  // `.optional()` must sit inside the preprocess, so that "" or null cleaned to undefined is accepted.
  if (!required) return z.preprocess(emptyToUndefined, schema.optional());
  return z.preprocess(
    emptyToUndefined,
    z
      .unknown()
      .refine((v) => v !== undefined && v !== null, { message: `${field.label} is required.`, params: kind("missing") })
      // The refine above guarantees a value, so it is safe to hand on to the typed schema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pipe(schema as z.ZodType<any, any>),
  );
}

export function buildSchema(fields: FieldDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const schema = fieldSchema(field);
    shape[field.key] =
      field.default === undefined
        ? schema
        : z.preprocess((v) => (v === undefined || v === "" ? structuredClone(field.default) : v), schema);
  }
  return z.object(shape);
}

/** Default form values for a set of fields. */
export function defaultValues(fields: FieldDef[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default;
    else if (field.type === "boolean") values[field.key] = false;
    else if (field.type === "list" || (field.type === "ref" && field.ref?.multiple)) values[field.key] = [];
    else if (field.type === "enum" && field.required && field.options?.length) values[field.key] = field.options[0].value;
    else values[field.key] = "";
  }
  return values;
}

/**
 * Collects the IDs referenced by ref fields, used for dependency tracking.
 * Refs inside list items (e.g. a rule's source security group) count too,
 * unless they are weak.
 */
export function collectRefs(fields: FieldDef[], config: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) ids.add(value);
    if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && v) ids.add(v);
  };
  for (const field of fields) {
    if (field.type === "ref") add(config[field.key]);
    if (field.type === "list" && Array.isArray(config[field.key])) {
      const itemRefs = (field.item ?? []).filter((f) => f.type === "ref" && !f.ref?.weak);
      for (const item of config[field.key] as Record<string, unknown>[]) for (const f of itemRefs) add(item?.[f.key]);
    }
  }
  return [...ids];
}

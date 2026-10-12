import { Pair, parse as parseYaml, Scalar, YAMLMap, type YAMLSeq } from "yaml";
import { EngineError } from "../errors";

/**
 * CloudFormation templates: parsing (JSON, or YAML with the short-form tags
 * like !Ref and !Sub), validating the sections and parameters, resolving
 * conditions and intrinsic functions, and ordering resources by their
 * dependencies, with CloudFormation's own error messages.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface ResourceDecl {
  Type: string;
  Properties?: Record<string, Json>;
  DependsOn?: string | string[];
  Condition?: string;
  DeletionPolicy?: string;
}

export interface Template {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, ParameterDecl>;
  Mappings?: Record<string, Record<string, Record<string, Json>>>;
  Conditions?: Record<string, Json>;
  Resources: Record<string, ResourceDecl>;
  Outputs?: Record<string, { Value: Json; Description?: string; Export?: { Name: Json }; Condition?: string }>;
}

export interface ParameterDecl {
  Type: string;
  Default?: Json;
  AllowedValues?: Json[];
  AllowedPattern?: string;
  MinLength?: number;
  MaxLength?: number;
  MinValue?: number;
  MaxValue?: number;
  NoEcho?: boolean;
  Description?: string;
  ConstraintDescription?: string;
}

export const validationError = (message: string) => new EngineError("ValidationError", message, 400);
const formatError = (message: string) => validationError(`Template format error: ${message}`);

// ---------- parsing ----------

const FN: Record<string, string> = {
  "!GetAtt": "Fn::GetAtt",
  "!Sub": "Fn::Sub",
  "!Join": "Fn::Join",
  "!Select": "Fn::Select",
  "!Split": "Fn::Split",
  "!GetAZs": "Fn::GetAZs",
  "!If": "Fn::If",
  "!Equals": "Fn::Equals",
  "!Not": "Fn::Not",
  "!And": "Fn::And",
  "!Or": "Fn::Or",
  "!FindInMap": "Fn::FindInMap",
  "!Base64": "Fn::Base64",
  "!ImportValue": "Fn::ImportValue",
  "!Cidr": "Fn::Cidr",
};

function wrap(fn: string, value: YAMLSeq | YAMLMap) {
  const m = new YAMLMap();
  m.items.push(new Pair(new Scalar(fn), value));
  return m;
}

const TAGS = [
  { tag: "!Ref", resolve: (s: string) => ({ Ref: s }) },
  { tag: "!Condition", resolve: (s: string) => ({ Condition: s }) },
  // !GetAtt Resource.Attribute is short for ["Resource", "Attribute"].
  { tag: "!GetAtt", resolve: (s: string) => ({ "Fn::GetAtt": [s.slice(0, s.indexOf(".")), s.slice(s.indexOf(".") + 1)] }) },
  ...Object.entries(FN)
    .filter(([t]) => t !== "!GetAtt")
    .map(([tag, fn]) => ({ tag, resolve: (s: string) => ({ [fn]: s }) })),
  ...Object.entries(FN).map(([tag, fn]) => ({ tag, collection: "seq" as const, resolve: (seq: YAMLSeq) => wrap(fn, seq) })),
  ...Object.entries(FN).map(([tag, fn]) => ({ tag, collection: "map" as const, resolve: (map: YAMLMap) => wrap(fn, map) })),
];

export function parseTemplate(body: string): Template {
  const text = body.trim();
  if (!text) throw validationError("1 validation error detected: Value '' at 'templateBody' failed to satisfy constraint: Member must have length greater than or equal to 1");
  if (Buffer.byteLength(text) > 51_200) throw validationError("1 validation error detected: Value at 'templateBody' failed to satisfy constraint: Member must have length less than or equal to 51200");
  let doc: unknown;
  if (text.startsWith("{")) {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      const at = /position (\d+)/.exec((e as Error).message);
      let where = "";
      if (at) {
        const before = text.slice(0, Number(at[1]));
        where = ` (line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")})`;
      }
      throw formatError(`JSON not well-formed.${where}`);
    }
  } else {
    try {
      doc = parseYaml(text, { customTags: TAGS as never, prettyErrors: false, uniqueKeys: true });
    } catch (e) {
      const m = /at line (\d+), column (\d+)/.exec((e as Error).message);
      throw formatError(`YAML not well-formed.${m ? ` (line ${m[1]}, column ${m[2]})` : ""}`);
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw formatError("YAML not well-formed. A template is a map of sections (Resources, Parameters…).");
  const t = doc as Record<string, unknown>;
  const known = ["AWSTemplateFormatVersion", "Description", "Metadata", "Parameters", "Mappings", "Conditions", "Transform", "Resources", "Outputs", "Rules"];
  const unknown = Object.keys(t).filter((k) => !known.includes(k));
  if (unknown.length) throw formatError(`Invalid template property or properties [${unknown.join(", ")}]`);
  if (t.Transform) throw formatError("Transforms (like AWS::Serverless) aren't simulated in CloudLab yet.");
  if (t.AWSTemplateFormatVersion !== undefined && String(t.AWSTemplateFormatVersion) !== "2010-09-09") {
    throw formatError(`'${String(t.AWSTemplateFormatVersion)}' is not a supported version. Use '2010-09-09'.`);
  }
  if (!t.Resources || typeof t.Resources !== "object" || Object.keys(t.Resources).length === 0) throw formatError("At least one Resources member must be defined.");
  for (const [id, r] of Object.entries(t.Resources as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw formatError(`Resource name ${id} is non alphanumeric.`);
    if (!r || typeof r !== "object" || !(r as ResourceDecl).Type) throw formatError(`[/Resources/${id}] Every Resources object must contain a Type member.`);
    const props = (r as ResourceDecl).Properties;
    if (props !== undefined && (typeof props !== "object" || Array.isArray(props))) throw formatError(`[/Resources/${id}/Properties] Every Properties member must be an object`);
  }
  if (t.Description !== undefined && typeof t.Description !== "string") throw formatError("Every Description member must be a string.");
  return t as unknown as Template;
}

// ---------- parameters ----------

export function resolveParameters(t: Template, given: Record<string, string>, existing?: Record<string, string>): Record<string, string> {
  const decls = t.Parameters ?? {};
  const unknown = Object.keys(given).filter((k) => !(k in decls));
  if (unknown.length) throw validationError(`Parameters: [${unknown.join(", ")}] do not exist in the template`);
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const [name, d] of Object.entries(decls)) {
    if (!d || typeof d !== "object" || !d.Type) throw formatError(`[/Parameters/${name}] Every Parameters object must contain a Type member.`);
    const v = given[name] ?? existing?.[name] ?? (d.Default !== undefined ? String(d.Default) : undefined);
    if (v === undefined) {
      missing.push(name);
      continue;
    }
    const why = d.ConstraintDescription ? `: ${d.ConstraintDescription}` : "";
    if (d.AllowedValues && !d.AllowedValues.map(String).includes(v)) throw validationError(`Parameter '${name}' must be one of AllowedValues${why}`);
    if (d.AllowedPattern && !new RegExp(`^(?:${d.AllowedPattern})$`).test(v)) throw validationError(`Parameter '${name}' must match pattern ${d.AllowedPattern}${why}`);
    if (d.MinLength !== undefined && v.length < d.MinLength) throw validationError(`Parameter '${name}' must contain at least ${d.MinLength} characters${why}`);
    if (d.MaxLength !== undefined && v.length > d.MaxLength) throw validationError(`Parameter '${name}' must contain at most ${d.MaxLength} characters${why}`);
    if (d.Type === "Number") {
      if (v.trim() === "" || Number.isNaN(Number(v))) throw validationError(`Parameter '${name}' must be a number`);
      if (d.MinValue !== undefined && Number(v) < d.MinValue) throw validationError(`Parameter '${name}' must be a number not less than ${d.MinValue}${why}`);
      if (d.MaxValue !== undefined && Number(v) > d.MaxValue) throw validationError(`Parameter '${name}' must be a number not greater than ${d.MaxValue}${why}`);
    }
    out[name] = v;
  }
  if (missing.length) throw validationError(`Parameters: [${missing.join(", ")}] must have values`);
  return out;
}

// ---------- dependencies ----------

const PSEUDO = new Set(["AWS::Region", "AWS::AccountId", "AWS::StackName", "AWS::StackId", "AWS::NoValue", "AWS::Partition", "AWS::URLSuffix", "AWS::NotificationARNs"]);

/** The logical IDs a value refers to (Ref, GetAtt, ${...} in Sub). */
export function references(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => references(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.Ref === "string") out.add(o.Ref);
    if (Array.isArray(o["Fn::GetAtt"]) && typeof o["Fn::GetAtt"][0] === "string") out.add(o["Fn::GetAtt"][0]);
    if ("Fn::Sub" in o) {
      const s = o["Fn::Sub"];
      const str = Array.isArray(s) ? s[0] : s;
      const vars = Array.isArray(s) && s[1] && typeof s[1] === "object" ? Object.keys(s[1] as object) : [];
      if (typeof str === "string") for (const m of str.matchAll(/\$\{([^!}][^}]*)\}/g)) if (!vars.includes(m[1])) out.add(m[1].split(".")[0]);
      if (Array.isArray(s)) references(s[1], out);
    }
    for (const [k, x] of Object.entries(o)) if (k !== "Ref" && k !== "Fn::GetAtt" && k !== "Fn::Sub") references(x, out);
  }
  return out;
}

/** Checks every reference and returns the resources in creation order. */
export function orderResources(t: Template, active: string[]): string[] {
  const resources = t.Resources;
  const params = new Set(Object.keys(t.Parameters ?? {}));
  const deps = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  for (const id of active) {
    const r = resources[id];
    const refs = references(r.Properties ?? {});
    for (const d of r.DependsOn ? (Array.isArray(r.DependsOn) ? r.DependsOn : [r.DependsOn]) : []) {
      if (!(d in resources)) throw formatError(`Unresolved resource dependencies [${d}] in the Resources block of the template`);
      refs.add(d);
    }
    const mine = new Set<string>();
    for (const ref of refs) {
      if (PSEUDO.has(ref) || params.has(ref)) continue;
      if (!(ref in resources)) unresolved.add(ref);
      else if (active.includes(ref)) mine.add(ref);
    }
    deps.set(id, mine);
  }
  for (const o of Object.values(t.Outputs ?? {})) for (const ref of references(o.Value)) if (!PSEUDO.has(ref) && !params.has(ref) && !(ref in resources)) unresolved.add(ref);
  if (unresolved.size) throw formatError(`Unresolved resource dependencies [${[...unresolved].join(", ")}] in the Resources block of the template`);

  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycle = path.slice(path.indexOf(id));
      throw validationError(`Circular dependency between resources: [${cycle.join(", ")}]`);
    }
    state.set(id, "visiting");
    for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
    state.set(id, "done");
    order.push(id);
  };
  for (const id of active) visit(id, []);
  return order;
}

// ---------- conditions and intrinsic functions ----------

export interface ResolveContext {
  params: Record<string, string>;
  pseudo: Record<string, string>;
  mappings: Template["Mappings"];
  conditions: Record<string, boolean>;
  azs: string[];
  /** Ref of a resource already created. */
  ref(logicalId: string): string;
  getAtt(logicalId: string, attr: string): Json;
  importValue(name: string): string;
}

export const NO_VALUE = Symbol("AWS::NoValue");

const fnError = (fn: string, msg: string) => formatError(`Template error: ${fn} ${msg}`);

function str(v: unknown, fn: string): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  throw fnError(fn, "expects a string");
}

export function evaluateCondition(v: Json, ctx: ResolveContext): boolean {
  const r = resolve(v, ctx);
  if (typeof r === "boolean") return r;
  if (r === "true" || r === "false") return r === "true";
  throw formatError("Template error: Conditions can only be boolean operations on parameters and other conditions");
}

/** Resolves intrinsic functions in a value. AWS::NoValue removes the property or list item. */
export function resolve(v: Json, ctx: ResolveContext): Json {
  if (Array.isArray(v)) return v.map((x) => resolve(x, ctx)).filter((x) => (x as unknown) !== NO_VALUE);
  if (!v || typeof v !== "object") return v;
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const [k] = keys;
    const arg = (v as Record<string, Json>)[k];
    switch (k) {
      case "Ref": {
        const name = str(arg, "Ref");
        if (name === "AWS::NoValue") return NO_VALUE as unknown as Json;
        if (name in ctx.pseudo) return ctx.pseudo[name];
        if (name in ctx.params) return ctx.params[name];
        return ctx.ref(name);
      }
      case "Fn::GetAtt": {
        const [id, attr] = (Array.isArray(arg) ? arg : str(arg, "Fn::GetAtt").split(".")).map((x) => String(resolve(x, ctx)));
        if (!id || !attr) throw fnError("Fn::GetAtt", "requires two arguments: [LogicalId, Attribute]");
        return ctx.getAtt(id, attr);
      }
      case "Fn::Sub": {
        const [tpl, vars] = Array.isArray(arg) ? [arg[0], arg[1] as Record<string, Json>] : [arg, {}];
        const resolvedVars = Object.fromEntries(Object.entries(vars ?? {}).map(([n, x]) => [n, resolve(x, ctx)]));
        return str(tpl, "Fn::Sub").replace(/\$\{(!?)([^}]+)\}/g, (_m, bang: string, name: string) => {
          if (bang) return `\${${name}}`;
          if (name in resolvedVars) return String(resolvedVars[name]);
          if (name in ctx.pseudo) return ctx.pseudo[name];
          if (name in ctx.params) return ctx.params[name];
          if (name.includes(".")) {
            const i = name.indexOf(".");
            return String(ctx.getAtt(name.slice(0, i), name.slice(i + 1)));
          }
          return ctx.ref(name);
        });
      }
      case "Fn::Join": {
        if (!Array.isArray(arg) || arg.length !== 2) throw fnError("Fn::Join", "requires a list of two elements: a delimiter and a list");
        const list = resolve(arg[1], ctx);
        if (!Array.isArray(list)) throw fnError("Fn::Join", "requires a list of values to join");
        return list.map((x) => String(x)).join(str(arg[0], "Fn::Join"));
      }
      case "Fn::Select": {
        if (!Array.isArray(arg) || arg.length !== 2) throw fnError("Fn::Select", "requires a list of two elements: an index and a list");
        const list = resolve(arg[1], ctx);
        const i = Number(resolve(arg[0], ctx));
        if (!Array.isArray(list) || !Number.isInteger(i) || i < 0 || i >= list.length) throw validationError(`Template error: Fn::Select cannot select nonexistent value at index ${i}`);
        return list[i];
      }
      case "Fn::Split": {
        if (!Array.isArray(arg) || arg.length !== 2) throw fnError("Fn::Split", "requires a list of two elements: a delimiter and a string");
        return str(resolve(arg[1], ctx), "Fn::Split").split(str(arg[0], "Fn::Split"));
      }
      case "Fn::GetAZs":
        return ctx.azs;
      case "Fn::Base64":
        return Buffer.from(str(resolve(arg, ctx), "Fn::Base64")).toString("base64");
      case "Fn::ImportValue":
        return ctx.importValue(str(resolve(arg, ctx), "Fn::ImportValue"));
      case "Fn::FindInMap": {
        if (!Array.isArray(arg) || arg.length !== 3) throw fnError("Fn::FindInMap", "requires three arguments: [MapName, TopLevelKey, SecondLevelKey]");
        const [m, a, b] = arg.map((x) => String(resolve(x, ctx)));
        const value = ctx.mappings?.[m]?.[a]?.[b];
        if (value === undefined) throw validationError(`Template error: Unable to get mapping for ${m}::${a}::${b}`);
        return value;
      }
      case "Fn::If": {
        if (!Array.isArray(arg) || arg.length !== 3) throw fnError("Fn::If", "requires a list of three elements: a condition name, a true value and a false value");
        const name = str(arg[0], "Fn::If");
        if (!(name in ctx.conditions)) throw formatError(`Template error: unresolved condition dependency ${name} in Fn::If`);
        return resolve(ctx.conditions[name] ? arg[1] : arg[2], ctx);
      }
      case "Fn::Equals": {
        if (!Array.isArray(arg) || arg.length !== 2) throw fnError("Fn::Equals", "requires a list of two values to compare");
        return String(resolve(arg[0], ctx)) === String(resolve(arg[1], ctx));
      }
      case "Fn::Not": {
        if (!Array.isArray(arg) || arg.length !== 1) throw fnError("Fn::Not", "requires a list of one condition");
        return !evaluateCondition(arg[0], ctx);
      }
      case "Fn::And":
      case "Fn::Or": {
        if (!Array.isArray(arg) || arg.length < 2) throw fnError(k, "requires a list of at least two conditions");
        const vals = arg.map((x) => evaluateCondition(x, ctx));
        return k === "Fn::And" ? vals.every(Boolean) : vals.some(Boolean);
      }
      case "Condition": {
        const name = str(arg, "Condition");
        if (!(name in ctx.conditions)) throw formatError(`Template error: unresolved condition dependency ${name}`);
        return ctx.conditions[name];
      }
      case "Fn::Cidr":
        throw formatError("Fn::Cidr isn't simulated in CloudLab yet; write the subnet ranges out.");
    }
  }
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) {
    const r = resolve(x, ctx);
    if ((r as unknown) !== NO_VALUE) out[k] = r;
  }
  return out;
}

/** Evaluates the Conditions section (conditions may refer to each other). */
export function evaluateConditions(t: Template, ctx: Omit<ResolveContext, "conditions">): Record<string, boolean> {
  const decls = t.Conditions ?? {};
  const out: Record<string, boolean> = {};
  const visiting = new Set<string>();
  const full = { ...ctx, conditions: out } as ResolveContext;
  const evalOne = (name: string) => {
    if (name in out) return;
    if (visiting.has(name)) throw formatError(`Circular dependency between conditions: [${[...visiting].join(", ")}]`);
    visiting.add(name);
    for (const dep of conditionRefs(decls[name])) {
      if (!(dep in decls)) throw formatError(`Template error: unresolved condition dependency ${dep} in Fn::Condition`);
      evalOne(dep);
    }
    out[name] = evaluateCondition(decls[name], full);
    visiting.delete(name);
  };
  for (const name of Object.keys(decls)) evalOne(name);
  return out;
}

function conditionRefs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => conditionRefs(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "Condition" && typeof x === "string") out.push(x);
      else conditionRefs(x, out);
    }
  }
  return out;
}

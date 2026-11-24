// Contract drift, the comparison half. Rovara Code and Rovara Cloud each carry their own copy of packages/contracts, and Cloud's web app parses what Code answers with strict zod
// schemas, so a field Code adds to an answer is an error in Cloud until Cloud's schema learns it (Code 0.5.49 added `timeoutSeconds` to a setup item; Cloud's strict schema refused it).
// This module takes two JSON Schema documents (Code's, as exported from a Code checkout; Cloud's, from this repository) and lists every way a value that Code's schema produces would
// be refused by Cloud's schema of the same name. It reads no zod and no file: see extract.ts and ../contract-drift.ts.
//
// Direction: Code produces (zod "output" JSON Schema), Cloud accepts (zod "input" JSON Schema). Only that direction is checked.

export type DriftKind =
  /** Code can send a field the Cloud object does not list and Cloud's object is strict. */
  | "unknown-field"
  /** Cloud requires a field that Code may leave out. */
  | "missing-required"
  /** Code can send a JSON type Cloud does not accept. */
  | "type"
  /** Code can send a value (an enum member or a literal) Cloud does not accept. */
  | "enum"
  /** Code's length, size or numeric range is wider than Cloud's. */
  | "limit"
  /** Cloud has a pattern or format that Code's field does not promise. */
  | "pattern";

export interface Drift {
  /** `<file>#<ExportName>`, the schema both repositories export under the same name. */
  readonly schema: string;
  /** Where in a value: `setup[].value.timeoutSeconds`. Union branches are written `(1)`. */
  readonly path: string;
  readonly kind: DriftKind;
  readonly detail: string;
}

type Rec = Record<string, unknown>;
type Node = boolean | Rec;
export interface SchemaDocument {
  /** Every exported schema by `<file>#<ExportName>`. A `$ref` of `#/schemas/<id>` points here. */
  readonly schemas: Readonly<Record<string, Node>>;
  /** An export name that is the same schema object as another export: alias id to the id that holds it. */
  readonly aliases?: Readonly<Record<string, string>>;
}
interface Ctx { readonly doc: SchemaDocument; readonly root: Node }
interface View { readonly node: Rec; readonly ctx: Ctx }

const MAX_DEPTH = 80;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const recOf = (value: unknown): Rec => (isRec(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const numberOf = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

function resolveRef(ref: string, ctx: Ctx): { node: Node; ctx: Ctx } | undefined {
  if (ref === "#") return { node: ctx.root, ctx };
  const defs = /^#\/\$defs\/(.+)$/u.exec(ref);
  if (defs !== null && isRec(ctx.root)) {
    const found = recOf(ctx.root["$defs"])[defs[1] ?? ""] as Node | undefined;
    return found === undefined ? undefined : { node: found, ctx };
  }
  const schemas = /^#\/schemas\/(.+)$/u.exec(ref);
  if (schemas !== null) {
    const id = schemas[1] ?? "";
    const target = ctx.doc.schemas[ctx.doc.aliases?.[id] ?? id];
    return target === undefined ? undefined : { node: target, ctx: { doc: ctx.doc, root: target } };
  }
  return undefined;
}

function mergeAllOf(parts: View[]): View {
  const first = parts[0];
  if (first === undefined) return { node: {}, ctx: { doc: { schemas: {} }, root: {} } };
  const merged: Rec = {};
  const properties: Rec = {};
  const required = new Set<string>();
  let closed = true;
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.node)) {
      if (key === "properties") Object.assign(properties, recOf(value));
      else if (key === "required") for (const name of listOf(value)) required.add(String(name));
      else if (key === "additionalProperties") closed = closed && value === false;
      else if (key !== "allOf") merged[key] = value;
    }
  }
  if (Object.keys(properties).length > 0) merged["properties"] = properties;
  if (required.size > 0) merged["required"] = [...required];
  // An intersection of strict objects would accept nothing; the sound reading of "all of these" is every field of every part.
  if (Object.keys(properties).length > 0) merged["additionalProperties"] = closed ? false : true;
  return { node: merged, ctx: first.ctx };
}

/** Every alternative a node can be: refs followed, anyOf/oneOf flattened, allOf merged into one. */
function variantsOf(start: Node, startCtx: Ctx, depth = 0): View[] {
  if (depth > MAX_DEPTH) return [{ node: {}, ctx: startCtx }];
  if (start === true) return [{ node: {}, ctx: startCtx }];
  if (start === false) return [];
  let node = start;
  let ctx = startCtx;
  for (let hop = 0; typeof node["$ref"] === "string" && hop < MAX_DEPTH; hop += 1) {
    const next = resolveRef(node["$ref"], ctx);
    if (next === undefined) return [{ node: {}, ctx }];
    ctx = next.ctx;
    if (typeof next.node === "boolean") return variantsOf(next.node, ctx, depth + 1);
    node = next.node;
  }
  const alternatives = [...listOf(node["anyOf"]), ...listOf(node["oneOf"])];
  if (alternatives.length > 0) return alternatives.flatMap((alternative) => variantsOf(alternative as Node, ctx, depth + 1));
  const all = listOf(node["allOf"]);
  if (all.length > 0) {
    const own: Rec = { ...node };
    delete own["allOf"];
    const parts = [...(Object.keys(own).length > 0 ? [[{ node: own, ctx }]] : []), ...all.map((part) => variantsOf(part as Node, ctx, depth + 1))];
    // The product of each part's alternatives is rare in practice (an intersection of unions); take each part's first so a union inside an intersection is not expanded.
    return [mergeAllOf(parts.flatMap((part) => (part[0] === undefined ? [] : [part[0]])))];
  }
  return [{ node, ctx }];
}

function typesOf(node: Rec): string[] | undefined {
  const type = node["type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.map(String);
  if ("const" in node) return [jsonTypeOf(node["const"])];
  if (Array.isArray(node["enum"])) return [...new Set(node["enum"].map(jsonTypeOf))];
  if (isRec(node["properties"])) return ["object"];
  if ("items" in node || "prefixItems" in node) return ["array"];
  return undefined;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const typeAccepted = (type: string, accepted: readonly string[]): boolean => accepted.includes(type) || (type === "integer" && accepted.includes("number"));

/** Whether Cloud's node accepts one literal value Code can send (constraints on the value itself, not on its siblings). */
function valueFits(value: unknown, k: Rec): string | undefined {
  if ("const" in k && JSON.stringify(k["const"]) !== JSON.stringify(value)) return "not the literal Cloud allows";
  if (Array.isArray(k["enum"]) && !k["enum"].some((member) => JSON.stringify(member) === JSON.stringify(value))) return "not in Cloud's list";
  const accepted = typesOf({ type: k["type"] });
  if (accepted !== undefined && !typeAccepted(jsonTypeOf(value), accepted)) return "a type Cloud does not accept";
  if (typeof value === "string") {
    const max = numberOf(k["maxLength"]);
    const min = numberOf(k["minLength"]);
    if (max !== undefined && value.length > max) return "longer than Cloud allows";
    if (min !== undefined && value.length < min) return "shorter than Cloud allows";
    if (typeof k["pattern"] === "string" && !new RegExp(k["pattern"], "u").test(value)) return "does not match Cloud's pattern";
  }
  if (typeof value === "number") {
    const max = numberOf(k["maximum"]);
    const min = numberOf(k["minimum"]);
    if (max !== undefined && value > max) return "above Cloud's maximum";
    if (min !== undefined && value < min) return "below Cloud's minimum";
  }
  return undefined;
}

class Comparison {
  readonly issues: Array<Omit<Drift, "schema">> = [];
  #seen = new WeakMap<object, WeakSet<object>>();

  /** Every way a value Code's `c` produces is refused by Cloud's `k`. */
  compare(c: Node, cCtx: Ctx, k: Node, kCtx: Ctx, path: string): void {
    if (k === true) return;
    const cViews = variantsOf(c, cCtx);
    const kViews = variantsOf(k, kCtx);
    cViews.forEach((cView, index) => {
      const label = cViews.length > 1 ? `${path}(${String(index + 1)})` : path;
      if (this.#visited(cView.node, kViews)) return;
      this.#oneVariant(cView, kViews, label);
    });
  }

  #visited(cNode: Rec, kViews: readonly View[]): boolean {
    // A schema that refers to itself would be walked forever: a pair that is already being compared is taken as agreeing.
    let seen = this.#seen.get(cNode);
    if (seen === undefined) { seen = new WeakSet(); this.#seen.set(cNode, seen); }
    const key = kViews[0]?.node;
    if (key === undefined) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  }

  #oneVariant(cView: View, kViews: readonly View[], path: string): void {
    if (kViews.length === 0) { this.issues.push({ path, kind: "type", detail: "Cloud accepts no value here" }); return; }
    let best: Array<Omit<Drift, "schema">> | undefined;
    for (const kView of kViews) {
      const trial = new Comparison();
      trial.#seen = this.#seen;
      trial.#single(cView, kView, path);
      if (trial.issues.length === 0) return;
      if (best === undefined || trial.issues.length < best.length) best = trial.issues;
    }
    this.issues.push(...(best ?? []));
  }

  #single(cView: View, kView: View, path: string): void {
    const c = cView.node;
    const k = kView.node;
    const cTypes = typesOf(c);
    const kTypes = typesOf(k);
    if (cTypes !== undefined && kTypes !== undefined) {
      const refused = cTypes.filter((type) => !typeAccepted(type, kTypes));
      if (refused.length > 0) { this.issues.push({ path, kind: "type", detail: `Code sends ${refused.join("|")}; Cloud accepts ${kTypes.join("|")}` }); return; }
    }
    const literals = "const" in c ? [c["const"]] : Array.isArray(c["enum"]) ? c["enum"] : undefined;
    if (literals !== undefined) {
      for (const literal of literals) {
        const why = valueFits(literal, k);
        if (why !== undefined) this.issues.push({ path, kind: "enum", detail: `Code can send ${JSON.stringify(literal)}: ${why}` });
      }
      return;
    }
    if (cTypes?.includes("object") === true || isRec(c["properties"])) this.#object(cView, kView, path);
    if (cTypes?.includes("array") === true || "items" in c || "prefixItems" in c) this.#array(cView, kView, path);
    if (cTypes?.includes("string") === true) this.#string(c, k, path);
    if (cTypes?.some((type) => type === "number" || type === "integer") === true) this.#number(c, k, path);
  }

  #object(cView: View, kView: View, path: string): void {
    const c = cView.node;
    const k = kView.node;
    const cProps = recOf(c["properties"]);
    const kProps = recOf(k["properties"]);
    const kExtra = k["additionalProperties"];
    for (const [name, cProp] of Object.entries(cProps)) {
      const here = path === "" ? name : `${path}.${name}`;
      const kProp = kProps[name];
      if (kProp !== undefined) this.compare(cProp as Node, cView.ctx, kProp as Node, kView.ctx, here);
      else if (kExtra === false) this.issues.push({ path: here, kind: "unknown-field", detail: `Code sends "${name}"; Cloud's object is strict and does not list it` });
      else if (isRec(kExtra)) this.compare(cProp as Node, cView.ctx, kExtra, kView.ctx, here);
    }
    const cClosed = c["additionalProperties"] === false;
    const cRequired = new Set(listOf(c["required"]).map(String));
    for (const name of listOf(k["required"]).map(String)) {
      const here = path === "" ? name : `${path}.${name}`;
      if (cRequired.has(name)) continue;
      if (name in cProps) this.issues.push({ path: here, kind: "missing-required", detail: `Cloud requires "${name}"; Code may leave it out` });
      else if (cClosed) this.issues.push({ path: here, kind: "missing-required", detail: `Cloud requires "${name}"; Code's object has no such field` });
    }
    const cExtra = c["additionalProperties"];
    if (isRec(cExtra)) {
      if (kExtra === false && Object.keys(cProps).length === 0) this.issues.push({ path, kind: "unknown-field", detail: "Code sends a map of arbitrary keys; Cloud's object is strict" });
      else if (isRec(kExtra)) this.compare(cExtra, cView.ctx, kExtra, kView.ctx, `${path}{}`);
    }
  }

  #array(cView: View, kView: View, path: string): void {
    const c = cView.node;
    const k = kView.node;
    const cItems = c["items"];
    const kItems = k["items"];
    if ((isRec(cItems) || typeof cItems === "boolean") && (isRec(kItems) || typeof kItems === "boolean")) this.compare(cItems, cView.ctx, kItems, kView.ctx, `${path}[]`);
    const cPrefix = listOf(c["prefixItems"]);
    const kPrefix = listOf(k["prefixItems"]);
    cPrefix.forEach((item, index) => {
      const against = kPrefix[index] ?? (isRec(kItems) ? kItems : undefined);
      if (against !== undefined) this.compare(item as Node, cView.ctx, against as Node, kView.ctx, `${path}[${String(index)}]`);
    });
    const cMax = numberOf(c["maxItems"]);
    const kMax = numberOf(k["maxItems"]);
    if (kMax !== undefined && (cMax === undefined || cMax > kMax)) this.issues.push({ path, kind: "limit", detail: `Code allows ${cMax === undefined ? "any number of" : `up to ${String(cMax)}`} items; Cloud allows ${String(kMax)}` });
    const cMin = numberOf(c["minItems"]) ?? 0;
    const kMin = numberOf(k["minItems"]);
    if (kMin !== undefined && cMin < kMin) this.issues.push({ path, kind: "limit", detail: `Code allows ${String(cMin)} items; Cloud needs at least ${String(kMin)}` });
  }

  #string(c: Rec, k: Rec, path: string): void {
    const cMax = numberOf(c["maxLength"]);
    const kMax = numberOf(k["maxLength"]);
    if (kMax !== undefined && (cMax === undefined || cMax > kMax)) this.issues.push({ path, kind: "limit", detail: `Code allows ${cMax === undefined ? "any length" : `up to ${String(cMax)} characters`}; Cloud allows ${String(kMax)}` });
    const cMin = numberOf(c["minLength"]) ?? 0;
    const kMin = numberOf(k["minLength"]);
    if (kMin !== undefined && cMin < kMin) this.issues.push({ path, kind: "limit", detail: `Code allows ${String(cMin)} characters; Cloud needs at least ${String(kMin)}` });
    for (const key of ["pattern", "format"] as const) {
      if (typeof k[key] === "string" && c[key] !== k[key]) this.issues.push({ path, kind: "pattern", detail: `Cloud's ${key} is ${JSON.stringify(k[key])}; Code's is ${c[key] === undefined ? "none" : JSON.stringify(c[key])}` });
    }
  }

  #number(c: Rec, k: Rec, path: string): void {
    const cMax = numberOf(c["maximum"]);
    const kMax = numberOf(k["maximum"]);
    if (kMax !== undefined && (cMax === undefined || cMax > kMax)) this.issues.push({ path, kind: "limit", detail: `Code allows up to ${cMax === undefined ? "any number" : String(cMax)}; Cloud allows ${String(kMax)}` });
    const cMin = numberOf(c["minimum"]);
    const kMin = numberOf(k["minimum"]);
    if (kMin !== undefined && (cMin === undefined || cMin < kMin)) this.issues.push({ path, kind: "limit", detail: `Code allows down to ${cMin === undefined ? "any number" : String(cMin)}; Cloud needs at least ${String(kMin)}` });
  }
}

/** Every drift of one schema (the same id in both documents). */
export function compareSchema(id: string, code: SchemaDocument, cloud: SchemaDocument): Drift[] {
  const c = code.schemas[code.aliases?.[id] ?? id];
  const k = cloud.schemas[cloud.aliases?.[id] ?? id];
  if (c === undefined || k === undefined) return [];
  const comparison = new Comparison();
  comparison.compare(c, { doc: code, root: c }, k, { doc: cloud, root: k }, "");
  const seen = new Set<string>();
  const drifts: Drift[] = [];
  for (const issue of comparison.issues) {
    const key = `${issue.path}\u0000${issue.kind}\u0000${issue.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    drifts.push({ schema: id, ...issue });
  }
  return drifts;
}

export interface DriftReport {
  /** Schemas present under the same id in both documents and compared. */
  readonly compared: number;
  /** Ids Code exports that Cloud does not (a new Code schema is not a break: Cloud does not read it yet). */
  readonly onlyInCode: readonly string[];
  readonly drifts: readonly Drift[];
}

export function compareDocuments(code: SchemaDocument, cloud: SchemaDocument, only: (id: string) => boolean = () => true): DriftReport {
  const ids = [...new Set([...Object.keys(code.schemas), ...Object.keys(code.aliases ?? {})])].filter(only).sort();
  const drifts: Drift[] = [];
  const onlyInCode: string[] = [];
  let compared = 0;
  for (const id of ids) {
    const kId = cloud.aliases?.[id] ?? id;
    if (cloud.schemas[kId] === undefined) { onlyInCode.push(id); continue; }
    compared += 1;
    drifts.push(...compareSchema(id, code, cloud));
  }
  return { compared, onlyInCode, drifts };
}

/** The key a baseline entry uses: the schema, the place in a value, the kind of break and what exactly (a field name, an enum value, a limit). */
export const driftKey = (drift: Pick<Drift, "schema" | "path" | "kind" | "detail">): string => `${drift.schema} ${drift.path || "(root)"} ${drift.kind}: ${drift.detail}`;

/** A schema that Cloud's app sends to Code (a request body) is accepted by Code's parser, not Cloud's: the Code-to-Cloud comparison does not apply to it. */
export const isRequestSchemaName = (name: string): boolean => /(?:Body|Request|Input|Params|Query)Schema$/u.test(name);

export interface DriftGroup { readonly kind: DriftKind; readonly leaf: string; readonly detail: string; readonly schemas: readonly string[]; readonly example: Drift }

/** The same break reaches every schema that contains the changed object; one line per break and the schemas it reaches. */
export function groupDrifts(drifts: readonly Drift[]): DriftGroup[] {
  const groups = new Map<string, { example: Drift; schemas: Set<string> }>();
  for (const drift of drifts) {
    const leaf = drift.path.split(/[.\][]/u).filter((part) => part !== "" && !/^\(\d+\)$/u.test(part)).slice(-2).join(".");
    const key = `${drift.kind}|${leaf}|${drift.detail}`;
    const group = groups.get(key) ?? { example: drift, schemas: new Set<string>() };
    group.schemas.add(drift.schema);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({ kind: group.example.kind, leaf: key.split("|")[1] ?? "", detail: group.example.detail, schemas: [...group.schemas].sort(), example: group.example }))
    .sort((a, b) => b.schemas.length - a.schemas.length || a.leaf.localeCompare(b.leaf));
}

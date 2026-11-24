// Contract drift, the export half: load a set of contract modules (Code's from a Code checkout, Cloud's from this repository) and write every exported zod schema as one JSON Schema document
// (see compare.ts for what is done with two of them). The zod copy is passed in, so a Code checkout is read with its own zod.
import { pathToFileURL } from "node:url";
import type { SchemaDocument } from "./compare.js";

/** What a zod namespace must offer (zod 4). */
export interface ZodLike {
  registry<M extends { id: string }>(): { add(schema: never, meta: M): unknown };
  toJSONSchema(input: never, options?: Record<string, unknown>): unknown;
}

export interface ExtractOptions {
  /** A directory that holds `packages/contracts/src/<file>`. */
  readonly root: string;
  /** Repository-relative paths, `packages/contracts/src/<file>.ts`. */
  readonly files: readonly string[];
  readonly zod: ZodLike;
  /** `output` for what a producer sends (Code), `input` for what a parser accepts (Cloud). */
  readonly io: "input" | "output";
}

export interface Extracted extends SchemaDocument {
  readonly aliases: Readonly<Record<string, string>>;
  readonly skippedReaders: readonly string[];
  /** Files that could not be loaded (a file Code does not have is not an error here: it is listed so a refresh shows it). */
  readonly missingFiles: readonly string[];
  readonly loadErrors: readonly string[];
}

/**
 * A forward reader (forward-reader.ts) is built to accept fields and values a newer server adds, so it cannot break on drift, and its exports are the largest in the package.
 * They are left out on both sides.
 */
export const isForwardReaderName = (name: string): boolean => /Reader(?:Schema)?$/u.test(name);

const isZodSchema = (value: unknown): boolean => typeof value === "object" && value !== null && "_zod" in value;

export async function extractSchemas(options: ExtractOptions): Promise<Extracted> {
  const registry = options.zod.registry<{ id: string }>();
  const firstId = new Map<object, string>();
  const aliases: Record<string, string> = {};
  const skippedReaders: string[] = [];
  const missingFiles: string[] = [];
  const loadErrors: string[] = [];
  const prefix = "packages/contracts/src/";
  for (const file of [...options.files].sort()) {
    const shortName = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(`${options.root}/${file}`).href)) as Record<string, unknown>;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/ERR_MODULE_NOT_FOUND|Cannot find module|Failed to load url|Failed to resolve/u.test(text) && text.includes(file)) missingFiles.push(shortName);
      else loadErrors.push(`${shortName}: ${text.slice(0, 200)}`);
      continue;
    }
    for (const [name, value] of Object.entries(module).sort(([a], [b]) => a.localeCompare(b))) {
      if (!isZodSchema(value)) continue;
      const id = `${shortName}#${name}`;
      if (isForwardReaderName(name)) { skippedReaders.push(id); continue; }
      const earlier = firstId.get(value as object);
      if (earlier !== undefined) { aliases[id] = earlier; continue; }
      firstId.set(value as object, id);
      registry.add(value as never, { id });
    }
  }
  const converted = options.zod.toJSONSchema(registry as never, { io: options.io, unrepresentable: "any", cycles: "ref", reused: "inline", uri: (id: string) => `#/schemas/${id}` }) as { schemas: Record<string, Record<string, unknown>> };
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const [id, schema] of Object.entries(converted.schemas).sort(([a], [b]) => a.localeCompare(b))) schemas[id] = strip(schema) as Record<string, unknown>;
  return { schemas, aliases, skippedReaders, missingFiles, loadErrors };
}

/** Prose and defaults do not decide whether a value is accepted. The keys of a `properties` or `$defs` map are field names, not keywords, so they are kept whatever they are called. */
function strip(value: unknown, isMap = false): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!isMap && (key === "$schema" || key === "$id" || key === "description" || key === "title" || key === "examples" || key === "default" || key === "deprecated")) continue;
    out[key] = strip(inner, !isMap && (key === "properties" || key === "$defs" || key === "patternProperties"));
  }
  return out;
}

import { WorkflowDesignReviewSchema } from "./design-review.js";
import type { TaskMoneyV1 } from "./task-money.js";
import { TaskMoneyV1Schema } from "./task-money-schema.js";
// Forward-compatible readers, shared by the chain session views (chain-session.ts) and the agent session views (session-views.ts).
import { z } from "zod";

export const UNKNOWN = "unknown" as const;

/**
 * A value of an enum that reads a string a newer server added as "unknown". A missing or non-string value stays an error.
 * Plan 4 and Plan 5 each had their own: Plan 4's was `z.enum(values).catch("unknown")`, which also turned a missing or malformed value into "unknown";
 * this one (Plan 5's) is the shared definition, so a value that is missing stays an error for both.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(values: T): z.ZodType<T[number] | typeof UNKNOWN> {
  return z.string().transform((value): T[number] | typeof UNKNOWN => ((values as readonly string[]).includes(value) ? value : UNKNOWN));
}

/** What a reader gives for a strict type: objects keep unknown fields, and a string-literal or number-literal union may read as "unknown". */
export type ForwardReader<T> = T extends TaskMoneyV1 ? TaskMoneyV1 : T extends string
  ? string extends T ? T : T | typeof UNKNOWN
  : T extends number
    ? number extends T ? T : T | typeof UNKNOWN
  : T extends readonly (infer Item)[]
    ? Array<ForwardReader<Item>>
    : T extends object
      ? { [Key in keyof T]: ForwardReader<T[Key]> } & { [other: string]: unknown }
      : T;

type Def = { type: string } & Record<string, unknown>;
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/**
 * The reader for a strict schema: objects become `looseObject`s, enums become `openEnum`s, an object variant of a discriminated union with a
 * kind the schema doesn't know is read with `kind: "unknown"` and its other fields kept, and everything else (strings, numbers, literals,
 * arrays, optionals) is rebuilt around the same pieces. Length and pattern rules on plain values are kept.
 */
export function forwardReader<S extends z.ZodType>(schema: S): z.ZodType<ForwardReader<z.output<S>>> {
  return readerOf(schema) as z.ZodType<ForwardReader<z.output<S>>>;
}

// A design review's read projection may omit money at every depth. Keep that
// omission through the outer task/session reader; the Design tab validates the
// rest of the review exactly before rendering it. Stored schemas are unchanged.
function designReviewReader(schema: z.ZodType): z.ZodType {
  const def = defOf(schema);
  switch (def.type) {
    case "object": return z.looseObject(Object.fromEntries(Object.entries((schema as z.ZodObject).shape).map(([key, field]) => {
      const read = designReviewReader(field as z.ZodType);
      return [key, /Usd(?:PerTask)?$/u.test(key) ? read.optional() : read];
    })));
    case "array": return z.array(designReviewReader(def.element as z.ZodType));
    case "optional": return designReviewReader(def.innerType as z.ZodType).optional();
    case "union": return z.union((def.options as z.ZodType[]).map(designReviewReader));
    default: return readerOf(schema);
  }
}

export function readerOf(schema: z.ZodType): z.ZodType {
  if (schema === WorkflowDesignReviewSchema) return designReviewReader(schema);
  // DECOUPLE T2: task money is read exactly or not at all (parseTaskMoneyV1 refuses any extra key or unknown word: unknown money never becomes exact money). A money block this build cannot read used to refuse the whole
  // session; it now reads as no money ("Cost unavailable") and the rest of the answer is kept. Nothing in it is ever partly read or interpreted.
  if (schema === TaskMoneyV1Schema) return schema.catch(undefined as never);
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape: Record<string, z.ZodType> = (schema as unknown as z.ZodObject).shape;
      return z.looseObject(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, readerOf(field)])));
    }
    case "enum":
      return openEnum((schema as unknown as z.ZodEnum).options as unknown as readonly [string, ...string[]]);
    case "array":
      return z.array(readerOf(def.element as z.ZodType));
    case "optional": {
      const inner = defOf(def.innerType as z.ZodType);
      // A flag that grants something by being `true` (`you.mayMerge`, `you.coOwner`, `live.ask`): any other value a newer Code sends reads as absent, which grants nothing, instead of refusing the whole answer.
      if (inner.type === "literal" && [...(inner.values as unknown[])].every((value) => value === true)) return (def.innerType as z.ZodType).optional().catch(undefined as never);
      return readerOf(def.innerType as z.ZodType).optional();
    }
    // DECOUPLE T2: the wrappers are looked through too. Before, `x.nullable()` / `.default()` / `.readonly()` kept the strict object or closed enum inside as it was, so a newer Code's extra field (or new word)
    // under a nullable object refused the whole answer. A `.catch()` already tolerates any inner failure and is left as it is.
    case "nullable":
      return readerOf(def.innerType as z.ZodType).nullable();
    case "nonoptional":
      return readerOf(def.innerType as z.ZodType).nonoptional();
    case "readonly":
      return readerOf(def.innerType as z.ZodType).readonly();
    case "default": {
      const inner = readerOf(def.innerType as z.ZodType);
      // Keep the schema's own default, whether it is a value or a function. A default that is an unknown-able word keeps being that word.
      return inner.default(def.defaultValue as never);
    }
    case "record": {
      // Only a record keyed by plain strings with no checks of its own is rebuilt (its values are read like any other value: an enum in a record's list is open). An enum-keyed or partial record, or one with a
      // refinement, stays as the schema has it: rebuilding it would make it exhaustive or drop the refinement.
      const keyDef = defOf(def.keyType as z.ZodType);
      if (keyDef.type !== "string" || def.partial === true || ((def.checks as unknown[] | undefined)?.length ?? 0) > 0) return schema;
      return z.record(def.keyType as z.ZodType<string>, readerOf(def.valueType as z.ZodType));
    }
    case "union": {
      const options = def.options as z.ZodType[];
      if (typeof def.discriminator !== "string" && options.length > 1 && options.every((option) => defOf(option).type === "literal")) {
        // A union of literals (a tier 0 | 1 | 2, a count of people 1 | 2): a value of the same kind that none of them names reads as "unknown". A value of another kind, or a missing one, stays an error.
        const values = options.flatMap((option) => [...((option as unknown as z.ZodLiteral).values as Set<unknown>)]);
        const kind = values.every((value) => typeof value === "string") ? z.string() : values.every((value) => typeof value === "number") ? z.number() : undefined;
        if (kind !== undefined) return z.union([...options, kind.transform((): typeof UNKNOWN => UNKNOWN)] as unknown as [z.ZodType, z.ZodType]);
      }
      if (typeof def.discriminator !== "string") {
        // RULING Q41: an open enum must not swallow a valid sibling ID or another known enum value.
        const known = options.map(option => defOf(option).type === "enum" ? option : readerOf(option));
        const fallbacks = options.filter(option => defOf(option).type === "enum").map(readerOf);
        return z.union([...known, ...fallbacks] as unknown as [z.ZodType, z.ZodType]);
      }
      const discriminator = def.discriminator;
      const known = options.flatMap((option) => [...((option as unknown as z.ZodObject).shape[discriminator] as unknown as z.ZodLiteral).values]);
      const unknownVariant = z.looseObject({ [discriminator]: z.string().refine((value) => !known.includes(value)).transform((): typeof UNKNOWN => UNKNOWN) });
      return z.union([...options.map(readerOf), unknownVariant] as unknown as [z.ZodType, z.ZodType]);
    }
    default:
      return schema;
  }
}

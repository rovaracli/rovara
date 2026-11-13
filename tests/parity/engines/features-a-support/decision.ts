// Decision parity: the same inputs through Cloud's copy and the core's copy of a feature's decision functions, compared word for word.
//
// Why at this level for second review, design review, e2e and lessons: each feature's choices (whether it runs, on which model, what a reviewer's report
// counts for, when a wait parks, which lessons load, what the e2e verifier concludes from the evidence) live in pure or store-backed functions that Cloud
// and Code each carry a copy of (packages/broker/src/... and vendor/.../core/...). Neither journey can reach the feature end to end on fakes yet (see the
// drivers' notes), but the copies can be held to the same answers on the same inputs, which is what the switch moves.
//
// A case names a function, a label and its arguments. Each engine runs the case on its own implementation and records one word per case in the
// features facet: `<fn>#<label>=<answer>`. The answer is the result as stable JSON (sorted keys); a long one is cut with a digest of the whole, so a
// difference anywhere in it still shows. A throw is an answer too (`!threw:<name>:<message>`), and a function one side does not have is `!missing`.
import { createHash } from "node:crypto";

export interface DecisionCase {
  fn: string;
  label: string;
  /** The arguments; a function of the engine's own helpers when a case needs them (a marked setting, a store). */
  args: readonly unknown[] | ((kit: DecisionKit) => readonly unknown[] | Promise<readonly unknown[]>);
}

/** What an engine gives a case that needs its own helpers. */
export interface DecisionKit {
  engine: "cloud" | "core";
  /** Free per-engine helpers keyed by name (a store over an engine's storage, a marking function). */
  helpers: Readonly<Record<string, unknown>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the implementations have many shapes; a case's args are the shapes both sides take.
export type DecisionImplementations = Readonly<Record<string, ((...args: any[]) => unknown) | undefined>>;

const ANSWER_MAX = 240;

export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (entry: unknown): unknown => {
    if (entry === undefined) return "<undefined>";
    if (typeof entry === "function") return "<function>";
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Date) return entry.toISOString();
    if (entry instanceof Map) return walk(Object.fromEntries([...entry.entries()].map(([key, item]) => [String(key), item])));
    if (entry instanceof Set) return walk([...entry.values()]);
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry !== null && typeof entry === "object") {
      if (seen.has(entry)) return "<cycle>";
      seen.add(entry);
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, walk((entry as Record<string, unknown>)[key])]));
    }
    return entry;
  };
  return JSON.stringify(walk(value)) ?? "<undefined>";
}

export function answerWord(value: unknown): string {
  const text = stableJson(value);
  if (text.length <= ANSWER_MAX) return text;
  return `${text.slice(0, 160)}…#${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/** One word per case, in case order. Never throws: a throw is the case's answer. */
export async function decisionWords(implementations: DecisionImplementations, cases: readonly DecisionCase[], kit: DecisionKit): Promise<string[]> {
  const words: string[] = [];
  for (const entry of cases) {
    const fn = implementations[entry.fn];
    const head = `${entry.fn}#${entry.label}`;
    if (fn === undefined) { words.push(`${head}=!missing`); continue; }
    try {
      const args = typeof entry.args === "function" ? await entry.args(kit) : entry.args;
      words.push(`${head}=${answerWord(await fn(...args))}`);
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      const message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 80) : "";
      words.push(`${head}=!threw:${name}:${message}`);
    }
  }
  return words;
}

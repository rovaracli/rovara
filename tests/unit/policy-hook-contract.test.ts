// Lane H: contract H-1. contracts/shared/policy-hook.v1.json is byte-identical here and in Rovara Code: its SHA-256 is pinned as a literal, and the same
// literal is pinned in Code's test, so an edit to one copy fails until the other matches. The answering route's module must agree with the file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POLICY_HOOK, POLICY_HOOK_ANSWER_CLAIMS, POLICY_HOOK_ANSWER_KINDS, POLICY_HOOK_KINDS, POLICY_HOOK_PATTERNS, POLICY_HOOK_QUESTION_CLAIMS, POLICY_HOOK_QUESTION_KINDS, POLICY_HOOK_WORDS,
} from "../../packages/cloud-server/src/policy-hook.js";

const text = readFileSync(new URL("../../contracts/shared/policy-hook.v1.json", import.meta.url), "utf8");
const shared = JSON.parse(text) as {
  version: number; constants: Record<string, unknown>; patterns: Record<string, string>; words: Record<string, string>;
  question: { claims: Array<{ name: string; required: boolean }>; kinds: Record<string, Array<{ name: string; required: boolean }>> };
  answer: { claims: Array<{ name: string; required: boolean }>; kinds: Record<string, Array<{ name: string; required: boolean }>> };
};
const names = (fields: readonly { name: string; required: boolean }[]) => fields.map(({ name, required }) => ({ name, required }));

describe("contract H-1", () => {
  it("pins the shared bytes (the same literal is pinned in Rovara Code)", () => {
    expect(createHash("sha256").update(text).digest("hex")).toBe("0253a35628b1441d37dcd5fce2553fc4b4d0913a498a58f7cda484d22de27493");
    expect(text).toBe(`${JSON.stringify(shared, null, 2)}\n`);
  });

  it("constants, patterns and words match the shared file", () => {
    const { version, ...constants } = POLICY_HOOK;
    expect(version).toBe(shared.version);
    expect(constants).toEqual(shared.constants);
    expect(Object.fromEntries(Object.entries(POLICY_HOOK_PATTERNS).map(([name, pattern]) => [name, pattern.source]))).toEqual(shared.patterns);
    expect({ ...POLICY_HOOK_WORDS }).toEqual(shared.words);
  });

  it("claim lists match the shared file, name for name and required for required", () => {
    expect(names(POLICY_HOOK_QUESTION_CLAIMS)).toEqual(names(shared.question.claims));
    expect(names(POLICY_HOOK_ANSWER_CLAIMS)).toEqual(names(shared.answer.claims));
    expect(Object.keys(shared.question.kinds)).toEqual([...POLICY_HOOK_KINDS]);
    for (const kind of POLICY_HOOK_KINDS) {
      expect(names(POLICY_HOOK_QUESTION_KINDS[kind]), kind).toEqual(names(shared.question.kinds[kind]!));
      expect(names(POLICY_HOOK_ANSWER_KINDS[kind]), kind).toEqual(names(shared.answer.kinds[kind]!));
    }
  });
});

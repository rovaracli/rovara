// DECOUPLE T2: Cloud's readers of Code's answers tolerate what a newer Code adds (an unknown field at ANY depth, an unknown word), and an unknown word never turns into permission or money.
import { describe, expect, it } from "vitest";
import * as zod from "zod";
import { z } from "zod";
import { check, extractCloud, parsedSchemaNames, readSnapshot } from "../../scripts/contract-drift/run.js";
import * as web from "../../packages/contracts/src/web.js";
import { SessionViewSchema, SessionViewReaderSchema, SessionResponseReaderSchema, forwardReader } from "@agentx/contracts/web";
import { sessionFixture } from "../web/support/session-fixture.js";

// What Code's SessionView carries today that Cloud's copy of the schema (packages/contracts/src/session-views.ts) does not: `display` and `you.chargedTo` (TASK-TAKEOVER PR A, the cause of the #1516 beta
// release failing closed). This is Code's view as Code serves it, so the strict schema Cloud holds refuses it and the reader Cloud parses with must not.
function codeSessionView(extra: { you?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  const base = sessionFixture();
  return { ...base, display: { state: "needs_you", reason: "A person needs to decide what happens next.", next: "Open the plan." }, ...extra.top, you: { ...base.you, owner: false, chargedTo: "Charged to Priya", ...extra.you } };
}

describe("#1516: Code's session view with fields Cloud's schema does not have", () => {
  it("is refused by the strict schema (the failure) and read by the readers Cloud uses", () => {
    const view = codeSessionView();
    expect(SessionViewSchema.safeParse(view).success).toBe(false);
    for (const read of [SessionViewReaderSchema.parse(view), SessionResponseReaderSchema.parse({ session: view }).session]) {
      expect(read.you.chargedTo).toBe("Charged to Priya");
      expect(read.you.owner).toBe(false); // chargedTo names who pays; it never makes the reader the owner
      expect(read.sessionId).toBe(view.sessionId);
    }
  });
  it("does not fail the deployed-drift gate: the gate compares only schemas Cloud parses in code, and nothing parses a session with the strict SessionViewSchema", async () => {
    // Code's side as origin/code/next serves it: the pinned snapshot plus `you.chargedTo`.
    const snapshot = structuredClone(readSnapshot());
    const view = snapshot.schemas["session-views.ts#SessionViewSchema"] as unknown as { properties: { you: { properties: Record<string, unknown> } } };
    view.properties.you.properties["chargedTo"] = { type: "string", minLength: 1, maxLength: 260 };
    const cloud = await extractCloud(zod as never);
    const named = (drifts: readonly { schema: string; path: string }[]) => drifts.filter(drift => drift.schema.endsWith("#SessionViewSchema") && drift.path === "you.chargedTo");
    // Before T2 a comment made the strict schema count as parsed, and the gate refused the release (the #1516 failure).
    expect(named(check(snapshot, cloud, [], new Set([...parsedSchemaNames(), "SessionViewSchema"])).unaccepted)).toHaveLength(1);
    expect(named(check(snapshot, cloud, []).report.drifts)).toHaveLength(0);
  });
  it("reads a field a newer Code adds at every depth of the view, including the nested strict objects", () => {
    const view = codeSessionView({ top: { future: 1, cost: { ...sessionFixture().cost, futureCost: true, payer: { ...sessionFixture().cost.payer, id: "p-1" } }, where: { kind: "mac", label: "L", offline: false, future: 1 } }, you: { future: "x", live: { ask: true, future: true } } });
    const read = SessionViewReaderSchema.parse(view);
    expect(read.you["future"]).toBe("x");
    expect(read.you.live?.["future"]).toBe(true);
    expect(read.cost.payer["id"]).toBe("p-1");
  });
});

describe("forwardReader is deep", () => {
  const Strict = z.object({
    you: z.object({ level: z.enum(["view", "use"]), nested: z.object({ n: z.number() }).strict().nullable(), more: z.object({ k: z.enum(["a", "b"]) }).strict().default({ k: "a" }), list: z.array(z.object({ s: z.string() }).strict().nullable()).readonly() }).strict().optional(),
  }).strict();
  const input = { you: { level: "future", f: 1, nested: { n: 1, f: 2 }, more: { k: "c", f: 3 }, list: [{ s: "x", f: 4 }, null] }, f: 5 };
  it("accepts an unknown key under nullable, default, readonly, array and optional wrappers, and reads an unknown word as unknown", () => {
    expect(Strict.safeParse(input).success).toBe(false);
    const read = forwardReader(Strict).parse(input) as { you: { level: string; nested: { f: number }; more: { k: string; f: number }; list: Array<{ f: number } | null> } };
    expect(read.you.level).toBe("unknown");
    expect(read.you.nested.f).toBe(2);
    expect(read.you.more).toEqual({ k: "unknown", f: 3 });
    expect(read.you.list[0]?.f).toBe(4);
  });
  it("still refuses a missing or wrongly typed value, and keeps a schema's default", () => {
    const reader = forwardReader(Strict);
    expect(reader.safeParse({ you: { level: 3, nested: null, list: [] } }).success).toBe(false);
    expect(reader.safeParse({ you: { level: "view", nested: { n: "x" }, list: [] } }).success).toBe(false);
    expect((reader.parse({ you: { level: "view", nested: null, list: [] } }) as { you: { more: unknown } }).you.more).toEqual({ k: "a" });
  });
  it("no reader the contracts export keeps a strict object or a closed enum, except the named exact pieces", () => {
    type Def = { type: string } & Record<string, unknown>;
    const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;
    const offenders: string[] = [];
    const walk = (schema: unknown, path: string, name: string, seen: Set<unknown>): void => {
      if (schema === undefined || seen.has(schema)) return;
      seen.add(schema);
      const def = defOf(schema);
      switch (def.type) {
        case "object": {
          const catchall = def["catchall"];
          if (catchall === undefined || defOf(catchall).type === "never") offenders.push(`${name} strict object at ${path}`);
          for (const [key, field] of Object.entries((schema as z.ZodObject).shape)) walk(field, `${path}.${key}`, name, seen);
          return;
        }
        case "enum": offenders.push(`${name} closed enum at ${path}`); return;
        case "array": walk(def["element"], `${path}[]`, name, seen); return;
        // A `.catch()` falls back whatever the inner value is, so nothing under it can refuse an answer.
        case "catch": return;
        case "optional": case "nullable": case "default": case "readonly": case "nonoptional": case "prefault": walk(def["innerType"], path, name, seen); return;
        // A closed enum next to its own open fallback (RULING Q41: the known words are tried first so a valid sibling id is not swallowed) is not a closed reader.
        case "union": for (const option of def["options"] as unknown[]) if (defOf(option).type !== "enum") walk(option, `${path}|`, name, seen); return;
        case "record": walk(def["valueType"], `${path}{}`, name, seen); return;
        case "intersection": walk(def["left"], path, name, seen); walk(def["right"], path, name, seen); return;
        default: return;
      }
    };
    for (const [name, value] of Object.entries(web)) if (/ReaderSchema$/u.test(name) && value !== null && typeof value === "object" && "_zod" in value) walk(value, "", name, new Set());
    expect(offenders.filter((line) => !HAND_WRITTEN_EXACT_READERS.includes(line.split(" ")[0]!))).toEqual([]);
  });
});

/**
 * Hand-written readers (not built by forwardReader) that still hold strict objects or closed enums. They are access, money, destructive-confirmation or plan-review readers read exactly on purpose, or not yet converted
 * (DECOUPLE-T2-DONE.md lists each with the reason). Every other reader the contracts export is open at every depth. A name is added here only with a reason in that file.
 */
const HAND_WRITTEN_EXACT_READERS = [
  "DecisionOutcomeReaderSchema", "JiraOrgAdminResultReaderSchema", "LoadedKnowledgeResponseReaderSchema", "LoadedKnowledgeTextReaderSchema", "ModelSelectionPolicyResponseReaderSchema", "OrgServiceStatusReaderSchema",
  "OrgSlackWorkspaceEvidenceResponseReaderSchema", "ProjectAllowedWebsitesProposalReaderSchema", "ProjectAllowedWebsitesResultReaderSchema", "ProjectAllowedWebsitesReviewReaderSchema", "ProjectSlackDecisionReaderSchema",
  "ProjectSlackInventoryReaderSchema", "ProjectSlackProposalReaderSchema", "ProjectSlackReceiptReaderSchema", "ProjectSlackTargetReaderSchema", "ProjectWorkingBranchContextReaderSchema", "ProjectWorkingBranchPageReaderSchema",
  "ProjectWorkingBranchPreviewReaderSchema", "ProjectWorkingBranchSaveResultReaderSchema", "ReviewedProjectArchiveOutcomeReaderSchema", "ReviewedProjectArchivePreviewReaderSchema", "ReviewedProjectRestoreOutcomeReaderSchema",
  "ReviewedProjectRestorePreviewReaderSchema", "TrackerPeopleReaderSchema", "TrackerPeopleResultReaderSchema",
];

describe("an unknown word never grants and never becomes money", () => {
  it("an action or access level a newer Code adds reads as unknown, and the grant flags read absent unless they are exactly true", () => {
    const read = SessionViewReaderSchema.parse(codeSessionView({ you: { actions: ["watch", "teleport_task"], level: "root", mayMerge: "yes", coOwner: false, live: { ask: "maybe" } } }));
    expect(read.you.actions).toEqual(["watch", "unknown"]);
    expect(read.you.level).toBe("unknown");
    expect(read.you.mayMerge).toBeUndefined();
    expect(read.you.coOwner).toBeUndefined();
    expect(SessionViewReaderSchema.parse(codeSessionView({ you: { mayMerge: true, coOwner: true } })).you.mayMerge).toBe(true);
  });
  it("a money block this build cannot read reads as no money, and the rest of the session is kept (never partly read)", () => {
    const read = SessionViewReaderSchema.parse(codeSessionView({ top: { money: { version: 1, taskId: "t", futureField: true } } }));
    expect(read.money).toBeUndefined();
    expect(read.title).toBe(sessionFixture().title);
  });
  it("charged-to, payer and cost words pass through as plain words and are not read by the reader as anything else", () => {
    const read = SessionViewReaderSchema.parse(codeSessionView({ top: { cost: { ...sessionFixture().cost, payer: { kind: "robot", name: "Future payer" } } } }));
    expect(read.cost.payer).toEqual({ kind: "unknown", name: "Future payer" });
    expect(read.you.chargedTo).toBe("Charged to Priya");
  });
});

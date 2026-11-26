// DECOUPLE T2: Cloud's readers of Code's answers tolerate what a newer Code adds (an unknown field at ANY depth, an unknown word), and an unknown word never turns into permission or money.
import { describe, expect, it } from "vitest";
import * as zod from "zod";
import { z } from "zod";
import { check, extractCloud, HAND_WRITTEN_EXACT_READERS as EXACT_READERS, parsedSchemaNames, readSnapshot } from "../../scripts/contract-drift/run.js";
import * as web from "../../packages/contracts/src/web.js";
import { SessionViewSchema, SessionViewReaderSchema, SessionResponseReaderSchema, forwardReader } from "@agentx/contracts/web";
import { DISPLAY_FLAG_KEYS, GRANT_FLAG_KEYS, WARNING_FLAG_KEYS } from "../../packages/contracts/src/forward-reader.js";
import { sessionFixture } from "../web/support/session-fixture.js";

// What Code's SessionView carries today that Cloud's copy of the schema (packages/contracts/src/session-views.ts) does not: `display`, and (until the one-field single landed on cloud/next) `you.chargedTo` (TASK-TAKEOVER PR A, the cause of the #1516 beta
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
    // Code's side as a newer origin/code/next serves it: the pinned snapshot plus a `you` field Cloud's schema does not have. (`you.chargedTo` itself is in Cloud's schema since the one-field single landed on
    // cloud/next, so the #1516 shape is reproduced with a made-up field; the gate treats every such field alike.)
    const snapshot = structuredClone(readSnapshot());
    const view = snapshot.schemas["session-views.ts#SessionViewSchema"] as unknown as { properties: { you: { properties: Record<string, unknown> } } };
    view.properties.you.properties["futureNote"] = { type: "string", minLength: 1, maxLength: 260 };
    const cloud = await extractCloud(zod as never);
    const named = (drifts: readonly { schema: string; path: string }[]) => drifts.filter(drift => drift.schema.endsWith("#SessionViewSchema") && drift.path === "you.futureNote");
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
    const read = forwardReader(Strict).parse(input) as unknown as { you: { level: string; nested: { f: number }; more: { k: string; f: number }; list: Array<{ f: number } | null> } };
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

// The hand-written exact readers (scripts/contract-drift/run.ts HAND_WRITTEN_EXACT_READERS): the gate compares Code with their strict schemas. Each stays only with a reason in DECOUPLE-T2-DONE.md.
const HAND_WRITTEN_EXACT_READERS = EXACT_READERS;

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

// Pre-review S1: a `key?: true` flag a newer Code sends unreadably (`false`, a word, an object) reads by what the flag DOES. A grant reads as absent (grants nothing); a warning never reads as "no warning" (only an explicit false/null
// is absent; anything else shows the warning); a display label reads as absent. The lists are pinned here, and a walk over every reader the contracts export fails when a flag is in none of them without being on the strict list.
describe("true-only flags read by what they do", () => {
  it("pins the three lists", () => {
    expect([...GRANT_FLAG_KEYS]).toEqual(["approved", "ask", "coOwner", "fix", "mayMerge", "notesSwitch"]);
    expect([...WARNING_FLAG_KEYS]).toEqual([
      "broken", "lastRunFailed", "linked", "madeByRovara", "neverStarted", "noOtherCompany", "notRevised", "offline", "otherCompanyFailed", "partialDiff", "programNotFound", "retireProposed", "notesOptIn", "reviewRequired",
      "sameModelAsPlanner", "trialUsed", "truncated", "unlisted", "workflowBlocked",
    ]);
    expect([...DISPLAY_FLAG_KEYS]).toEqual(["process", "you"]);
    expect(new Set([...GRANT_FLAG_KEYS, ...WARNING_FLAG_KEYS, ...DISPLAY_FLAG_KEYS]).size).toBe(GRANT_FLAG_KEYS.length + WARNING_FLAG_KEYS.length + DISPLAY_FLAG_KEYS.length);
  });
  // Pre-review S1 / Opus S3: the flags are classified by PATH (reader and field), not by bare key name, so a new schema that reuses a listed key (a `fix: true` that means "a fix is needed") fails here until it is decided.
  it("every true-only flag, at every path of every reader the contracts export, is pinned with its class (a new path must be classified; a listed key at a new path fails)", () => {
    type Def = { type: string } & Record<string, unknown>;
    const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;
    const found: Record<string, string> = {};
    const classOf = (key: string, caught: boolean): string => !caught ? "strict" : GRANT_FLAG_KEYS.includes(key) ? "grant" : WARNING_FLAG_KEYS.includes(key) ? "warning" : DISPLAY_FLAG_KEYS.includes(key) ? "display" : "caught-unlisted";
    const walk = (schema: unknown, reader: string, path: string, seen: Set<unknown>): void => {
      if (schema === undefined || seen.has(schema)) return;
      seen.add(schema);
      const def = defOf(schema);
      switch (def.type) {
        case "object":
          for (const [key, field] of Object.entries((schema as z.ZodObject).shape)) {
            let current: unknown = field; let optional = false; let caught = false;
            for (;;) {
              const inner = defOf(current);
              if (inner.type === "optional") { optional = true; current = inner["innerType"]; } else if (inner.type === "catch") { caught = true; current = inner["innerType"]; } else if (["nullable", "default", "readonly", "nonoptional", "prefault"].includes(inner.type)) current = inner["innerType"]; else break;
            }
            const literal = defOf(current);
            if (optional && literal.type === "literal" && [...(literal["values"] as unknown[])].every((value) => value === true)) found[`${reader}${path}.${key}`] = classOf(key, caught);
            walk(current, reader, `${path}.${key}`, seen);
          }
          return;
        case "array": walk(def["element"], reader, `${path}[]`, seen); return;
        case "optional": case "nullable": case "default": case "readonly": case "nonoptional": case "prefault": case "catch": walk(def["innerType"], reader, path, seen); return;
        case "union": for (const option of def["options"] as unknown[]) walk(option, reader, path, seen); return;
        case "record": walk(def["valueType"], reader, `${path}{}`, seen); return;
        case "intersection": walk(def["left"], reader, path, seen); walk(def["right"], reader, path, seen); return;
        default: return;
      }
    };
    for (const [name, value] of Object.entries(web)) if (/ReaderSchema$/u.test(name) && value !== null && typeof value === "object" && "_zod" in value) walk(value, name, "", new Set());
    // The same flag classes as the key lists, listed per path. "strict" = on no list: it keeps the schema's own reading (an unreadable value refuses the answer), in a hand-written or design-review reader.
    expect(found).toEqual(PINNED_FLAG_PATHS);
    // Every key on a list is used at some pinned path (a dead list entry is removed), and no path is "caught-unlisted".
    expect(Object.values(found)).not.toContain("caught-unlisted");
    for (const key of [...GRANT_FLAG_KEYS, ...WARNING_FLAG_KEYS, ...DISPLAY_FLAG_KEYS]) expect(Object.keys(found).some((path) => path.endsWith(`.${key}`)), `${key} is used`).toBe(true);
  });
  const Flags = z.object({ mayMerge: z.literal(true).optional(), lastRunFailed: z.literal(true).optional(), you: z.literal(true).optional(), oddFlag: z.literal(true).optional() }).strict();
  const flags = forwardReader(Flags);
  it.each([["a word", "yes"], ["a number", 1], ["an object", { reason: "x" }], ["false", false], ["null", null]])("a GRANT flag sent as %s reads as absent (grants nothing); only true grants", (_name, value) => {
    expect((flags.parse({ mayMerge: value }) as { mayMerge?: unknown }).mayMerge).toBeUndefined();
    expect((flags.parse({ mayMerge: true }) as { mayMerge?: unknown }).mayMerge).toBe(true);
  });
  it.each([["a word", "yes"], ["a number", 1], ["an object", { reason: "x" }], ["an array", []], ["the string false", "false"]])("a WARNING flag sent as %s reads as true: the warning is shown, never hidden", (_name, value) => {
    expect((flags.parse({ lastRunFailed: value }) as { lastRunFailed?: unknown }).lastRunFailed).toBe(true);
  });
  it.each([["false", false], ["null", null]])("a WARNING flag Code sends as an explicit %s reads as absent (Code said there is no warning)", (_name, value) => {
    expect((flags.parse({ lastRunFailed: value }) as { lastRunFailed?: unknown }).lastRunFailed).toBeUndefined();
    expect("lastRunFailed" in (flags.parse({}) as object)).toBe(false);
    expect((flags.parse({ lastRunFailed: true }) as { lastRunFailed?: unknown }).lastRunFailed).toBe(true);
  });
  it("a DISPLAY flag reads as absent when unreadable, and a flag on no list keeps the strict reading (an unreadable value refuses the answer)", () => {
    expect((flags.parse({ you: "x" }) as { you?: unknown }).you).toBeUndefined();
    expect(flags.safeParse({ oddFlag: "x" }).success).toBe(false);
    expect((flags.parse({ oddFlag: true }) as { oddFlag?: unknown }).oddFlag).toBe(true);
  });
  it("on a real session view: an unreadable lastRunFailed shows the failure, an unreadable mayMerge grants nothing", () => {
    const read = SessionViewReaderSchema.parse(codeSessionView({ top: { lastRunFailed: { why: "new" } }, you: { mayMerge: { by: "rule" } } }));
    expect((read as { lastRunFailed?: unknown }).lastRunFailed).toBe(true);
    expect(read.you.mayMerge).toBeUndefined();
  });
});

// Every `true`-only flag at every path of every `*ReaderSchema` the contracts export, with how it reads (Opus S3). A new path, or a listed key at a new path, fails the test above until it is added here with a decision.
const PINNED_FLAG_PATHS: Record<string, string> = {
  "AgentDiffResponseReaderSchema.comparison.after.chain[].process": "display",
  "AgentDiffResponseReaderSchema.comparison.before.chain[].process": "display",
  "AgentDraftResponseReaderSchema.base.chain[].process": "display",
  "AgentDraftResponseReaderSchema.resolved.chain[].process": "display",
  "AgentProfileResponseReaderSchema.current.recipe.chain[].process": "display",
  "ChangesFeedPageReaderSchema.reset": "strict",
  "DeveloperTaskViewReaderSchema.evidence.checks[].tests.names[].unlisted": "warning",
  "DeveloperTaskViewReaderSchema.workflow.branchSync.approved": "grant",
  "DeveloperTaskViewReaderSchema.workflow.critique.notRevised": "warning",
  "DeveloperTaskViewReaderSchema.workflow.critique.sameModelAsPlanner": "warning",
  "DeveloperTaskViewReaderSchema.workflow.designReview.fromQuick": "strict",
  "DeveloperTaskViewReaderSchema.workflow.reviews[].partialDiff": "warning",
  "DeveloperTaskViewReaderSchema.workflow.verification.results[].broken": "warning",
  "DeveloperTaskViewReaderSchema.workflow.verification.results[].madeByRovara": "warning",
  "DeveloperTaskViewReaderSchema.workflow.verification.results[].neverStarted": "warning",
  "DeveloperTaskViewReaderSchema.workflow.verification.results[].programNotFound": "warning",
  "EvidenceViewReaderSchema.checks[].tests.names[].unlisted": "warning",
  "GithubChooseResponseReaderSchema.trialUsed": "warning",
  "GithubConnectResultReaderSchema.trialUsed": "warning",
  "LessonHistoryReaderSchema.versions[].approvedBy[].you": "display",
  "LessonSourcesReaderSchema.sources[].notesOptIn": "warning",
  "LessonsViewReaderSchema.active[].approvals[].by.you": "display",
  "LessonsViewReaderSchema.active[].from[].you": "display",
  "LessonsViewReaderSchema.active[].needs.first.you": "display",
  "LessonsViewReaderSchema.active[].retireProposed": "warning",
  "LessonsViewReaderSchema.active[].reviewRequired": "warning",
  "LessonsViewReaderSchema.removed[].approvals[].by.you": "display",
  "LessonsViewReaderSchema.removed[].from[].you": "display",
  "LessonsViewReaderSchema.removed[].needs.first.you": "display",
  "LessonsViewReaderSchema.removed[].retireProposed": "warning",
  "LessonsViewReaderSchema.removed[].reviewRequired": "warning",
  "LessonsViewReaderSchema.waiting[].approvals[].by.you": "display",
  "LessonsViewReaderSchema.waiting[].from[].you": "display",
  "LessonsViewReaderSchema.waiting[].needs.first.you": "display",
  "LessonsViewReaderSchema.waiting[].retireProposed": "warning",
  "LessonsViewReaderSchema.waiting[].reviewRequired": "warning",
  "LiveResponseReaderSchema.tiles[].lastRunFailed": "warning",
  "LiveTileReaderSchema.lastRunFailed": "warning",
  "LoadedKnowledgeResponseReaderSchema.stages[].manifest.items[].locked": "strict",
  "LoadedKnowledgeResponseReaderSchema.stages[].manifest.recordTruncated": "strict",
  "ProjectOverviewReaderSchema.running[].lastRunFailed": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.evidence.checks[].tests.names[].unlisted": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.branchSync.approved": "grant",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.critique.notRevised": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.critique.sameModelAsPlanner": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.designReview.fromQuick": "strict",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.reviews[].partialDiff": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.verification.results[].broken": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.verification.results[].madeByRovara": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.verification.results[].neverStarted": "warning",
  "SessionCloseResponseReaderSchema.session.body.task.workflow.verification.results[].programNotFound": "warning",
  "SessionCloseResponseReaderSchema.session.lastRunFailed": "warning",
  "SessionCloseResponseReaderSchema.session.you.coOwner": "grant",
  "SessionCloseResponseReaderSchema.session.you.live.ask": "grant",
  "SessionCloseResponseReaderSchema.session.you.live.fix": "grant",
  "SessionCloseResponseReaderSchema.session.you.mayMerge": "grant",
  "SessionListReaderSchema.sessions[].summary.lastRunFailed": "warning",
  "SessionListReaderSchema.sessions[].summary.offline": "warning",
  "SessionListReaderSchema.sessions[].summary.workflowBlocked": "warning",
  "SessionResponseReaderSchema.session.body.task.evidence.checks[].tests.names[].unlisted": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.branchSync.approved": "grant",
  "SessionResponseReaderSchema.session.body.task.workflow.critique.notRevised": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.critique.sameModelAsPlanner": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.designReview.fromQuick": "strict",
  "SessionResponseReaderSchema.session.body.task.workflow.reviews[].partialDiff": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.verification.results[].broken": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.verification.results[].madeByRovara": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.verification.results[].neverStarted": "warning",
  "SessionResponseReaderSchema.session.body.task.workflow.verification.results[].programNotFound": "warning",
  "SessionResponseReaderSchema.session.lastRunFailed": "warning",
  "SessionResponseReaderSchema.session.you.coOwner": "grant",
  "SessionResponseReaderSchema.session.you.live.ask": "grant",
  "SessionResponseReaderSchema.session.you.live.fix": "grant",
  "SessionResponseReaderSchema.session.you.mayMerge": "grant",
  "SessionStepTaskResponseReaderSchema.task.evidence.checks[].tests.names[].unlisted": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.branchSync.approved": "grant",
  "SessionStepTaskResponseReaderSchema.task.workflow.critique.notRevised": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.critique.sameModelAsPlanner": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.designReview.fromQuick": "strict",
  "SessionStepTaskResponseReaderSchema.task.workflow.reviews[].partialDiff": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.verification.results[].broken": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.verification.results[].madeByRovara": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.verification.results[].neverStarted": "warning",
  "SessionStepTaskResponseReaderSchema.task.workflow.verification.results[].programNotFound": "warning",
  "SessionTileReaderSchema.summary.lastRunFailed": "warning",
  "SessionTileReaderSchema.summary.offline": "warning",
  "SessionTileReaderSchema.summary.workflowBlocked": "warning",
  "SessionViewReaderSchema.body.task.evidence.checks[].tests.names[].unlisted": "warning",
  "SessionViewReaderSchema.body.task.workflow.branchSync.approved": "grant",
  "SessionViewReaderSchema.body.task.workflow.critique.notRevised": "warning",
  "SessionViewReaderSchema.body.task.workflow.critique.sameModelAsPlanner": "warning",
  "SessionViewReaderSchema.body.task.workflow.designReview.fromQuick": "strict",
  "SessionViewReaderSchema.body.task.workflow.reviews[].partialDiff": "warning",
  "SessionViewReaderSchema.body.task.workflow.verification.results[].broken": "warning",
  "SessionViewReaderSchema.body.task.workflow.verification.results[].madeByRovara": "warning",
  "SessionViewReaderSchema.body.task.workflow.verification.results[].neverStarted": "warning",
  "SessionViewReaderSchema.body.task.workflow.verification.results[].programNotFound": "warning",
  "SessionViewReaderSchema.lastRunFailed": "warning",
  "SessionViewReaderSchema.you.coOwner": "grant",
  "SessionViewReaderSchema.you.live.ask": "grant",
  "SessionViewReaderSchema.you.live.fix": "grant",
  "SessionViewReaderSchema.you.mayMerge": "grant",
  "SlackChannelsResponseReaderSchema.channels[].linked": "warning",
  "SourceOptionsViewReaderSchema.truncated": "warning",
  "SourcesAdminViewReaderSchema.notesSwitch": "grant",
  "SourcesAdminViewReaderSchema.sources[].notesOptIn": "warning",
  "StageModelsResponseReaderSchema.stages[].effective.noOtherCompany": "warning",
  "StageModelsResponseReaderSchema.stages[].effective.otherCompanyFailed": "warning",
  "TaskResponseReaderSchema.task.evidence.checks[].tests.names[].unlisted": "warning",
  "TaskResponseReaderSchema.task.workflow.branchSync.approved": "grant",
  "TaskResponseReaderSchema.task.workflow.critique.notRevised": "warning",
  "TaskResponseReaderSchema.task.workflow.critique.sameModelAsPlanner": "warning",
  "TaskResponseReaderSchema.task.workflow.designReview.fromQuick": "strict",
  "TaskResponseReaderSchema.task.workflow.reviews[].partialDiff": "warning",
  "TaskResponseReaderSchema.task.workflow.verification.results[].broken": "warning",
  "TaskResponseReaderSchema.task.workflow.verification.results[].madeByRovara": "warning",
  "TaskResponseReaderSchema.task.workflow.verification.results[].neverStarted": "warning",
  "TaskResponseReaderSchema.task.workflow.verification.results[].programNotFound": "warning"
};

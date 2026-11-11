// Plan 4 Task 1: chain designs, step results, run statuses, the ids and limits, the error codes and the org-scoped keys.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- the tests break a plain JSON design at a path, which a typed design would not allow */
import { describe, expect, it } from "vitest";
import { newPrefixedId } from "@rovara-code/contracts";
import { ChainIdSchema, ChainRunIdSchema, ChainRunStatusSchema, StepAttemptStatusSchema, TriggerIdSchema } from "@rovara-code/contracts";
import { ApproverRuleSchema, BranchIdSchema, CHAIN_MAX_BRANCHES, CHAIN_MAX_STEPS, CHAIN_MAX_TRAVERSALS, ChainDefinitionSchema, ChainRunStartedBySchema, ChainStepIdSchema, EdgeSchema, GATE_MAX_TIMEOUT_HOURS, HANDOFF_MAX_ITEMS, NextSchema, PinnedChainDefinitionSchema, REPORT_MAX_BYTES, STEP_INSTRUCTIONS_MAX_BYTES, STEP_LINKS_MAX, StepResultSchema, StepTargetSchema } from "@rovara-code/contracts";
import { AgentXErrorCodeSchema, agentXError, errorStatus } from "@rovara-code/contracts";
import { CHAIN_REVISION_CONFLICT_MESSAGE, CHAIN_RUN_CLOSED_MESSAGE, chainArchivedMessage, chainBudgetExceededMessage, chainBudgetRequiredMessage, chainStepUnavailableMessage } from "@rovara-code/contracts";
import * as contracts from "@rovara-code/contracts";
import { type OrgId } from "@rovara-code/contracts";
import { orgScoped } from "@rovara-code/contracts";
import { chainDirectoryKey, chainKey, chainNameKey, chainRunKey, chainRunsByChainKey, chainRunsByProjectKey, chainVersionSk, openChainRunKey, runEventSk, stepSk } from "@rovara-code/contracts";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const DEV = "a".repeat(64);
const DEV_2 = "b".repeat(64);
const RUN_ID = `crn_${"a".repeat(20)}`;
const CHAIN_ID = `chn_${"b".repeat(20)}`;
const TRIGGER_ID = `ctr_${"c".repeat(20)}`;

/** A deep copy of the worked example, ready to be broken. */
function design(): any {
  return JSON.parse(JSON.stringify(INVESTIGATE_THEN_FIX));
}

/** The paths of the issues a parse reports, joined with "/". */
function paths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; code: string; keys?: string[] }> } }): string[] {
  if (result.success) return [];
  return result.error!.issues.map((issue) => [...issue.path, ...(issue.code === "unrecognized_keys" ? issue.keys! : [])].join("/"));
}

describe("a chain design", () => {
  it("accepts the investigate-then-fix example", () => {
    const parsed = ChainDefinitionSchema.parse(INVESTIGATE_THEN_FIX);
    expect(parsed.start).toBe("investigate");
    expect(parsed.steps.map((step) => step.id)).toEqual(["investigate", "approve_fix", "fix", "review"]);
    expect(parsed.limits).toEqual({ maxRunUsd: 30 });
  });

  it("refuses an unknown field at every level and names the path", () => {
    const cases: Array<[string, (d: any) => void]> = [
      ["tools", (d) => { d.steps[0].tools = ["bash"]; }],
      ["systemPrompt", (d) => { d.systemPrompt = "x"; }],
      ["limits/maxTokens", (d) => { d.limits.maxTokens = 1; }],
      ["steps/0/agent/model", (d) => { d.steps[0].agent.model = "x"; }],
      ["steps/0/next/script", (d) => { d.steps[0].next.script = "x"; }],
      ["steps/0/next/choices/0/prompt", (d) => { d.steps[0].next.choices[0].prompt = "x"; }],
      ["steps/1/approvers/0/developerId", (d) => { d.steps[1].approvers[0].developerId = DEV; }],
      ["steps/1/onApprove/maxRounds", (d) => { d.steps[1].onApprove.maxRounds = 2; }],
      ["steps/1/onReject/note", (d) => { d.steps[1].onReject.note = "x"; }],
      ["steps/1/model", (d) => { d.steps[1].model = "x"; }],
      ["steps/2/next/extra", (d) => { d.steps[2].next.extra = 1; }],
      ["steps/3/next/to", (d) => { d.steps[3].next.to = "fix"; }],
    ];
    for (const [expected, mutate] of cases) {
      const broken = design();
      mutate(broken);
      const result = ChainDefinitionSchema.safeParse(broken);
      expect(result.success, expected).toBe(false);
      const found = paths(result);
      // the unknown key is named at its own path ("steps/0/tools" for a step; the leaf for the rest)
      expect(found.some((path) => path.endsWith(expected)), `${expected} in ${found.join(", ")}`).toBe(true);
    }
  });

  it("refuses a step named $end, a repeated id, and a step id that is not a step id", () => {
    const named = design();
    named.steps[2].id = "$end";
    expect(ChainDefinitionSchema.safeParse(named).success).toBe(false);

    const repeated = design();
    repeated.steps[2].id = "investigate";
    const result = ChainDefinitionSchema.safeParse(repeated);
    expect(result.success).toBe(false);
    expect(result.error!.issues.some((issue) => issue.message.includes("investigate") && issue.path.join("/") === "steps/2/id")).toBe(true);

    for (const bad of ["Fix", "1fix", "fix-it", "", "a".repeat(25), "fix it"]) {
      expect(ChainStepIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(ChainStepIdSchema.safeParse("a".repeat(24)).success).toBe(true);
    expect(StepTargetSchema.safeParse("$end").success).toBe(true);
    expect(StepTargetSchema.safeParse("$start").success).toBe(false);
  });

  it("refuses a repeated id even when the repeat is a different kind of step", () => {
    const repeated = design();
    repeated.steps[1].id = "fix";
    expect(ChainDefinitionSchema.safeParse(repeated).success).toBe(false);
  });

  it("takes a branch of two to six choices and refuses one choice and seven", () => {
    const withChoices = (count: number) => {
      const d = design();
      d.steps[0].next.choices = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, description: `Choice ${i}`, to: "$end" }));
      d.steps[0].next.default = "c0";
      return d;
    };
    expect(CHAIN_MAX_BRANCHES).toBe(6);
    expect(ChainDefinitionSchema.safeParse(withChoices(1)).success).toBe(false);
    expect(ChainDefinitionSchema.safeParse(withChoices(2)).success).toBe(true);
    expect(ChainDefinitionSchema.safeParse(withChoices(6)).success).toBe(true);
    const seven = ChainDefinitionSchema.safeParse(withChoices(7));
    expect(seven.success).toBe(false);
    expect(paths(seven).some((path) => path.startsWith("steps/0/next/choices"))).toBe(true);
  });

  it("bounds a branch choice: its id, its description and its default", () => {
    const d = design();
    d.steps[0].next.choices[0].description = "";
    expect(ChainDefinitionSchema.safeParse(d).success).toBe(false);
    d.steps[0].next.choices[0].description = "x".repeat(201);
    expect(ChainDefinitionSchema.safeParse(d).success).toBe(false);
    d.steps[0].next.choices[0].description = "x".repeat(200);
    expect(ChainDefinitionSchema.safeParse(d).success).toBe(true);
    d.steps[0].next.choices[0].id = "Fix!";
    expect(ChainDefinitionSchema.safeParse(d).success).toBe(false);
    d.steps[0].next.choices[0].id = "fix";
    d.steps[0].next.default = "$end";
    expect(ChainDefinitionSchema.safeParse(d).success).toBe(false);
    delete d.steps[0].next.default;
    expect(ChainDefinitionSchema.safeParse(d).success).toBe(true);
  });

  it("allows a traversal bound of 1 to 5 on every kind of edge and refuses 6, 0 and a fraction", () => {
    expect(CHAIN_MAX_TRAVERSALS).toBe(5);
    const places: Array<(d: any, value: unknown) => void> = [
      (d, value) => { d.steps[2].next = { kind: "go", to: "review", maxTraversals: value }; },
      (d, value) => { d.steps[0].next.choices[0].maxTraversals = value; },
      (d, value) => { d.steps[1].onApprove.maxTraversals = value; },
      (d, value) => { d.steps[1].onReject.maxTraversals = value; },
    ];
    for (const place of places) {
      for (const [value, ok] of [[5, true], [1, true], [6, false], [0, false], [2.5, false], ["3", false]] as const) {
        const d = design();
        place(d, value);
        expect(ChainDefinitionSchema.safeParse(d).success, `${String(value)}`).toBe(ok);
      }
    }
    expect(EdgeSchema.safeParse({ to: "fix", maxTraversals: 6 }).success).toBe(false);
    expect(EdgeSchema.safeParse({ to: "fix", maxTraversals: 5 }).success).toBe(true);
    expect(NextSchema.safeParse({ kind: "go", to: "fix", maxTraversals: 6 }).success).toBe(false);
    expect(NextSchema.safeParse({ kind: "go", to: "fix", maxTraversals: 5 }).success).toBe(true);
  });

  it("bounds the number of steps", () => {
    expect(CHAIN_MAX_STEPS).toBe(20);
    const many = (count: number) => {
      const d = design();
      d.start = "s0";
      d.steps = Array.from({ length: count }, (_, i) => ({ kind: "agent", id: `s${i}`, name: `Step ${i}`, agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } }));
      return d;
    };
    expect(ChainDefinitionSchema.safeParse(many(20)).success).toBe(true);
    expect(ChainDefinitionSchema.safeParse(many(21)).success).toBe(false);
    expect(ChainDefinitionSchema.safeParse(many(0)).success).toBe(false);
  });

  it("bounds an agent step", () => {
    const step = (patch: Record<string, unknown>) => {
      const d = design();
      Object.assign(d.steps[2], patch);
      return ChainDefinitionSchema.safeParse(d).success;
    };
    expect(step({ name: "" })).toBe(false);
    expect(step({ name: "x".repeat(41) })).toBe(false);
    expect(step({ name: "x".repeat(40) })).toBe(true);
    expect(step({ name: "   " })).toBe(false);
    expect(STEP_INSTRUCTIONS_MAX_BYTES).toBe(4096);
    expect(step({ instructions: "x".repeat(4096) })).toBe(true);
    expect(step({ instructions: "x".repeat(4097) })).toBe(false);
    // 1,366 three-byte characters are 4,098 bytes but only 1,366 UTF-16 units
    expect(step({ instructions: "€".repeat(1365) })).toBe(true);
    expect(step({ instructions: "€".repeat(1366) })).toBe(false);
    expect(step({ handoff: "previous" })).toBe(true);
    expect(step({ handoff: "all" })).toBe(true);
    expect(step({ handoff: "everything" })).toBe(false);
    expect(step({ timeoutMinutes: 5 })).toBe(true);
    expect(step({ timeoutMinutes: 1440 })).toBe(true);
    expect(step({ timeoutMinutes: 4 })).toBe(false);
    expect(step({ timeoutMinutes: 1441 })).toBe(false);
    expect(step({ timeoutMinutes: 10.5 })).toBe(false);
    expect(step({ retries: 0 })).toBe(true);
    expect(step({ retries: 2 })).toBe(true);
    expect(step({ retries: 3 })).toBe(false);
    expect(step({ retries: -1 })).toBe(false);
    expect(step({ agent: { agentId: "rovara-code", version: 3 } })).toBe(true);
    expect(step({ agent: { agentId: `agt_${"a".repeat(20)}`, version: "current" } })).toBe(true);
    expect(step({ agent: { agentId: "rovara-code", version: 0 } })).toBe(false);
    expect(step({ agent: { agentId: "rovara-code", version: "latest" } })).toBe(false);
    expect(step({ agent: { agentId: "no-such-agent", version: 1 } })).toBe(false);
    expect(step({ next: undefined })).toBe(false);
  });

  it("refuses line and paragraph separators, private-use and unassigned characters in one-line text and in instructions", () => {
    const edit = (index: number, patch: Record<string, unknown>) => {
      const d = design();
      Object.assign(d.steps[index], patch);
      return ChainDefinitionSchema.safeParse(d).success;
    };
    // U+2028 and U+2029 break a line in many renderers; U+E000 is private use; U+0378 is unassigned.
    for (const bad of ["a\u2028b", "a\u2029b", "a\ue000b", "a\u0378b"]) {
      expect(edit(2, { name: bad }), `agent name ${JSON.stringify(bad)}`).toBe(false);
      expect(edit(1, { name: bad }), `gate name ${JSON.stringify(bad)}`).toBe(false);
      expect(edit(1, { prompt: bad }), `gate prompt ${JSON.stringify(bad)}`).toBe(false);
      expect(edit(2, { instructions: bad }), `instructions ${JSON.stringify(bad)}`).toBe(false);
    }
    const choice = design();
    choice.steps[0].next.choices[0].description = "a\u2028b";
    expect(ChainDefinitionSchema.safeParse(choice).success).toBe(false);
    expect(StepResultSchema.safeParse({ report: "r", links: [{ label: "a\u2028b", url: "https://example.com/x" }] }).success).toBe(false);
    // Ordinary text, accents, CJK and emoji still pass, and so do line breaks and tabs in instructions.
    expect(edit(2, { name: "Chercher la cause \u00e9tape \u4e2d\u6587 \u{1F600}" })).toBe(true);
    expect(edit(2, { instructions: "One.\r\nTwo.\n\tThree \u00e9 \u4e2d" })).toBe(true);
  });

  it("refuses control and invisible characters in what a person reads, and allows line breaks only in instructions", () => {
    const edit = (index: number, patch: Record<string, unknown>) => {
      const d = design();
      Object.assign(d.steps[index], patch);
      return ChainDefinitionSchema.safeParse(d).success;
    };
    for (const bad of ["a\nb", "a\u0000b", "a\u200bb", "a\u202eb", "a\u0085b", "a\tb"]) {
      expect(edit(2, { name: bad }), `agent name ${JSON.stringify(bad)}`).toBe(false);
      expect(edit(1, { name: bad }), `gate name ${JSON.stringify(bad)}`).toBe(false);
      expect(edit(1, { prompt: bad }), `gate prompt ${JSON.stringify(bad)}`).toBe(false);
    }
    const choice = design();
    choice.steps[0].next.choices[0].description = "a\u202eb";
    expect(ChainDefinitionSchema.safeParse(choice).success).toBe(false);
    expect(edit(2, { instructions: "Line one.\nLine two.\n\tIndented." })).toBe(true);
    expect(edit(2, { instructions: "a\u0000b" })).toBe(false);
    expect(edit(2, { instructions: "a\u202eb" })).toBe(false);
    expect(edit(2, { instructions: "a\u200bb" })).toBe(false);
    expect(StepResultSchema.safeParse({ report: "r", links: [{ label: "a\u202eb", url: "https://example.com/x" }] }).success).toBe(false);
    expect(StepResultSchema.safeParse({ report: "line\nbreak\u0000 and bytes are the agent's own" }).success).toBe(true);
    expect(StepResultSchema.safeParse({ report: "r", links: [{ label: "a", url: "https://example.com/a b" }] }).success).toBe(false);
    expect(StepResultSchema.safeParse({ report: "r", links: [{ label: "a", url: "https://example.com/\u200b" }] }).success).toBe(false);
    // the limits count characters people see, not UTF-16 units: 40 emoji fit, 41 do not
    expect(edit(2, { name: "😀".repeat(40) })).toBe(true);
    expect(edit(2, { name: "😀".repeat(41) })).toBe(false);
  });

  it("bounds a gate", () => {
    const gate = (patch: Record<string, unknown>) => {
      const d = design();
      Object.assign(d.steps[1], patch);
      return ChainDefinitionSchema.safeParse(d).success;
    };
    expect(gate({ prompt: "" })).toBe(false);
    expect(gate({ prompt: "x".repeat(300) })).toBe(true);
    expect(gate({ prompt: "x".repeat(301) })).toBe(false);
    expect(gate({ approvers: [] })).toBe(false);
    expect(gate({ approvers: [{ kind: "starter" }, { kind: "project_maintainers" }, { kind: "chain_owner" }] })).toBe(true);
    expect(gate({ approvers: [{ kind: "starter" }, { kind: "project_maintainers" }, { kind: "chain_owner" }, { kind: "members", developerIds: [DEV] }] })).toBe(false);
    expect(GATE_MAX_TIMEOUT_HOURS).toBe(336);
    expect(gate({ timeoutHours: 1 })).toBe(true);
    expect(gate({ timeoutHours: 336 })).toBe(true);
    expect(gate({ timeoutHours: 0 })).toBe(false);
    expect(gate({ timeoutHours: 337 })).toBe(false);
    expect(gate({ onApprove: undefined })).toBe(false);
    expect(gate({ name: "x".repeat(41) })).toBe(false);
  });

  it("sends a gate's rejection to $end when the design says nothing", () => {
    const d = design();
    delete d.steps[1].onReject;
    const parsed = ChainDefinitionSchema.parse(d);
    const gate = parsed.steps[1]!;
    expect(gate.kind === "gate" && gate.onReject).toEqual({ to: "$end" });
  });

  it("checks the people a gate names", () => {
    expect(ApproverRuleSchema.safeParse({ kind: "members", developerIds: [DEV, DEV_2] }).success).toBe(true);
    expect(ApproverRuleSchema.safeParse({ kind: "members", developerIds: [] }).success).toBe(false);
    expect(ApproverRuleSchema.safeParse({ kind: "members", developerIds: [DEV, DEV] }).success).toBe(false);
    expect(ApproverRuleSchema.safeParse({ kind: "members", developerIds: ["not-an-id"] }).success).toBe(false);
    expect(ApproverRuleSchema.safeParse({ kind: "members", developerIds: Array.from({ length: 10 }, (_, i) => i.toString(16).repeat(64).slice(0, 64)) }).success).toBe(true);
    expect(ApproverRuleSchema.safeParse({ kind: "members", developerIds: Array.from({ length: 11 }, (_, i) => i.toString(16).repeat(64).slice(0, 64)) }).success).toBe(false);
    expect(ApproverRuleSchema.safeParse({ kind: "anyone" }).success).toBe(false);
    for (const kind of ["starter", "project_maintainers", "chain_owner"]) expect(ApproverRuleSchema.safeParse({ kind }).success).toBe(true);
  });

  it("bounds the run limits", () => {
    const limits = (value: unknown) => {
      const d = design();
      d.limits = value;
      return ChainDefinitionSchema.safeParse(d).success;
    };
    expect(limits({ maxRunUsd: 0.5 })).toBe(true);
    expect(limits({ maxRunUsd: 0.49 })).toBe(false);
    expect(limits({ maxRunUsd: 1000 })).toBe(true);
    expect(limits({ maxRunUsd: 1000.01 })).toBe(false);
    expect(limits({ maxRunUsd: Number.NaN })).toBe(false);
    expect(limits({ maxRunHours: 1 })).toBe(true);
    expect(limits({ maxRunHours: 168 })).toBe(true);
    expect(limits({ maxRunHours: 0 })).toBe(false);
    expect(limits({ maxRunHours: 169 })).toBe(false);
    expect(limits({})).toBe(true);
    expect(limits(undefined)).toBe(true);
  });

  it("pins every agent version in a published design", () => {
    expect(PinnedChainDefinitionSchema.safeParse(INVESTIGATE_THEN_FIX).success).toBe(false);
    const pinned = design();
    for (const step of pinned.steps) if (step.kind === "agent") step.agent.version = 4;
    expect(PinnedChainDefinitionSchema.parse(pinned).steps).toHaveLength(4);
    expect(ChainDefinitionSchema.safeParse(pinned).success).toBe(true);
    // one still on "current" is refused, and the issue names it
    pinned.steps[3].agent.version = "current";
    const result = PinnedChainDefinitionSchema.safeParse(pinned);
    expect(result.success).toBe(false);
    expect(paths(result)).toContain("steps/3/agent/version");
    pinned.steps[3].agent.version = 0;
    expect(PinnedChainDefinitionSchema.safeParse(pinned).success).toBe(false);
    pinned.steps[3].agent.version = 1.5;
    expect(PinnedChainDefinitionSchema.safeParse(pinned).success).toBe(false);
  });
});

describe("a step's result", () => {
  it("takes a report of exactly 32,768 bytes and refuses 32,769", () => {
    expect(REPORT_MAX_BYTES).toBe(32768);
    expect(StepResultSchema.safeParse({ report: "x".repeat(32768) }).success).toBe(true);
    expect(StepResultSchema.safeParse({ report: "x".repeat(32769) }).success).toBe(false);
    // bytes, not UTF-16 units: 10,923 three-byte characters are 32,769 bytes
    expect(StepResultSchema.safeParse({ report: "€".repeat(10922) }).success).toBe(true);
    expect(StepResultSchema.safeParse({ report: "€".repeat(10923) }).success).toBe(false);
    expect(StepResultSchema.safeParse({ report: "" }).success).toBe(true);
    expect(StepResultSchema.safeParse({}).success).toBe(false);
  });

  it("takes https links only, with a label of at most 80 characters, and at most 20 of them", () => {
    const withLink = (link: unknown) => StepResultSchema.safeParse({ report: "r", links: [link] }).success;
    expect(withLink({ label: "PR", url: "https://github.com/acme/web/pull/7" })).toBe(true);
    expect(withLink({ label: "PR", url: "http://github.com/acme/web/pull/7" })).toBe(false);
    expect(withLink({ label: "PR", url: "javascript:alert(1)" })).toBe(false);
    expect(withLink({ label: "PR", url: "ftp://example.com/x" })).toBe(false);
    expect(withLink({ label: "PR", url: "not a url" })).toBe(false);
    expect(withLink({ label: "PR", url: "https://user:secret@example.com/x" })).toBe(false);
    expect(withLink({ label: "", url: "https://example.com/x" })).toBe(false);
    expect(withLink({ label: "x".repeat(80), url: "https://example.com/x" })).toBe(true);
    expect(withLink({ label: "x".repeat(81), url: "https://example.com/x" })).toBe(false);
    expect(withLink({ label: "PR", url: "https://example.com/x", note: "x" })).toBe(false);
    const links = (count: number) => Array.from({ length: count }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
    expect(STEP_LINKS_MAX).toBe(20);
    expect(StepResultSchema.safeParse({ report: "r", links: links(20) }).success).toBe(true);
    expect(StepResultSchema.safeParse({ report: "r", links: links(21) }).success).toBe(false);
  });

  it("refuses a field the runner does not build, such as approved", () => {
    const result = StepResultSchema.safeParse({ report: "r", approved: true });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain("approved");
    expect(StepResultSchema.safeParse({ report: "r", branch: "fix" }).success).toBe(true);
    expect(StepResultSchema.safeParse({ report: "r", branch: "Fix It" }).success).toBe(false);
    expect(StepResultSchema.safeParse({ report: "r", branch: "$end" }).success).toBe(false);
  });
});

describe("a chain run", () => {
  it("has the statuses the plan lists, and an attempt may also be starting", () => {
    expect(ChainRunStatusSchema.options).toEqual(["running", "waiting", "paused", "succeeded", "failed", "cancelled", "timed_out"]);
    expect(StepAttemptStatusSchema.options).toEqual([...ChainRunStatusSchema.options, "starting"]);
    expect(ChainRunStatusSchema.safeParse("starting").success).toBe(false);
  });

  it("records who started it: a member, an event or a schedule", () => {
    expect(ChainRunStartedBySchema.safeParse({ kind: "member", developerId: DEV }).success).toBe(true);
    expect(ChainRunStartedBySchema.safeParse({ kind: "member", developerId: "dev" }).success).toBe(false);
    const event = { kind: "event", triggerId: TRIGGER_ID, eventKey: "sentry:issue:42", source: "sentry", type: "issue.created", title: "TypeError in checkout" };
    expect(ChainRunStartedBySchema.parse(event)).toEqual(event);
    expect(ChainRunStartedBySchema.safeParse({ ...event, url: "https://sentry.io/issues/42" }).success).toBe(true);
    expect(ChainRunStartedBySchema.safeParse({ ...event, title: "t".repeat(300) }).success).toBe(true);
    expect(ChainRunStartedBySchema.safeParse({ ...event, title: "t".repeat(301) }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, title: "bad\u202etitle" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, title: "" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, url: "http://sentry.io/issues/42" }).success).toBe(false);
    // the key is kept exactly (a run's identity hashes it), so a key with a space at its end is neither trimmed nor refused
    expect(ChainRunStartedBySchema.parse({ ...event, eventKey: " k " })).toMatchObject({ eventKey: " k " });
    expect(ChainRunStartedBySchema.safeParse({ ...event, eventKey: "k".repeat(200) }).success).toBe(true);
    expect(ChainRunStartedBySchema.safeParse({ ...event, eventKey: "k".repeat(201) }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, eventKey: "" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, eventKey: "a\nb" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, source: "Sentry" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, type: "issue created" }).success).toBe(false);
    for (const type of ["pull_request.opened", "deployment_status.success", "alarm.fired"]) expect(ChainRunStartedBySchema.safeParse({ ...event, type }).success, type).toBe(true);
    expect(ChainRunStartedBySchema.safeParse({ ...event, triggerId: "trigger" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ ...event, extra: 1 }).success).toBe(false);
    const { eventKey: _eventKey, ...withoutKey } = event; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    expect(ChainRunStartedBySchema.safeParse(withoutKey).success).toBe(false);
    const schedule = { kind: "schedule", triggerId: TRIGGER_ID, scheduledAt: "2026-10-22T09:00:00.000Z" };
    expect(ChainRunStartedBySchema.parse(schedule)).toEqual(schedule);
    expect(ChainRunStartedBySchema.safeParse({ ...schedule, scheduledAt: "tomorrow" }).success).toBe(false);
    expect(ChainRunStartedBySchema.safeParse({ kind: "api", developerId: DEV }).success).toBe(false);
  });
});

describe("ids and limits", () => {
  it("makes chain, run and trigger ids that match their schemas", () => {
    expect(newPrefixedId("crn")).toMatch(/^crn_[0-9a-z]{20}$/);
    expect(ChainRunIdSchema.safeParse(newPrefixedId("crn")).success).toBe(true);
    expect(ChainIdSchema.safeParse(newPrefixedId("chn")).success).toBe(true);
    expect(TriggerIdSchema.safeParse(newPrefixedId("ctr")).success).toBe(true);
    expect(newPrefixedId("chn", () => new Uint8Array(32))).toBe(`chn_${"0".repeat(20)}`);
  });

  it("keeps each kind of id apart", () => {
    expect(ChainRunIdSchema.safeParse(CHAIN_ID).success).toBe(false);
    expect(ChainIdSchema.safeParse(RUN_ID).success).toBe(false);
    expect(TriggerIdSchema.safeParse(RUN_ID).success).toBe(false);
    expect(ChainIdSchema.safeParse(newPrefixedId("agt")).success).toBe(false);
    for (const bad of [`crn_${"a".repeat(19)}`, `crn_${"a".repeat(21)}`, `crn_${"A".repeat(20)}`, `crn_${"a".repeat(19)}-`, ` ${RUN_ID}`, `${RUN_ID}\n`]) {
      expect(ChainRunIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    // a branch id is a step id: lower case, a letter first, at most 24 characters
    expect(BranchIdSchema.safeParse("no_fix").success).toBe(true);
    expect(BranchIdSchema.safeParse("$end").success).toBe(false);
  });

  it("uses Plan 3's size limits for what it hands to an agent", () => {
    expect(HANDOFF_MAX_ITEMS).toBe(10);
    expect(contracts.HANDOFF_ITEM_MAX_BYTES).toBe(16384);
    expect(contracts.HANDOFF_MAX_BYTES).toBe(65536);
    expect(contracts.CONTEXT_TITLE_MAX).toBe(200);
    expect(contracts.CHAIN_MAX_STEP_RUNS).toBe(30);
    expect(contracts.CHAIN_START_INPUT_MAX).toBe(8000);
    expect(contracts.GATE_DEFAULT_TIMEOUT_HOURS).toBe(72);
    expect(contracts.STEP_RETRIES_MAX).toBe(2);
    expect(contracts.STEP_DEFAULT_TIMEOUT_MINUTES).toBe(120);
    expect(contracts.CHAIN_RUN_MAX_HOURS).toBe(168);
    expect(contracts.CHAIN_MAX_CONCURRENT_RUNS).toBe(5);
    expect(contracts.DEFAULT_PERSON_CHAIN_RUN_LIMIT_USD).toBe(20);
  });

  it("is exported from the contracts package", () => {
    expect(contracts.ChainDefinitionSchema).toBe(ChainDefinitionSchema);
    expect(contracts.ChainRunIdSchema).toBe(ChainRunIdSchema);
    expect(contracts.chainRunKey).toBe(chainRunKey);
    expect(contracts.stepSk).toBe(stepSk);
  });
});

describe("chain error codes", () => {
  it("are known codes with the plan's statuses", () => {
    for (const code of ["CHAIN_REVISION_CONFLICT", "CHAIN_UNAVAILABLE", "CHAIN_BUDGET_REQUIRED", "CHAIN_BUDGET_EXCEEDED", "CHAIN_RUN_CLOSED"] as const) {
      expect(AgentXErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
    expect(errorStatus("CHAIN_BUDGET_EXCEEDED")).toBe(402);
    expect(errorStatus("CHAIN_RUN_CLOSED")).toBe(409);
    expect(errorStatus("CHAIN_REVISION_CONFLICT")).toBe(409);
    expect(errorStatus("CHAIN_UNAVAILABLE")).toBe(409);
    expect(errorStatus("CHAIN_BUDGET_REQUIRED")).toBe(409);
    expect(agentXError("CHAIN_BUDGET_EXCEEDED", "x").statusCode).toBe(402);
  });

  it("say exactly what the plan says", () => {
    expect(CHAIN_REVISION_CONFLICT_MESSAGE).toBe("Someone else changed this chain's draft. Reload it and make your change again.");
    expect(CHAIN_RUN_CLOSED_MESSAGE).toBe("This chain run has already ended.");
    expect(chainArchivedMessage("Fix flaky tests")).toBe("Fix flaky tests is archived, so it can't start new runs.");
    expect(chainStepUnavailableMessage("Fix flaky tests", "fix", "Rovara Code", 3, "it was archived")).toBe(
      "Fix flaky tests's step \"fix\" uses Rovara Code version 3, which can't run now: it was archived. Ask Fix flaky tests's owner to publish a new version.",
    );
    expect(chainBudgetRequiredMessage("Fix flaky tests")).toBe("Fix flaky tests has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both.");
    expect(chainBudgetExceededMessage("Fix flaky tests", 49.5, 50)).toBe("Fix flaky tests's monthly AI budget is used up ($49.50 of $50.00). Ask its owner for more.");
    expect(chainBudgetExceededMessage("c", 0.005, 1234.5)).toBe("c's monthly AI budget is used up ($0.01 of $1234.50). Ask its owner for more.");
  });

  it("leave the statuses of the codes around them alone", () => {
    expect(errorStatus("AGENT_BUDGET_EXCEEDED")).toBe(402);
    expect(errorStatus("APPROVAL_CLOSED")).toBe(409);
    expect(errorStatus("NOT_FOUND")).toBe(404);
  });
});

describe("chain keys", () => {
  it("puts a chain and its versions, shares and events in one org-scoped partition", () => {
    expect(chainKey(ORG_A, CHAIN_ID, "META")).toEqual({ pk: orgScoped(ORG_A, `CHAIN#${CHAIN_ID}`), sk: "META" });
    expect(chainKey(ORG_A, CHAIN_ID, "DRAFT").sk).toBe("DRAFT");
    expect(chainKey(ORG_A, CHAIN_ID, "SHARE#MEMBER#x").sk).toBe("SHARE#MEMBER#x");
    expect(chainKey(ORG_A, CHAIN_ID, "EVENT#000001").sk).toBe("EVENT#000001");
    expect(chainKey(ORG_A, CHAIN_ID, chainVersionSk(3))).toEqual({ pk: `ORG#${ORG_A}#CHAIN#${CHAIN_ID}`, sk: "VERSION#000003" });
    expect(chainKey(ORG_B, CHAIN_ID, "META").pk).not.toBe(chainKey(ORG_A, CHAIN_ID, "META").pk);
  });

  it("pads a version to six digits and refuses one it cannot hold", () => {
    expect(chainVersionSk(1)).toBe("VERSION#000001");
    expect(chainVersionSk(999999)).toBe("VERSION#999999");
    expect(chainVersionSk(12) < chainVersionSk(100)).toBe(true);
    for (const bad of [0, -1, 1.5, 1_000_000, Number.NaN]) expect(() => chainVersionSk(bad), String(bad)).toThrow();
  });

  it("lists chains by directory and makes a name unique ignoring case and surrounding spaces", () => {
    expect(chainDirectoryKey(ORG_A, CHAIN_ID)).toEqual({ pk: orgScoped(ORG_A, "CHAINS"), sk: CHAIN_ID });
    expect(chainNameKey(ORG_A, "  Investigate Then FIX ")).toEqual(chainNameKey(ORG_A, "investigate then fix"));
    expect(chainNameKey(ORG_A, "Investigate")).toEqual({ pk: orgScoped(ORG_A, "CHAIN_NAME#investigate"), sk: "META" });
    expect(chainNameKey(ORG_A, "x").pk).not.toBe(chainNameKey(ORG_B, "x").pk);
  });

  it("keeps a run's steps and events in the run's partition, in order", () => {
    expect(chainRunKey(ORG_A, RUN_ID, "META")).toEqual({ pk: `ORG#${ORG_A}#CHAIN_RUN#${RUN_ID}`, sk: "META" });
    expect(chainRunKey(ORG_A, RUN_ID, "META").pk.startsWith(orgScoped(ORG_A, ""))).toBe(true);
    expect(chainRunKey(ORG_A, RUN_ID, stepSk(2)).sk).toBe("STEP#0002");
    expect(chainRunKey(ORG_A, RUN_ID, runEventSk(2)).sk).toBe("EVENT#000002");
    expect(chainRunKey(ORG_B, RUN_ID, "META").pk).not.toBe(chainRunKey(ORG_A, RUN_ID, "META").pk);
    expect(stepSk(7)).toBe("STEP#0007");
    expect(stepSk(9999)).toBe("STEP#9999");
    expect(stepSk(9) < stepSk(10)).toBe(true);
    expect(runEventSk(999999)).toBe("EVENT#999999");
    expect(runEventSk(9) < runEventSk(10)).toBe(true);
    for (const bad of [-1, 1.5, 10_000, Number.NaN]) expect(() => stepSk(bad), String(bad)).toThrow();
    for (const bad of [-1, 1.5, 1_000_000, Number.NaN]) expect(() => runEventSk(bad), String(bad)).toThrow();
  });

  it("lists runs by chain and by project, newest last, with the instant in one form", () => {
    expect(chainRunsByChainKey(ORG_A, CHAIN_ID, "2026-10-22T09:00:00Z", RUN_ID)).toEqual({
      pk: orgScoped(ORG_A, `CHAIN_RUNS#${CHAIN_ID}`),
      sk: `2026-10-22T09:00:00.000Z#${RUN_ID}`,
    });
    expect(chainRunsByProjectKey(ORG_A, "web", "2026-10-22T09:00:00.5Z", RUN_ID)).toEqual({
      pk: orgScoped(ORG_A, "CHAIN_RUNS_P#web"),
      sk: `2026-10-22T09:00:00.500Z#${RUN_ID}`,
    });
    expect(chainRunsByProjectKey(ORG_A, "web", "2026-10-22T09:00:00Z", RUN_ID).pk).not.toBe(chainRunsByProjectKey(ORG_B, "web", "2026-10-22T09:00:00Z", RUN_ID).pk);
    expect(() => chainRunsByChainKey(ORG_A, CHAIN_ID, "yesterday", RUN_ID)).toThrow();
  });

  it("keeps the open-runs index global, with ids only", () => {
    const key = openChainRunKey("2026-10-22T09:00:00Z", ORG_A, RUN_ID);
    expect(key).toEqual({ pk: "OPEN_CHAIN_RUNS", sk: `2026-10-22T09:00:00.000Z#${ORG_A}#${RUN_ID}` });
    expect(Object.keys(key).sort()).toEqual(["pk", "sk"]);
    expect(openChainRunKey("2026-10-22T09:00:00Z", ORG_B, RUN_ID).sk).not.toBe(key.sk);
    expect(() => openChainRunKey("soon", ORG_A, RUN_ID)).toThrow();
  });
});

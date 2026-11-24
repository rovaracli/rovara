/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- the fixtures are Code's plain JSON answers */
// Second Code<->Cloud repair-card skew (REPAIR-CARD-SKEW2). Every answer in tests/fixtures/code-setup-repair/*.json was produced by Code's OWN functions (`setupRepairViewOf` for `GET setup-check`, `readRepairView` for the
// `repair` of `GET setup-agent`) run at the named Code ref (generator: generator.test.ts.txt). Each must be taken by Cloud's strict parsers, rebuilt correctly, and read by the browser's schema.
//   code-6c18670ec.json  staging Code 6c18670ec and prod Code 3842ce724 (these files are byte-identical in both)
//   code-7f334a6ef.json  code/next 7f334a6ef (Code train 22: the "Work continues" tail)
// Mutants (each killed by the named test): K1 `changed` cut back to 160 (the "long changed words" test: 8 or more classes at once is 175+ characters); K2 setup-check accepts edit_commands; K3 an action that does
// not fit the state accepted; K4 setup-agent repair forwarded unchecked; K5 an unknown id or a label that is not Code's accepted; K6 fix_ready count not tied to the text.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETUP_AGENT_REPAIR_ACTIONS, SETUP_REPAIR_ACTIONS, SETUP_REPAIR_CHANGED_MAX, setupAgentRepairView, setupRepairView } from "../../packages/cloud-server/src/setup-repair-routes.js";
import { Unreadable } from "../../packages/cloud-server/src/wiki-routes.js";
import { SetupRepairViewSchema } from "../../packages/contracts/src/app-setup-repair.js";

interface Answer { route: "setup-check" | "setup-agent"; scenario?: string; failedStep?: string; classes?: string[]; canManage?: boolean; fixReadyScenario?: boolean; status?: string; repair: any }
interface Fixture { codeRef: string; answers: Answer[] }
const load = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../fixtures/code-setup-repair/${name}.json`, import.meta.url), "utf8")) as Fixture;
const FIXTURES: Array<[string, Fixture]> = [["staging 6c18670ec / prod 3842ce724", load("code-6c18670ec")], ["code/next 7f334a6ef", load("code-7f334a6ef")]];
const OLD_TAIL = "Rovara cannot build on this project until it is fixed.";
const NEW_TAIL = "Work continues; results may be less reliable until setup is fixed.";
/** Code's own `inertSetupStep` of the failing step (what the card's sentence carries). */
const inert = (step: string): string => step.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/[@<>`[\]*_~#|!]/gu, "").replace(/:\/\//gu, ": ").replace(/\/\/+/gu, "/").replace(/\s+/gu, " ").trim().slice(0, 200);
/** The whole body Code's `GET setup-check` sends: the setup state, `canManage`, the card, and (7f334a6ef) `setupWarning`. */
const checkBody = (a: Answer, ref: string) => ({ status: a.status, checkedRevision: 1, checkedAt: "2026-11-17T09:00:00.000Z", failedStep: "x", canManage: a.canManage, ...(a.repair === undefined ? {} : { repair: a.repair }), ...(ref.startsWith("code/next") ? { setupWarning: "Setup needs repair: work continues; results may be less reliable until setup is fixed." } : {}) });

describe.each(FIXTURES)("Code %s: GET setup-check", (ref, fixture) => {
  const answers = fixture.answers.filter((a) => a.route === "setup-check");
  it("has the real answers to read (every step, class set, role and fix state)", () => {
    expect(answers.length).toBeGreaterThanOrEqual(60);
    expect(new Set(answers.map((a) => a.repair?.actions?.[0]?.id ?? "none"))).toEqual(new Set(["fix_setup", "approve_new_setup", "none"]));
    expect(answers.every((a) => a.repair?.body.endsWith(ref.startsWith("code/next") ? NEW_TAIL : OLD_TAIL))).toBe(true);
  });

  it("is taken by Cloud and rebuilt, and read by the browser's schema", () => {
    for (const a of answers) {
      const view = setupRepairView(checkBody(a, ref)) as any;
      const label = JSON.stringify([a.failedStep, a.classes, a.canManage, a.fixReadyScenario]);
      expect(view.state, label).toBe("failed");
      expect(view.canManage, label).toBe(a.canManage);
      expect(view.repair.step, label).toBe(inert(a.failedStep!));
      expect(view.repair.fixReady, label).toBe(a.fixReadyScenario);
      expect(view.repair.at, label).toBe(a.repair.at);
      if (a.repair.changed === undefined) expect(view.repair.changed, label).toBeUndefined(); else expect(view.repair.changed, label).toBe(a.repair.changed);
      // The action that fits the state (a fix waiting is approved, anything else is fixed), none for a person who may not act.
      const wanted = a.canManage === true ? [a.fixReadyScenario === true ? { id: "approve_new_setup", label: "Approve new setup" } : { id: "fix_setup", label: "Fix setup" }] : [];
      expect(view.repair.actions, label).toEqual(wanted);
      expect(() => SetupRepairViewSchema.parse(view), label).not.toThrow();
    }
  });

  it("takes long changed words: eight or more classes at once are 175 to 212 characters (K1)", () => {
    const long = answers.filter((a) => (a.repair?.changed ?? "").length > 160);
    expect(long.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...long.map((a) => a.repair.changed.length))).toBe(212);
    expect(212).toBeLessThanOrEqual(SETUP_REPAIR_CHANGED_MAX);
    for (const a of long) expect((setupRepairView(checkBody(a, ref)) as any).repair.changed).toBe(a.repair.changed);
  });

  it("uses only the ids and labels Cloud knows", () => {
    const seen = new Set(answers.flatMap((a) => (a.repair?.actions ?? []).map((x: any) => `${x.id}|${x.label}`)));
    expect(seen).toEqual(new Set(Object.entries(SETUP_REPAIR_ACTIONS).map(([id, label]) => `${id}|${label}`)));
  });
});

describe("what Code never sends on setup-check stays refused (strict otherwise)", () => {
  const card = () => ({ ...load("code-7f334a6ef").answers.find((a) => a.route === "setup-check" && a.canManage === true && a.fixReadyScenario === false)!.repair });
  const view = (repair: unknown) => setupRepairView({ status: "failed", canManage: true, repair });
  it("accepts the real card", () => { expect(() => view(card())).not.toThrow(); });
  it("refuses the card as `setupRepairCardOf` builds it for the chat (fix_setup labelled 'uses your AI' + edit_commands) (K2)", () => {
    expect(() => view({ ...card(), actions: [{ id: "fix_setup", label: "Fix setup (uses your AI)" }, { id: "edit_commands", label: "Edit commands myself" }] })).toThrow(Unreadable);
    expect(() => view({ ...card(), actions: [{ id: "edit_commands", label: "Edit commands myself" }] })).toThrow(Unreadable);
  });
  it("refuses approve_setup and see_changes here, an id with another id's label, and an action that does not fit the state (K3, K5)", () => {
    for (const actions of [[{ id: "approve_setup", label: "Approve new setup" }], [{ id: "see_changes", label: "See changes" }], [{ id: "fix_setup", label: "Approve new setup" }], [{ id: "approve_new_setup", label: "Fix setup" }], [{ id: "approve_new_setup", label: "Approve new setup" }]]) {
      expect(() => view({ ...card(), actions }), JSON.stringify(actions)).toThrow(Unreadable);
    }
  });
  it("refuses a changed text past the longest Code can say, and a sentence Code does not say", () => {
    expect(() => view({ ...card(), changed: "x".repeat(SETUP_REPAIR_CHANGED_MAX + 1) })).toThrow(Unreadable);
    expect(() => view({ ...card(), body: card().body.replace("Work continues", "Work goes on") })).toThrow(Unreadable);
    expect(() => view({ ...card(), state: "drafting" })).toThrow(Unreadable);
  });
});

describe.each(FIXTURES)("Code %s: the `repair` of GET setup-agent", (_ref, fixture) => {
  const answers = fixture.answers.filter((a) => a.route === "setup-agent");
  it("has every state Code's readRepairView gives", () => {
    expect(new Set(answers.map((a) => a.repair.state))).toEqual(new Set(["no_fix", "drafting", "fix_ready"]));
    expect(new Set(answers.flatMap((a) => a.repair.actions.map((x: any) => x.id)))).toEqual(new Set(["fix_setup", "edit_commands", "approve_setup", "see_changes"]));
    expect(answers.length).toBeGreaterThanOrEqual(13);
  });

  it("is taken by Cloud and rebuilt with Cloud's own labels (no dollar figure) (K4)", () => {
    for (const a of answers) {
      const rebuilt = setupAgentRepairView(a.repair) as any;
      expect(rebuilt.state, a.scenario).toBe(a.repair.state);
      expect(rebuilt.actions.map((x: any) => x.id), a.scenario).toEqual(a.repair.actions.map((x: any) => x.id));
      for (const x of rebuilt.actions) expect(x.label).toBe(SETUP_AGENT_REPAIR_ACTIONS[x.id]);
      expect(JSON.stringify(rebuilt), a.scenario).not.toContain("$");
      expect(rebuilt.classes, a.scenario).toEqual(a.repair.classes);
      expect(rebuilt.failure, a.scenario).toBe(a.repair.failure);
      expect(rebuilt.candidateRevision, a.scenario).toBe(a.repair.candidateRevision);
      expect(rebuilt.changes, a.scenario).toBe(a.repair.changes);
      expect(a.repair.body, a.scenario).toContain(`(${rebuilt.step})`);
    }
  });
});

describe("the setup-agent repair card is strict", () => {
  const find = (scenario: string): any => structuredClone(load("code-7f334a6ef").answers.find((a) => a.scenario === scenario)!.repair);
  const refuses = (card: unknown) => expect(() => setupAgentRepairView(card)).toThrow(Unreadable);
  it("refuses an unknown id, a wrong label, wrong actions for the state, an extra member (K5)", () => {
    const ready = find("fix_ready (3 changes)"), no = find("no_fix (no repair row)"), drafting = find("drafting");
    refuses({ ...ready, actions: [{ id: "approve_new_setup", label: "Approve new setup" }, { id: "see_changes", label: "See changes" }] });
    refuses({ ...ready, actions: [{ id: "approve_setup", label: "Approve" }, { id: "see_changes", label: "See changes" }] });
    refuses({ ...no, actions: [{ id: "fix_setup", label: "Fix setup" }, { id: "edit_commands", label: "Edit commands myself" }] });
    refuses({ ...no, actions: [{ id: "fix_setup", label: "Fix setup (uses your AI, up to $4)" }, { id: "wipe", label: "Edit commands myself" }] });
    refuses({ ...no, actions: [{ id: "fix_setup", label: "Fix setup (uses your AI, up to $4)" }] });
    refuses({ ...drafting, actions: no.actions });
    refuses({ ...no, extra: 1 });
    refuses({ ...no, title: "Setup repaired" });
  });
  it("refuses words Code does not say, a count that does not match the text, a failure that does not match the sentence, a class Code does not have (K6)", () => {
    const ready = find("fix_ready (3 changes)"), one = find("fix_ready (1 change)"), failed = find("failed run_failed");
    refuses({ ...ready, body: ready.body.replace("it passes", "it mostly passes") });
    refuses({ ...ready, changes: 2 });
    refuses({ ...ready, body: ready.body.replace("3 changes", "3 change") });
    refuses({ ...one, body: one.body.replace("1 change", "1 changes") });
    refuses({ ...ready, candidateRevision: undefined });
    refuses({ ...failed, failure: "check_failed" });
    refuses({ ...failed, failure: undefined });
    refuses({ ...find("drafting"), failure: "run_failed" });
    refuses({ ...find("no_fix (no repair row)"), classes: ["lockfile", "secrets"] });
    refuses({ ...find("no_fix (no repair row)"), body: `${find("no_fix (no repair row)").body} Click here.` });
  });
  it("takes a Fix setup cost figure of any size Code's budget can make", () => {
    for (const figure of ["$4", "$1.50", "$12", "$0.50"]) {
      const card = find("no_fix (no repair row)");
      card.actions[0].label = `Fix setup (uses your AI, up to ${figure})`;
      expect((setupAgentRepairView(card) as any).actions[0].label).toBe("Fix setup");
    }
    const card = find("no_fix (no repair row)");
    card.actions[0].label = "Fix setup (uses your AI, up to $4) now";
    refuses(card);
  });
});

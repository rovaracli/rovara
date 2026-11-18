// L4-T2c (pairs with Code #1063, L4-T2b): an approved setup stays Done when a re-run's proposal is waiting, being checked or rejected, and Code's row says so with `newerProposal` (needs_you, checking, rejected).
// This Cloud reads it strictly: one of those three words, and only beside an approved setup (anything else refuses the whole read); an answer without it (an older Code) reads as before; every field it does not know is
// still dropped. The words the person sees are Cloud's own fixed ones, so the value passes through as the word only.
import { describe, expect, it } from "vitest";
import { checklistAnswer } from "../../packages/cloud-server/src/index.js";
import { ProjectSetupChecklistSchema } from "../../packages/contracts/src/project-setup-status.js";
import { SETUP_STATUS_NO_EVALS } from "../fixtures/code-answers.js";

type Plain = Record<string, unknown>;
const code = (over: Plain = {}): Plain => ({ ...structuredClone(SETUP_STATUS_NO_EVALS), ...over });
const run = (over: Plain): Plain => ({ ...(code()["setupRun"] as Plain), ...over });
const rebuild = (value: unknown) => checklistAnswer(value, "alpha");
const setupRun = (answer: Plain) => answer["setupRun"] as Plain;

describe("newerProposal on the setup row (L4-T2c)", () => {
  it("passes each of Code's three words through beside an approved setup, still Done, and the app's schema reads it", () => {
    for (const word of ["needs_you", "checking", "rejected"]) {
      const answer = rebuild(code({ setupRun: run({ newerProposal: word }) }));
      expect(setupRun(answer)["newerProposal"], word).toBe(word);
      expect(setupRun(answer)).toMatchObject({ state: "done", approval: "approved", check: { status: "ready" } });
      const parsed = ProjectSetupChecklistSchema.safeParse(answer);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.setupRun.newerProposal).toBe(word);
    }
  });

  it("still accepts an answer without the field (an older Code): nothing is added", () => {
    const answer = rebuild(code());
    expect("newerProposal" in setupRun(answer)).toBe(false);
    expect(setupRun(answer)).toMatchObject({ state: "done", approval: "approved" });
    expect(ProjectSetupChecklistSchema.safeParse(answer).success).toBe(true);
  });

  it("refuses the whole read for a word Code never sends, a non-string, or null", () => {
    for (const bad of ["waiting", "approved", "NEEDS_YOU", "", " rejected", 1, true, null, ["rejected"], { word: "rejected" }]) {
      expect(() => rebuild(code({ setupRun: run({ newerProposal: bad }) })), JSON.stringify(bad)).toThrow();
    }
  });

  it("refuses a newer proposal beside anything but an approved setup", () => {
    for (const approval of ["none", "candidate", "checking"]) {
      expect(() => rebuild(code({ setupRun: run({ approval, newerProposal: "needs_you", state: "needs_you" }) })), approval).toThrow();
    }
  });

  it("an unknown field is still not passed on: it is dropped, and the known one is kept as a word only", () => {
    const answer = rebuild(code({ setupRun: run({ newerProposal: "needs_you", newerProposalDetail: "LEAK", proposal: { note: "LEAK" } }) }));
    expect(JSON.stringify(answer)).not.toContain("LEAK");
    expect(Object.keys(setupRun(answer)).filter((key) => key.toLowerCase().includes("newer"))).toEqual(["newerProposal"]);
  });

  it("changes nothing else: the row without the field is rebuilt exactly as with it, apart from the word", () => {
    const withWord = rebuild(code({ setupRun: run({ newerProposal: "rejected" }) }));
    const without = rebuild(code());
    const { newerProposal, ...rest } = setupRun(withWord);
    expect(newerProposal).toBe("rejected");
    expect(rest).toEqual(setupRun(without));
    for (const row of ["project", "viewer", "progress", "repos", "evalConfirm", "aiAndSpend", "firstTask"]) expect(withWord[row], row).toEqual(without[row]);
  });
});

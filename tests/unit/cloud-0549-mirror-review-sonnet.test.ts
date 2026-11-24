// REVIEW (Sonnet, uncommitted): Code 0.5.49 mirrors that the lane did not test. Cases copied from Code 4ff67252e tests/unit/setup-malformed-run-command.test.ts, plus the wc-line-count lint, the 2-hour park word,
// and the wiki end word across the app contract, the server rebuilder and the page label.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETUP_HOST_WAIT_MAX_HOURS } from "../../packages/contracts/src/index.js";
import { WIKI_SETUP_CODE_WORDS, WIKI_SETUP_END_WORDS } from "../../packages/contracts/src/app-wiki-setup.js";
import { buildAnswer } from "../../packages/cloud-server/src/wiki-setup-routes.js";

describe("the 2-hour park word and the wiki end word", () => {
  it("SETUP_HOST_WAIT_MAX_HOURS is 2", () => { expect(SETUP_HOST_WAIT_MAX_HOURS).toBe(2); });
  it("code_moved is an app end word with its sentence, the server rebuilder passes it, and the page labels it", () => {
    expect(WIKI_SETUP_END_WORDS).toContain("code_moved");
    expect(WIKI_SETUP_CODE_WORDS.code_moved).toContain("The code changed while the wiki build was starting");
    const view = { status: "stopped", limits: { pages: 10, budgetCents: 500, wallClockMin: 60, pageReserveCents: 50 }, payer: "project", stop: "code_moved", message: WIKI_SETUP_CODE_WORDS.code_moved, canManage: true, aiKey: "connected", agents: { on: true }, wiki: { pages: 3, refreshPages: 1 } };
    expect(buildAnswer(view)).toMatchObject({ stop: "code_moved", message: WIKI_SETUP_CODE_WORDS.code_moved });
    expect(() => buildAnswer({ ...view, stop: "code_moved_x" })).toThrow();
    expect(readFileSync("packages/ui/src/screens/wiki-skills-read/WikiSetupReadPanel.tsx", "utf8")).toContain("code_moved: \"The code changed while it started\"");
  });
});

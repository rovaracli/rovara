// REVIEW (Sonnet, uncommitted): Code 0.5.49 mirrors that the lane did not test. Cases copied from Code 4ff67252e tests/unit/setup-malformed-run-command.test.ts, plus the wc-line-count lint, the 2-hour park word,
// and the wiki end word across the app contract, the server rebuilder and the page label.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MALFORMED_RUN_REASON, PlanQualityFindingSchema, PLAN_QUALITY_LINTS, SETUP_HOST_WAIT_MAX_HOURS, malformedRunReason, planQualityFinding, sanitizeSetupProposal,
} from "../../packages/contracts/src/index.js";
import { WIKI_SETUP_CODE_WORDS, WIKI_SETUP_END_WORDS } from "../../packages/contracts/src/app-wiki-setup.js";
import { buildAnswer } from "../../packages/cloud-server/src/wiki-setup-routes.js";

const COMMIT = "a".repeat(40);
const context = { basedOnRevision: 1, repositories: [{ name: "web", commit: COMMIT }] };
const from = [{ kind: "file", repo: "web", path: "package.json", commit: COMMIT, line: 3, quote: "\"lint\"" }];
const proposalOf = (extra: Record<string, unknown>) => {
  const result = sanitizeSetupProposal({ setup: [{ repo: "web", commands: ["npm ci"], from }], ...extra }, context);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.proposal;
};

describe("malformedRunReason (Code's cases)", () => {
  it.each([
    "npm run lint npm test", "npm run lint test", "yarn run lint yarn test", "pnpm run lint pnpm test", "pnpm run lint npm test", "yarn run lint npx jest", "npm run-script lint test", "npm run --silent lint npm test", "npm run --prefix web lint npm test",
    "npm ci && npm run lint npm test", "npm run lint npm test && npm ci", "npm run lint npm test | tee out",
  ])("refuses %s", (command) => { expect(malformedRunReason(command)).toBe(MALFORMED_RUN_REASON); });
  it.each([
    "npm run lint", "npm test", "yarn run jest path/to/file", "pnpm run test --filter x", "pnpm run test src/a.test.ts", "yarn run lint test", "pnpm run build --filter web yarn", "npm run lint && npm test", "npm run test -- --watch=false", "npm run test --silent", "npm run build --workspace web", "yarn run test -- src/a.test.ts", "pnpm run lint -- --fix",
    "npm run --prefix web lint", "pnpm test", "make lint test", "npm run", "npm run lint -- npm test", "npm run -- lint npm test", "echo npm run lint npm test", "npm install lint test",
  ])("keeps %s", (command) => { expect(malformedRunReason(command)).toBeUndefined(); });
  it("the reader keeps a glued run out of setup, tests, checks and the start command", () => {
    const proposal = proposalOf({
      tests: [{ repo: "web", commands: ["npm run lint npm test", "npm run test -- --watch=false", "npm run lint && npm test"], from }],
      checks: [{ name: "lint", repo: "web", command: "pnpm run lint pnpm test", from }],
      browserEvidence: { startCommand: "yarn run dev yarn start", port: 3000, routes: [{ path: "/", files: ["src/**"] }], from },
    });
    expect(proposal.tests[0]!.value.commands).toEqual(["npm run test -- --watch=false", "npm run lint && npm test"]);
    expect(proposal.checks).toEqual([]);
    expect(proposal.browserEvidence).toBeUndefined();
    expect(proposal.flaggedCommands.map((item) => item.reason)).toEqual([MALFORMED_RUN_REASON, MALFORMED_RUN_REASON, MALFORMED_RUN_REASON]);
    expect(sanitizeSetupProposal(JSON.parse(JSON.stringify(proposal)) as unknown, context)).toEqual({ ok: true, proposal });
  });
});

describe("plan quality: wc-line-count (Code 0.5.49)", () => {
  it("is a member of the lint enum and a finding with it parses strictly, with Code's two sentences", () => {
    expect(PLAN_QUALITY_LINTS).toContain("wc-line-count");
    const finding = planQualityFinding({ code: "check-command-lint", checkIds: ["proposed-1"], lint: "wc-line-count" });
    expect(PlanQualityFindingSchema.safeParse(finding).success).toBe(true);
    expect(finding.ownerSentence).toContain("one line short");
    expect(finding.plannerLine).toContain("awk 'END{exit NR==1?0:1}' file");
    expect(PlanQualityFindingSchema.safeParse({ ...finding, lint: "wc-lines" }).success).toBe(false);
  });
});

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

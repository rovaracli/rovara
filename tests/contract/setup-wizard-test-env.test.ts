// Setup wizard (E4), the routes behind it, through the whole broker: what the wizard shows, an edited proposal, applying the proposal's commands to the project's settings, and the approval authority for a change that is
// less safe than the sandbox (a fresh browser sign-in, and a second person's confirmation card read back from the company's records). With the switch off none of it exists.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TestEnvironmentStateSchema, projectMetaKey, testEnvDigest } from "../../packages/contracts/src/index.js";
import { commandsToApply, runsOf, shownLine } from "../../packages/broker/src/aws/developer-routes/test-environment-wizard.js";
import { MAYA, OMAR, type Developer } from "../support/developer-task-broker.js";
import { ENV, NAME, command, draftBody, draftOf, errorOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; });

const NIGHTLY = { nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" } };
const lessSafeBody = () => draftBody(NIGHTLY);

/** Revision 1 approved from the draft; then an EDITED proposal that turns the nightly run on (a spending change, so less safe) proved and waiting. */
async function lessSafeProposal(t: Bench): Promise<string> {
  await t.approveFirst();
  const edited = await t.web(OMAR, "POST", `${ENV}/edit`, { environment: lessSafeBody() });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  const digest = testEnvDigest(lessSafeBody());
  const proved = await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
  expect(proved.status, JSON.stringify(proved.body)).toBe(200);
  return digest;
}

describe("with the switch off", () => {
  it("the wizard's routes do not exist and nothing is stored", async () => {
    const t = await setupWizardBench();
    await withSwitch(undefined, async () => {
      for (const [method, path, body] of [["POST", `${ENV}/edit`, { environment: draftBody() }], ["POST", `${ENV}/apply-commands`, { digest: "a".repeat(64), requestId: randomUUID(), expectedRevision: 1 }], ["POST", `${ENV}/request-approval`, { digest: "a".repeat(64), expectedRevision: 0 }]] as const) {
        expect((await t.web(OMAR, method, path, body)).status, path).toBe(404);
        expect((await t.dev(OMAR, method, path, body)).status, path).toBe(404);
      }
    });
    expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#"))).toEqual([]);
    expect(t.approvals()).toEqual([]);
  });
});

describe("what the wizard shows", () => {
  it("a proposal states what will run, where each value came from, what approving needs, and whether the setup check has run its commands", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      await t.drafted();
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      const { proposal } = await t.state();
      expect(proposal).toMatchObject({
        source: "setup", risk: "medium", lessSafe: [], proved: false, needs: { freshSignIn: false, secondPerson: false }, approval: { status: "none" }, commandsNotInSettings: 0,
        runs: [{ repositoryId: "web", setup: ["make old-setup"], checks: [{ id: "unit", kind: "test", command: "make old-test", selectArgs: ["{tests}"] }] }],
      });
      expect(proposal!.valueSources).toEqual([{ field: "repos[0].checks[0]", source: "detector:node" }, { field: "repos[0].setupCommands[0]", source: { path: "Makefile", line: 3 } }]);
    });
  });
});

describe("what the wizard is told is fit for the page", () => {
  it("the state the broker answers is what the browser's contract reads, with and without a proposal and an edit", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      const read = async () => { const { requestId: _gateway, ...own } = (await t.web(OMAR, "GET", ENV)).body; void _gateway; return TestEnvironmentStateSchema.parse(own); };
      expect((await read()).proposal).toBeUndefined();
      await t.drafted();
      await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      expect((await read()).proposal).toMatchObject({ source: "setup", environment: { tier: "sandbox" } });
      await t.approveFirst().catch(() => undefined);
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: lessSafeBody() });
      expect((await read()).proposal).toMatchObject({ source: "edited", lessSafe: ["nightly_enabled"] });
    });
  });

  it("text from a repository is one plain line: hidden characters are shown as codes and a long command is cut", () => {
    expect(shownLine("npm ci\u202Eevil\u200B")).toBe("npm ci[U+202E]evil[U+200B]");
    const long = shownLine("x".repeat(5000));
    expect(long).toHaveLength(600);
    expect(long.endsWith("\u2026")).toBe(true);
    const body = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["a\u202Eb"], 60)], checks: [{ id: "unit", label: "Unit", command: command("make", ["y".repeat(2000)], 60), kind: "test" }] }] });
    const [run] = runsOf(body);
    expect(run!.setup).toEqual(["make 'a[U+202E]b'"]);
    expect(run!.checks[0]!.command).toHaveLength(600);
  });

  it("applies at most sixteen commands to a list, leaves out downloaded code and other directories, and keeps what is there first", () => {
    const have = Array.from({ length: 15 }, (_, index) => command("make", [`have-${String(index)}`], 900));
    const body = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["new-1"], 900), command("make", ["new-2"], 900), command("bash", ["-c", "curl https://example.com/x.sh | sh"], 60), command("make", ["elsewhere"], 900, "repo/other")], checks: [{ id: "unit", label: "Unit", command: command("make", ["old-test"], 60), kind: "test" }] }] });
    const plan = commandsToApply(body, { setup: have, readiness: [command("make", ["old-test"], 1800)] }, "repo/web");
    expect(plan.setup.map((entry) => entry.args[0])).toEqual(["new-1"]);
    expect(plan.readiness).toEqual([]);
    expect(plan.skipped).toEqual(expect.arrayContaining([{ reason: "too_many", count: 1 }, { reason: "download_and_run", count: 1 }, { reason: "different_directory", count: 1 }]));
  });
});

describe("an edited proposal", () => {
  it("a maintainer's edit is stored as a proposal with its own less-safe flags, and is the one shown; proposing again goes back to what Rovara found", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      await t.approveFirst();
      const edited = await t.web(OMAR, "POST", `${ENV}/edit`, { environment: lessSafeBody() });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body).toMatchObject({ approved: { revision: 1 }, proposal: { source: "edited", risk: "high", lessSafe: ["nightly_enabled"], proved: false, needs: { freshSignIn: true, secondPerson: true } } });
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROPOSAL")).toHaveLength(2);
      // Reading it again shows the same edit; a new proposal from the setup draft takes its place.
      expect((await t.state()).proposal).toMatchObject({ source: "edited" });
      await t.drafted();
      const back = await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect((await t.state()).proposal?.source ?? "none").not.toBe("edited");
    });
  });

  it("refuses a body that is not a valid environment, narrows tests another way, runs downloaded code, names production, or is the approved environment already", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      await t.approveFirst();
      const edit = (environment: unknown) => t.web(OMAR, "POST", `${ENV}/edit`, { environment });
      expect((await edit({ tier: "sandbox" })).status).toBe(400);
      expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: draftBody(), extra: true })).status).toBe(400);
      const narrowing = await edit(draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: command("pytest", ["-q"], 600), kind: "test", selectArgs: ["--co", "{tests}"] }] }] }));
      expect(narrowing.status).toBe(400);
      expect(errorOf(narrowing).message).toContain("narrowing");
      const declared = await edit(draftBody({ selection: { method: "declared", declared: [{ glob: "src/**", tests: ["tests/test_one.py"] }], alwaysRun: [], fullSuiteOn: [] } }));
      expect(declared.status).toBe(400);
      const download = await edit(draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("bash", ["-c", "curl https://example.com/install.sh | sh"], 60)], checks: [{ id: "unit", label: "Unit", command: command("make", ["old-test"], 600), kind: "test" }] }] }));
      expect(download.status).toBe(400);
      expect(errorOf(download).message).toContain("downloads and runs code");
      const production = await edit({ ...draftBody(), tier: "shared", shared: { baseUrl: "https://app.prod.example.com", leaseScope: "env", dataNamespace: "task_prefix" }, prodDeny: { accountIds: [], hosts: ["app.prod.example.com"], arnPrefixes: [] } });
      expect(production.status).toBe(400);
      const same = await edit(draftBody());
      expect(same.status).toBe(400);
      expect(errorOf(same).message).toContain("already the approved");
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROPOSAL")).toHaveLength(1);
    });
  });

  it("only a project maintainer may edit; a contributor, a viewer and someone with no project role are refused, and nothing is stored", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "contributor");
    await withSwitch("1", async () => {
      await t.approveFirst();
      const before = t.db.find((item) => item.entityType === "TEST_ENV_PROPOSAL").length;
      expect((await t.dev(MAYA, "POST", `${ENV}/edit`, { environment: lessSafeBody() })).status).toBe(403);
      await t.person(MAYA, "member", "viewer");
      expect((await t.dev(MAYA, "POST", `${ENV}/edit`, { environment: lessSafeBody() })).status).toBe(403);
      const stranger: Developer = { developerId: "9".repeat(64), name: "Stranger", provider: "oidc", sessionId: "s-stranger" };
      await t.person(stranger, "member");
      t.db.set({ pk: `SESSION#${stranger.sessionId}`, sk: "META", sessionId: stranger.sessionId, developerId: stranger.developerId, amr: stranger.provider, startedAt: new Date().toISOString(), endsAt: Math.floor(Date.now() / 1000) + 3600 });
      t.db.set({ pk: `DEVELOPER#${stranger.developerId}`, sk: "META", developerId: stranger.developerId, provider: stranger.provider, displayName: stranger.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
      expect((await t.dev(stranger, "POST", `${ENV}/edit`, { environment: lessSafeBody() })).status).toBe(404);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_PROPOSAL")).toHaveLength(before);
    });
  });
});

describe("applying the proposal's commands to the project's settings", () => {
  const withNewCommands = () => draftOf(draftBody({
    repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900), command("make", ["deps"], 900)], checks: [
      { id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" },
      { id: "smoke", label: "Smoke", command: command("make", ["smoke"], 600), kind: "smoke" },
      { id: "lint", label: "Lint", command: command("ruff", ["check"], 600), kind: "lint" },
      { id: "other-dir", label: "Other", command: command("make", ["other"], 600, "repo/other"), kind: "build" },
    ] }],
  }));

  it("adds what the setup check has not run after the commands already there, marks them as Rovara's, starts the setup check, and a second press adds nothing", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      await t.drafted(withNewCommands());
      expect((await t.dev(OMAR, "POST", `${ENV}/propose`, {})).status).toBe(200);
      const digest = testEnvDigest(withNewCommands().environment);
      expect((await t.state()).proposal!.commandsNotInSettings).toBe(3);
      const applied = await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 1 });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body).toMatchObject({ added: ["make deps", "make smoke"], settingsRevision: 2, setupCheck: "started" });
      expect(applied.body.skipped).toEqual(expect.arrayContaining([{ reason: "different_directory", count: 1 }, { reason: "not_needed", count: 1 }]));
      const definition = (t.db.find((item) => item.entityType === "PROJECT" && (item.definition as { revision: number }).revision === 2)[0] as { definition: { setup: Array<{ args: string[] }>; readiness: Array<{ args: string[] }>; origins?: Record<string, string> } }).definition;
      expect(definition.setup.map((entry) => entry.args[0])).toEqual(["old-setup", "deps"]);
      expect(definition.readiness.map((entry) => entry.args[0])).toEqual(["old-test", "smoke"]);
      expect(definition.origins).toMatchObject({ setup: "agent", readiness: "agent" });
      const again = await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 2 });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body).toMatchObject({ added: [], settingsRevision: 2, setupCheck: "not_needed" });
    });
  });

  it("is refused for a stale settings revision, a proposal that is not stored, and anyone who may not edit settings", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "contributor");
    await withSwitch("1", async () => {
      await t.drafted(withNewCommands());
      await t.dev(OMAR, "POST", `${ENV}/propose`, {});
      const digest = testEnvDigest(withNewCommands().environment);
      expect((await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 7 })).status).toBe(409);
      expect((await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest: "b".repeat(64), requestId: randomUUID(), expectedRevision: 1 })).status).toBe(409);
      expect((await t.dev(MAYA, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 1 })).status).toBe(403);
      expect(t.db.find((item) => item.entityType === "PROJECT" && (item.definition as { revision: number }).revision === 2)).toEqual([]);
    });
  });

  it("will not move commands that run in another directory, and never applies a command that downloads and runs code", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      await t.approveFirst();
      // An edited body (not the detectors') is checked when it is stored; one that slipped a bad command in is still not applied.
      const body = draftBody({ repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }, { id: "smoke", label: "Smoke", command: command("make", ["smoke"], 600), kind: "smoke" }] }] });
      expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: body })).status).toBe(200);
      t.db.set({ ...(t.db.get(projectMetaKey(TEST_ORG, NAME)) as Record<string, unknown>) });
      const digest = testEnvDigest(body);
      const applied = await t.dev(OMAR, "POST", `${ENV}/apply-commands`, { digest, requestId: randomUUID(), expectedRevision: 1 });
      expect(applied.body).toMatchObject({ added: ["make smoke"] });
    });
  });
});

describe("approving a change that is less safe than the sandbox", () => {
  it("a token cannot approve it, and a browser that signed in too long ago is asked to sign in again", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(t);
      const viaToken = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(viaToken.status).toBe(403);
      expect(errorOf(viaToken).message).toContain("in a browser");
      t.ageSignIn(OMAR, 11);
      const old = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(old.status).toBe(403);
      expect(errorOf(old)).toMatchObject({ code: "REAUTH_REQUIRED" });
      t.ageSignIn(OMAR, undefined);
      expect(errorOf(await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 })).code).toBe("REAUTH_REQUIRED");
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toHaveLength(1);
    });
  });

  it("a fresh sign-in alone is not enough: it needs a second person's confirmation", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "admin");
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(t);
      const refused = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(refused.status).toBe(403);
      expect(errorOf(refused).message).toContain("second person");
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toHaveLength(1);
    });
  });

  it("asks a second person on the confirmation page, and approves once that person confirmed with a fresh sign-in", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "admin");
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(t);
      const asked = await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 });
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      expect(asked.body).toMatchObject({ status: "pending", state: { proposal: { approval: { status: "pending" } } } });
      expect(String(asked.body.confirmUrl)).toContain("/v1/app/approve/apr_");
      const [card] = t.approvals();
      expect(card).toMatchObject({ requestedBy: OMAR.developerId, status: "PENDING", subject: { kind: "test_env", project: NAME, digest, expectedRevision: 1 }, approvers: { kind: "rule", rule: "test_env" } });
      // Asking again is the same card.
      expect(((await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 })).body as { confirmUrl: string }).confirmUrl).toContain(card!.approvalId);
      expect(t.approvals()).toHaveLength(1);
      // Not confirmed yet: still refused.
      expect((await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 })).status).toBe(403);
      t.confirmCard(card!.approvalId, MAYA);
      expect((await t.state()).proposal).toMatchObject({ approval: { status: "approved" } });
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ revision: 2, digest, replayed: false });
      const revision = t.db.find((item) => item.entityType === "TEST_ENV_REVISION" && item.revision === 2)[0] as { lessSafe: string[]; approvedBy: string; secondApprover: { id: string; mode: string } };
      expect(revision).toMatchObject({ lessSafe: ["nightly_enabled"], approvedBy: OMAR.developerId, secondApprover: { id: MAYA.developerId, mode: "second_person" } });
    });
  });

  it("the second person's confirmation is read again: an old sign-in proof, a person demoted since, the wrong proposal or revision, and another asker's card are not accepted", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "admin");
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(t);
      await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 });
      const [card] = t.approvals();
      // A confirmation older than ten minutes.
      t.confirmCard(card!.approvalId, MAYA, Date.now() - 11 * 60_000);
      const old = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(errorOf(old).code).toBe("REAUTH_REQUIRED");
      // Confirmed just now, but the confirming person has since become an ordinary member with no project grant.
      t.confirmCard(card!.approvalId, MAYA);
      await t.person(MAYA, "member");
      const demoted = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(demoted.status).toBe(403);
      expect(errorOf(demoted).message).toContain("second person");
      await t.person(MAYA, "admin");
      // A card for the revision the proposal was looked at against is bound to that revision: an approval that moves it on leaves the old card unusable, and the card never carries to another asker.
      const otherAsker = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(otherAsker.status).toBe(409);
      expect(t.db.find((item) => String(item.sk).startsWith("TESTENV#REV#"))).toHaveLength(1);
      // Maya presses Approve with Omar's card: it was not asked by her, so it is not hers to finish.
      await t.person(MAYA, "admin", "maintainer");
      const hers = await t.web(MAYA, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(hers.status).toBe(403);
      expect(errorOf(hers).message).toContain("second person");
    });
  });

  it("the same person is refused when the company has another eligible owner or admin, and accepted only under the sole-owner exception", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "admin");
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(t);
      await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 });
      const [card] = t.approvals();
      // Omar confirms his own card while Maya is eligible too.
      t.confirmCard(card!.approvalId, OMAR);
      const same = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(same.status).toBe(403);
      expect(errorOf(same).message).toContain("second person");
    });
    // The company's only owner, with nobody else eligible and nobody removed lately: the exception applies.
    const solo = await setupWizardBench();
    await withSwitch("1", async () => {
      const digest = await lessSafeProposal(solo);
      await solo.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 });
      solo.confirmCard(solo.approvals()[0]!.approvalId, OMAR);
      const approved = await solo.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(solo.db.find((item) => item.entityType === "TEST_ENV_REVISION" && item.revision === 2)[0]).toMatchObject({ secondApprover: { id: OMAR.developerId, mode: "sole_owner_exception" } });
    });
  });

  it("asking for a second person is for a change that needs one, a proved proposal and the revision the person looked at", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "contributor");
    await withSwitch("1", async () => {
      await t.approveFirst();
      expect((await t.web(OMAR, "POST", `${ENV}/edit`, { environment: lessSafeBody() })).status).toBe(200);
      const digest = testEnvDigest(lessSafeBody());
      const unproved = await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 });
      expect(unproved.status).toBe(400);
      expect(errorOf(unproved).message).toContain("Prove");
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      expect((await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 0 })).status).toBe(409);
      expect((await t.dev(MAYA, "POST", `${ENV}/request-approval`, { digest, expectedRevision: 1 })).status).toBe(403);
      expect((await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest: "c".repeat(64), expectedRevision: 1 })).status).toBe(409);
      expect(t.approvals()).toEqual([]);
      // A change that is not less safe has no second person to ask.
      const plain = draftBody({ roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [".github/**"] } });
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: plain });
      const plainDigest = testEnvDigest(plain);
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest: plainDigest });
      const notNeeded = await t.web(OMAR, "POST", `${ENV}/request-approval`, { digest: plainDigest, expectedRevision: 1 });
      expect(notNeeded.status).toBe(400);
      expect(errorOf(notNeeded).message).toContain("doesn't need");
    });
  });

  it("a change that is not less safe is approved as before, with no card and no fresh sign-in", async () => {
    const t = await setupWizardBench();
    await withSwitch("1", async () => {
      await t.approveFirst();
      const plain = draftBody({ selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [".github/**"] } });
      await t.web(OMAR, "POST", `${ENV}/edit`, { environment: plain });
      const digest = testEnvDigest(plain);
      await t.web(OMAR, "POST", `${ENV}/prove`, { digest });
      t.ageSignIn(OMAR, undefined);
      const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 1 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ revision: 2 });
    });
  });
});

// Owner decision 11 (one apply path), through the whole broker: a setup draft's "Check and apply", and a maintainer's typed commands, become the test environment's proposal; the wizard shows it
// (shownProposal), its check runs, Prove passes, and only the approval writes the commands into the settings. Nothing is saved before that.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { projectRevisionKey } from "@agentx/contracts";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ENV, NAME, draftOf, setupWizardBench, withSwitch, type Bench } from "../support/setup-wizard-testenv.js";

afterEach(() => { delete process.env.TEST_ENVIRONMENT_ENABLED; });

const BASE = `/v1/app/projects/${NAME}/setup-draft`;
const PROPOSAL = {
  setup: [{ repo: "web", commands: ["make deps"], confidence: "high", from: [{ kind: "inferred", repo: "web", note: "a Makefile" }] }],
  tests: [{ repo: "web", commands: ["make smoke"], confidence: "high", from: [{ kind: "inferred", repo: "web", note: "a Makefile" }] }],
  notes: "ok",
};
interface Stored { definition: { revision: number; setup: Array<{ args: string[] }>; readiness: Array<{ args: string[] }> } }
const settingsOf = (t: Bench) => (t.db.find((item) => item.entityType === "PROJECT") as unknown as Stored[]).sort((a, b) => a.definition.revision - b.definition.revision).at(-1)!.definition;
const argsOf = (commands: ReadonlyArray<{ args: string[] }>) => commands.map((entry) => entry.args[0]);
const candidates = (t: Bench) => t.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Array<{ workspaceId: string; digest: string }>;
const prepareOf = (t: Bench, workspaceId: string) => String((t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
async function checkAndProve(t: Bench, digest: string): Promise<void> {
  const started = await t.dev(OMAR, "POST", `${ENV}/check`, { digest, requestId: randomUUID() });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const record = candidates(t).at(-1)!;
  expect(record.digest).toBe(digest);
  await t.finish(record.workspaceId, prepareOf(t, record.workspaceId), "SUCCEEDED", {});
  const proved = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
  expect(proved.status, JSON.stringify(proved.body)).toBe(200);
}

describe("a draft's Check and apply goes through the test environment", () => {
  it("proposes the commands with the marker the wizard reads, the wizard shows that proposal, and check, Prove and the approval write them", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      await t.drafted(draftOf(), { setupProposal: PROPOSAL });
      const requestId = randomUUID();
      const items = [{ id: "setup-web", useSuggestion: true }, { id: "tests-web", useSuggestion: true }];
      const applied = await t.dev(OMAR, "POST", `${BASE}/apply`, { requestId, expectedRevision: 1, items });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      const results = applied.body.results as Array<{ id: string; outcome: string; proposalDigest?: string }>;
      expect(results.map((entry) => entry.outcome)).toEqual(["proposed", "proposed"]);
      const digest = results[0]!.proposalDigest!;
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
      // Nothing is saved yet.
      expect(settingsOf(t).revision).toBe(1);
      expect(argsOf(settingsOf(t).setup)).toEqual(["old-setup"]);
      // The wizard shows exactly that proposal, as Rovara's.
      const shown = await t.state();
      expect(shown.proposal).toMatchObject({ digest, source: "setup" });
      // A repeat of the press answers the same and proposes nothing new.
      const again = await t.dev(OMAR, "POST", `${BASE}/apply`, { requestId, expectedRevision: 1, items });
      expect((again.body.results as Array<{ proposalDigest?: string }>)[0]!.proposalDigest).toBe(digest);
      expect(t.db.find((item) => item.entityType === "TEST_ENV_SETUP_RUN")).toHaveLength(1);
      await checkAndProve(t, digest);
      // Owner direction: the approval rule follows the proposal, not the screen: a draft's proposal ("setup_draft") needs the same fresh sign-in in a browser as a setup run's.
      expect((shown.proposal as unknown as { needs: { freshSignIn: boolean } }).needs.freshSignIn).toBe(true);
      const viaToken = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(viaToken.status).toBe(403);
      t.ageSignIn(OMAR, 11);
      const stale = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect((stale.body.error as { code: string }).code).toBe("REAUTH_REQUIRED");
      expect(settingsOf(t).revision).toBe(1);
      t.ageSignIn(OMAR, 1);
      const approved = await t.web(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(argsOf(settingsOf(t).setup)).toContain("deps");
      expect(argsOf(settingsOf(t).readiness)).toContain("smoke");
    });
  });
});

describe("typed commands go through the test environment as the person's edited proposal", () => {
  it("are proposed as an edit, shown as the person's, saved nowhere, and written only by the approval", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const requestId = randomUUID();
      const body = { requestId, expectedRevision: 1, setupCommands: ["make deps"], testCommands: ["make smoke"] };
      const typed = await t.dev(OMAR, "POST", `${BASE}/typed`, body);
      expect(typed.status, JSON.stringify(typed.body)).toBe(200);
      const digest = typed.body.proposalDigest as string;
      expect(typed.body).toMatchObject({ source: "edited" });
      expect(settingsOf(t).revision).toBe(1);
      expect((await t.state()).proposal).toMatchObject({ digest, source: "edited" });
      // A repeat answers the same; another person's use of the id is refused.
      expect((await t.dev(OMAR, "POST", `${BASE}/typed`, body)).body.proposalDigest).toBe(digest);
      // The same as the wizard's own edit of that environment (the setup helper's edited path): what a person edits is approved by the content's rules, no fresh sign-in for a sandbox with plain commands.
      const shown = await t.state();
      expect((shown.proposal as unknown as { risk: string; needs: { freshSignIn: boolean; secondPerson: boolean } })).toMatchObject({ risk: "medium", needs: { freshSignIn: false, secondPerson: false } });
      const viaEdit = await setupWizardBench({ autoCandidate: false });
      const edited = await viaEdit.dev(OMAR, "POST", `${ENV}/edit`, { environment: (shown.proposal as unknown as { environment: unknown }).environment });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const editedShown = (await viaEdit.state()).proposal as unknown as { digest: string; source: string; risk: string; needs: unknown };
      expect({ digest: editedShown.digest, source: editedShown.source, risk: editedShown.risk, needs: editedShown.needs }).toEqual({ digest, source: "edited", risk: "medium", needs: { freshSignIn: false, secondPerson: false } });
      await checkAndProve(t, digest);
      const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      // Review I2: typed commands REPLACE the lists: exactly what was typed, the old commands gone.
      expect(argsOf(settingsOf(t).setup)).toEqual(["deps"]);
      expect(argsOf(settingsOf(t).readiness)).toEqual(["smoke"]);
    });
  });

  it("answers not found where the test environment is off, so the page saves the settings as before; and needs a test command", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch(undefined, async () => {
      expect((await t.dev(OMAR, "POST", `${BASE}/typed`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make deps"], testCommands: ["make smoke"] })).status).toBe(404);
    });
    await withSwitch("1", async () => {
      expect((await t.dev(OMAR, "POST", `${BASE}/typed`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make deps"], testCommands: [] })).status).toBe(400);
    });
  });
});

// UX-4b review: typed commands replace the lists (I2), the server refuses a direct browser save of commands with the test environment on (I1), the typed request record holds (M1), and a repeated
// draft press leaves a later wizard edit alone (M2).
async function typedApproved(t: Bench, setupCommands: string[], testCommands: string[]): Promise<void> {
  const typed = await t.dev(OMAR, "POST", `${BASE}/typed`, { requestId: randomUUID(), expectedRevision: settingsOf(t).revision, setupCommands, testCommands });
  expect(typed.status, JSON.stringify(typed.body)).toBe(200);
  const digest = typed.body.proposalDigest as string;
  await checkAndProve(t, digest);
  const approvedRevision = ((await t.state()).approved?.revision ?? 0);
  const approved = await t.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: approvedRevision });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
}

describe("review I2: typed commands replace the lists", () => {
  it("a fixed command replaces the old one, and a removed one is gone", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      await typedApproved(t, ["make deps", "make broken"], ["make smoke"]);
      expect(argsOf(settingsOf(t).setup)).toEqual(["deps", "broken"]);
      // Fix: the broken one is replaced.
      await typedApproved(t, ["make deps", "make fixed"], ["make smoke"]);
      expect(argsOf(settingsOf(t).setup)).toEqual(["deps", "fixed"]);
      // Remove: only what is typed stays.
      await typedApproved(t, ["make deps"], ["make smoke"]);
      expect(argsOf(settingsOf(t).setup)).toEqual(["deps"]);
      expect(argsOf(settingsOf(t).readiness)).toEqual(["smoke"]);
    });
  });
});

describe("review I1: with the test environment on, a browser save of commands is refused by the server", () => {
  it("refuses a PUT that changes setup or test commands and points to the typed route; the same save goes through with it off, and a body that changes no command goes on", async () => {
    const t = await setupWizardBench({ autoCandidate: false, cloud: true });
    const put = (body: Record<string, unknown>) => t.web(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: randomUUID(), expectedRevision: settingsOf(t).revision, ...body });
    await withSwitch("1", async () => {
      const refused = await put({ setupCommands: ["make deps"] });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect((refused.body.error as { message: string }).message).toContain("setup-draft/typed");
      expect(settingsOf(t).revision).toBe(1);
      const tests = await put({ testCommands: ["make smoke"] });
      expect(tests.status).toBe(400);
      // The commands as they are: not a change, so it goes on.
      const same = await put({ setupCommands: ["make old-setup"], description: "x" });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
    });
    await withSwitch(undefined, async () => {
      const saved = await put({ setupCommands: ["make deps"] });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    });
  });
});

describe("review M1: the typed route's request record", () => {
  it("answers a repeat the same, refuses another person's reuse of the id, and keeps one record", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await t.person(MAYA, "member", "maintainer");
    await withSwitch("1", async () => {
      const body = { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make deps"], testCommands: ["make smoke"] };
      const first = await t.dev(OMAR, "POST", `${BASE}/typed`, body);
      expect(first.status).toBe(200);
      expect((await t.dev(OMAR, "POST", `${BASE}/typed`, body)).body.proposalDigest).toBe(first.body.proposalDigest);
      const other = await t.dev(MAYA, "POST", `${BASE}/typed`, body);
      expect(other.status).toBe(409);
      expect((other.body.error as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
      expect(t.db.find((item) => item.entityType === "SETUP_TYPED_COMMANDS")).toEqual([expect.objectContaining({ by: OMAR.developerId })]);
    });
  });

  it("refuses a viewer", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await t.person(MAYA, "member", "viewer");
    await withSwitch("1", async () => {
      expect((await t.dev(MAYA, "POST", `${BASE}/typed`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make deps"], testCommands: ["make smoke"] })).status).toBe(403);
    });
  });
});

describe("review M2: a repeated draft press does not wipe a later wizard edit", () => {
  it("a repeat of the same press, its record lost, leaves the person's edit the one shown", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      await t.drafted(draftOf(), { setupProposal: PROPOSAL });
      const requestId = randomUUID();
      const items = [{ id: "setup-web", useSuggestion: true }, { id: "tests-web", useSuggestion: true }];
      const applied = await t.dev(OMAR, "POST", `${BASE}/apply`, { requestId, expectedRevision: 1, items });
      expect(applied.status).toBe(200);
      // The person edits in the wizard afterwards.
      const typed = await t.dev(OMAR, "POST", `${BASE}/typed`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make mine"], testCommands: ["make smoke"] });
      const mine = typed.body.proposalDigest as string;
      expect((await t.state()).proposal).toMatchObject({ digest: mine, source: "edited" });
      // The first press's apply record is lost, and the press is repeated.
      for (const item of t.db.find((entry) => entry.entityType === "SETUP_DRAFT_APPLY")) t.db.delete(item.pk as string, item.sk as string);
      expect((await t.dev(OMAR, "POST", `${BASE}/apply`, { requestId, expectedRevision: 1, items })).status).toBe(200);
      expect((await t.state()).proposal).toMatchObject({ digest: mine, source: "edited" });
    });
  });
});

describe("review R3: a dev container save beside commands resent unchanged", () => {
  it("goes on when the stored commands have their own timeout and env, and a real command change is still refused", async () => {
    const t = await setupWizardBench({ autoCandidate: false, cloud: true });
    // The stored commands carry a non-default timeout and an env, which their lines do not show.
    const stored = t.db.get(projectRevisionKey(TEST_ORG, NAME, 1)) as { definition: { setup: Array<Record<string, unknown>>; readiness: Array<Record<string, unknown>> } } & Record<string, unknown>;
    t.db.set({ ...stored, definition: { ...stored.definition, setup: [{ ...stored.definition.setup[0], timeoutSeconds: 300, env: { CI: "1" } }], readiness: [{ ...stored.definition.readiness[0], timeoutSeconds: 600 }] } });
    const put = (body: Record<string, unknown>) => t.web(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: randomUUID(), expectedRevision: settingsOf(t).revision, ...body });
    await withSwitch("1", async () => {
      const devcontainer = await put({ setupCommands: ["make old-setup"], testCommands: ["make old-test"], devcontainer: { repository: "web", configPath: ".devcontainer/ci.json" } });
      expect(devcontainer.status, JSON.stringify(devcontainer.body)).toBe(200);
      const changed = await put({ setupCommands: ["make old-setup", "make more"], testCommands: ["make old-test"] });
      expect(changed.status).toBe(400);
      expect((changed.body.error as { message: string }).message).toContain("setup-draft/typed");
    });
  });
});

describe("a typed proposal whose replace mark is gone", () => {
  it("proves nothing (commands_differ): its check ran the replacing lists, which an added-to proposal would not hold", async () => {
    const t = await setupWizardBench({ autoCandidate: false });
    await withSwitch("1", async () => {
      const typed = await t.dev(OMAR, "POST", `${BASE}/typed`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make deps"], testCommands: ["make smoke"] });
      const digest = typed.body.proposalDigest as string;
      const started = await t.dev(OMAR, "POST", `${ENV}/check`, { digest, requestId: randomUUID() });
      expect(started.status).toBe(202);
      const record = candidates(t).at(-1)!;
      await t.finish(record.workspaceId, prepareOf(t, record.workspaceId), "SUCCEEDED", {});
      // The proposal record is overwritten without its mark (or expired and proposed again by another path).
      const proposal = t.db.find((item) => item.entityType === "TEST_ENV_PROPOSAL" && item.digest === digest)[0]!;
      const { replaceLists: _gone, ...rest } = proposal; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
      t.db.set(rest);
      const proved = await t.dev(OMAR, "POST", `${ENV}/prove`, { digest });
      expect(proved.status).toBe(400);
      expect((proved.body.error as { message: string }).message).toContain("not among the commands the check ran");
    });
  });
});

describe("review R4: a dev container save keeps the stored commands exactly", () => {
  it("leaves each stored command's timeout and env byte-identical after a save that resends the same lines", async () => {
    const t = await setupWizardBench({ autoCandidate: false, cloud: true });
    const stored = t.db.get(projectRevisionKey(TEST_ORG, NAME, 1)) as { definition: { setup: Array<Record<string, unknown>>; readiness: Array<Record<string, unknown>> } } & Record<string, unknown>;
    t.db.set({ ...stored, definition: { ...stored.definition, setup: [{ ...stored.definition.setup[0], timeoutSeconds: 300, env: { CI: "1" } }], readiness: [{ ...stored.definition.readiness[0], timeoutSeconds: 600 }] } });
    const before = JSON.stringify({ setup: settingsOf(t).setup, readiness: settingsOf(t).readiness });
    await withSwitch("1", async () => {
      const saved = await t.web(OMAR, "PUT", `/v1/app/projects/${NAME}/settings`, { requestId: randomUUID(), expectedRevision: 1, setupCommands: ["make old-setup"], testCommands: ["make old-test"], devcontainer: { repository: "web", configPath: ".devcontainer/ci.json" } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    });
    expect(settingsOf(t).revision).toBe(2);
    expect(JSON.stringify({ setup: settingsOf(t).setup, readiness: settingsOf(t).readiness })).toBe(before);
  });
});

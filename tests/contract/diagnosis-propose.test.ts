// Live interaction F4: "Propose this change". A diagnosis never changes a setting; when a maintainer presses the button the broker reads everything again (the stored proposal against the allow-list and the
// deny-list, the person's role, `from` against the setting now, every citation against its source) and only then raises the change through the ORDINARY route, as that person, naming no more than the one setting.
import { randomUUID } from "node:crypto";
import { DIAGNOSIS_PREFILL_ALLOW as BROKER_ALLOW } from "@agentx/contracts"; // the package the broker itself imports
import { describe, expect, it } from "vitest";
import { DiagnosisProposalSchema, diagnosisKey, type CodeSettings, type DiagnosisProposal } from "../../packages/contracts/src/index.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { completeDiagnosis, startLightDiagnosis } from "../../packages/broker/src/diagnosis/light.js";
import { proposeDiagnosisChange, type DiagnosisProposePorts } from "../../packages/broker/src/diagnosis/propose.js";
import { ARJUN, MAX, ORG_A, PRIYA, diagnosisWorld, type DiagnosisWorld } from "../support/diagnosis-world.js";
import { MIA } from "../support/agent-session-world.js";

const COMMIT = "a".repeat(40);
const MERGE_QUOTE = "merge commit";
const answer = (value: unknown) => JSON.stringify(value);
const mergeChange = (extra: Record<string, unknown> = {}) => ({ kind: "settings_change", target: "code_settings", path: "mergeMethod", from: "squash", to: "merge", citations: [`doc:merge-method "${MERGE_QUOTE}"`], ...extra });
const deviceChange = (extra: Record<string, unknown> = {}) => ({ kind: "settings_change", target: "setup_item", path: "devcontainer.configPath", from: ".devcontainer/devcontainer.json", to: ".devcontainer/web/devcontainer.json", citations: [`repo:web:.devcontainer/web/devcontainer.json@${COMMIT} "image"`], ...extra });

function ports(overrides: Partial<{ mergeMethod: string; configPath: string | undefined; hasContainer: boolean; revision: number; file: (path: string) => string | undefined | Error; noReader: boolean; repositories: Array<{ name: string; url: string }> }> = {}) {
  const calls = { put: [] as unknown[][], update: [] as unknown[][], read: [] as unknown[][] };
  const settings: CodeSettings = { allowSelfApproval: false, mergeMethod: (overrides.mergeMethod ?? "squash") as "squash", codeReviewers: [], revision: 3 };
  const value: DiagnosisProposePorts = {
    project: async () => ({
      revision: overrides.revision ?? 5,
      ...(overrides.hasContainer === false ? {} : { devcontainer: { repository: "web", configPath: Object.hasOwn(overrides, "configPath") ? overrides.configPath : ".devcontainer/devcontainer.json" } }),
      repositories: overrides.repositories ?? [{ name: "web", url: "https://github.com/acme/web.git" }],
    }),
    codeSettings: async () => settings,
    putCodeSettings: async (...args) => { calls.put.push(args); return new StatusReply(200, {}); },
    updateSettings: async (...args) => { calls.update.push(args); return {}; },
    ...(overrides.noReader === true ? {} : { readFile: async (...args) => {
      calls.read.push(args);
      const read = (overrides.file ?? (() => 'the "image": "node:22" line'))(String(args[2]));
      if (read instanceof Error) throw read;
      return read;
    } }),
  };
  return { value, calls };
}

/** A ready light diagnosis whose answer holds the given proposals (read again by the broker as it is stored). */
async function ready(w: DiagnosisWorld, proposals: unknown[]) {
  const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
  await completeDiagnosis(w.diagnosis, { orgId: ORG_A, diagnosisId: status.diagnosisId, outcome: "ANSWERED", text: answer({ summary: "The settings are wrong.", proposals }) });
  return status.diagnosisId;
}
const propose = (w: DiagnosisWorld, p: DiagnosisProposePorts | undefined, id: string, who: string = MAX, index = 1, requestId: string = randomUUID()) =>
  proposeDiagnosisChange(w.diagnosis, p, w.w.caller(who), id, { requestId, index });
/** Writes a stored proposal exactly as given, bypassing the reading a real answer goes through (a record from older code, or a tampered one). */
function tamper(w: DiagnosisWorld, id: string, proposals: DiagnosisProposal[]): void {
  const key = diagnosisKey(ORG_A, id, "RECORD");
  const stored = w.w.db.get(key) as Record<string, unknown>;
  w.w.db.set({ ...stored, proposals: [{ kind: "explain", text: "x" }, ...proposals] });
  for (const proposal of proposals) expect(DiagnosisProposalSchema.safeParse(proposal).success).toBe(true);
}
const snapshot = (w: DiagnosisWorld): string => JSON.stringify([...w.w.db.items.entries()].sort(([a], [b]) => a.localeCompare(b)));

describe("raising a change through the ordinary route", () => {
  it("the merge method: the code-settings save, as the maintainer, under the revision just read, naming only the one setting; the diagnosis itself is unchanged", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, [mergeChange()]);
    const p = ports();
    const before = snapshot(w);
    const requestId = randomUUID();
    const reply = await propose(w, p.value, id, MAX, 1, requestId);
    expect(reply).toEqual({ diagnosisId: id, index: 1, target: "code_settings", outcome: "applied" });
    expect(p.calls.put).toHaveLength(1);
    expect(p.calls.put[0]![0]).toMatchObject({ developerId: MAX });
    expect(p.calls.put[0]![1]).toBe("web");
    expect(p.calls.put[0]![2]).toEqual({ requestId, expectedRevision: 3, mergeMethod: "merge" });
    expect(p.calls.update).toHaveLength(0);
    // The diagnosis and its records are exactly as they were (the audit aside); the press wrote nothing of its own.
    const diagnosisItems = (): string => JSON.stringify([...w.w.db.items.entries()].filter(([key]) => key.includes("DIAGNOSIS")).sort(([a], [b]) => a.localeCompare(b)));
    expect(diagnosisItems()).toBe(JSON.stringify((JSON.parse(before) as Array<[string, unknown]>).filter(([key]) => key.includes("DIAGNOSIS"))));
    const [event] = w.audit.recordedBy("diagnosis.proposal_raised");
    expect(event?.facts).toMatchObject({ proposalKind: "settings_change" });
    expect(JSON.stringify(w.audit.recorded())).not.toContain("merge commit");
  });

  it("the dev container path: the settings save, as the maintainer, marked as the agent's, keeping the container's repository and changing only the path", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, [deviceChange()]);
    const p = ports({ file: () => 'the "image": "node:22" line' });
    const requestId = randomUUID();
    await expect(propose(w, p.value, id, MAX, 1, requestId)).resolves.toMatchObject({ target: "setup_item", outcome: "applied" });
    expect(p.calls.update).toHaveLength(1);
    expect(p.calls.update[0]![1]).toBe("web");
    expect(p.calls.update[0]![2]).toEqual({ requestId, expectedRevision: 5, devcontainer: { repository: "web", configPath: ".devcontainer/web/devcontainer.json" } });
    expect(p.calls.update[0]![3]).toEqual({ origin: "agent" });
    expect(p.calls.put).toHaveLength(0);
    // The file was read again at the commit the citation names, through the repository's own address.
    expect(p.calls.read[0]!.slice(1, 4)).toEqual(["https://github.com/acme/web.git", ".devcontainer/web/devcontainer.json", COMMIT]);
  });

  it("passes the request id through unchanged, so the ordinary route's own repeat rule makes a repeat apply once", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, [mergeChange()]);
    const p = ports();
    const requestId = randomUUID();
    await propose(w, p.value, id, MAX, 1, requestId);
    await propose(w, p.value, id, MAX, 1, requestId);
    expect(p.calls.put.map((call) => (call[2] as { requestId: string }).requestId)).toEqual([requestId, requestId]);
  });
});

describe("refused, and nothing applied", () => {
  const refused = async (setup: (w: DiagnosisWorld) => Promise<string>, p: ReturnType<typeof ports>, who: string, expected: RegExp | { code: string }) => {
    const w = diagnosisWorld();
    const id = await setup(w);
    const before = snapshot(w);
    const attempt = propose(w, p.value, id, who);
    if (expected instanceof RegExp) await expect(attempt).rejects.toThrow(expected); else await expect(attempt).rejects.toMatchObject(expected);
    expect(p.calls.put).toHaveLength(0);
    expect(p.calls.update).toHaveLength(0);
    expect(snapshot(w)).toBe(before);
  };

  it("a stale `from`: the setting is no longer what the diagnosis saw", async () => {
    await refused((w) => ready(w, [mergeChange()]), ports({ mergeMethod: "merge" }), MAX, /out of date: the setting has changed/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ configPath: ".devcontainer.json" }), MAX, /out of date/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ hasContainer: false }), MAX, /out of date/u);
    // A change from "not set" is stale once the setting has a value.
    await refused((w) => ready(w, [deviceChange({ from: null })]), ports(), MAX, /out of date/u);
  });

  it("a citation that cannot be read again or does not hold: a quote that is not in the runbook, no file reader, a file that cannot be read, a quote not in the file, a repository the project does not have, and one bad citation among good ones", async () => {
    await refused((w) => ready(w, [mergeChange({ citations: ['doc:merge-method "this sentence is not in the runbook"'] })]), ports(), MAX, /did not find it/u);
    await refused((w) => ready(w, [mergeChange({ citations: ["doc:no-such-runbook"] })]), ports(), MAX, /did not find it/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ noReader: true }), MAX, /could not read again/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ file: () => new Error("GitHub is down") }), MAX, /could not read again/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ file: () => "nothing relevant here" }), MAX, /did not find it/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ file: () => undefined }), MAX, /did not find it/u);
    await refused((w) => ready(w, [deviceChange()]), ports({ repositories: [{ name: "api", url: "https://github.com/acme/api.git" }] }), MAX, /could not read again/u);
    await refused((w) => ready(w, [mergeChange({ citations: [`doc:merge-method "${MERGE_QUOTE}"`, `repo:web:README.md@${COMMIT} "absent"`] })]), ports({ file: () => "present" }), MAX, /did not find it/u);
  });

  it("a person who is not a maintainer of the project: the ordinary route would refuse them, and so does the press", async () => {
    await refused((w) => ready(w, [mergeChange()]), ports(), ARJUN, { code: "FORBIDDEN" });
    await refused((w) => ready(w, [mergeChange()]), ports(), PRIYA, { code: "FORBIDDEN" });
    await refused((w) => ready(w, [mergeChange()]), ports(), MIA, { code: "NOT_FOUND" });
  });

  it("whatever was stored: a proposal on the deny-list or off the allow-list is refused again at the press (secrets, budgets, roles, approval rules including tier-0, egress, model endpoints, MCP servers)", async () => {
    const paths = ["budget.monthlyUsd", "tierZero.auto", "tier0", "roles.admin", "approvals.required", "allowedDomains", "model.url", "toolServers", "env.GITHUB_PAT", "allowSelfApproval", "codeReviewers"];
    for (const path of paths) {
      await refused(async (w) => { const id = await ready(w, []); tamper(w, id, [mergeChange({ path }) as DiagnosisProposal]); return id; }, ports(), MAX, /not a change that can be proposed/u);
    }
    for (const target of ["playbook", "connector", "model_access"]) {
      await refused(async (w) => { const id = await ready(w, []); tamper(w, id, [mergeChange({ target }) as DiagnosisProposal]); return id; }, ports(), MAX, /not a change that can be proposed/u);
    }
    // A value that is not the kind the path takes, or looks like a secret, is refused too.
    await refused(async (w) => { const id = await ready(w, []); tamper(w, id, [mergeChange({ to: "rebase" }) as DiagnosisProposal]); return id; }, ports(), MAX, /not a change that can be proposed/u);
    await refused(async (w) => { const id = await ready(w, []); tamper(w, id, [deviceChange({ to: `ghp_${"a1B2".repeat(9)}` }) as DiagnosisProposal]); return id; }, ports(), MAX, /not a change that can be proposed/u);
  });

  it("each barrier holds on its own: if the allow-list were widened to a denied path the deny-list still refuses it, and to a path with no route into it the missing path still refuses it", async () => {
    const allow = BROKER_ALLOW as unknown as Record<string, Record<string, { kind: string; values?: string[] }>>;
    const denied = ["approvals.required", "tierZero.auto", "budget.monthlyUsd", "roles.admin", "model.url", "toolServers", "allowedDomains", "env.GITHUB_PAT"];
    try {
      for (const path of denied) allow["code_settings"]![path] = { kind: "boolean" };
      allow["playbook"]!["e2e.traces"] = { kind: "boolean" };
      for (const path of denied) {
        await refused(async (w) => { const id = await ready(w, []); tamper(w, id, [mergeChange({ path, from: false, to: true }) as DiagnosisProposal]); return id; }, ports(), MAX, /not a change that can be proposed/u);
      }
      await refused(async (w) => { const id = await ready(w, []); tamper(w, id, [mergeChange({ target: "playbook", path: "e2e.traces", from: false, to: true }) as DiagnosisProposal]); return id; }, ports(), MAX, /can't be proposed from here/u);
    } finally {
      for (const path of denied) delete allow["code_settings"]![path];
      delete allow["playbook"]!["e2e.traces"];
    }
  });

  it("not a settings change, a number that is not a proposal, a diagnosis that is not ready, one that is not there, a body that is not a request, and the switch off", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, [mergeChange(), { kind: "retry_with_note", note: "again" }]);
    const p = ports();
    await expect(propose(w, p.value, id, MAX, 0)).rejects.toThrow(/not a change that can be proposed/u);
    await expect(propose(w, p.value, id, MAX, 2)).rejects.toThrow(/not a change that can be proposed/u);
    await expect(propose(w, p.value, id, MAX, 7)).rejects.toThrow(/not a change that can be proposed/u);
    await expect(proposeDiagnosisChange(w.diagnosis, p.value, w.w.caller(MAX), id, { requestId: "no", index: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(proposeDiagnosisChange(w.diagnosis, p.value, w.w.caller(MAX), id, { requestId: randomUUID(), index: 1, mergeMethod: "merge" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(propose(w, p.value, "dgn_zzzzzzzzzzzzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(propose(w, undefined, id)).rejects.toThrow(/can't be proposed from here/u);
    await expect(proposeDiagnosisChange({ ...w.diagnosis, enabled: false }, p.value, w.w.caller(MAX), id, { requestId: randomUUID(), index: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const waiting = diagnosisWorld();
    const queued = await startLightDiagnosis(waiting.diagnosis, waiting.caller(PRIYA), { requestId: randomUUID(), errorRef: waiting.ref() });
    await expect(propose(waiting, p.value, queued.diagnosisId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(p.calls.put).toHaveLength(0);
  });
});

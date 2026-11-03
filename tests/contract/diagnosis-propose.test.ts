// Live interaction F4: "Apply this change". A diagnosis never changes a setting; when a maintainer presses the button the broker reads everything again (the stored proposal against the allow-list and the
// deny-list, the person's role, `from` against the setting now, every citation against its source) and only then raises the change through the ORDINARY route, as that person, naming no more than the one setting.
import { randomUUID } from "node:crypto";
import { DIAGNOSIS_PREFILL_ALLOW as BROKER_ALLOW } from "@agentx/contracts"; // the package the broker itself imports
import { describe, expect, it } from "vitest";
import { DEVCONTAINER_PATH_PATTERN, DIAGNOSIS_APPLY_BUTTON_LABEL, DIAGNOSIS_DEVCONTAINER_PATH_PATTERN, DiagnosisProposalSchema, diagnosisKey, type CodeSettings, type DiagnosisProposal } from "../../packages/contracts/src/index.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { completeDiagnosis, startLightDiagnosis } from "../../packages/broker/src/diagnosis/light.js";
import { proposeDiagnosisChange, type DiagnosisProposePorts } from "../../packages/broker/src/diagnosis/propose.js";
import { readDiagnosisRecord } from "../../packages/broker/src/diagnosis/store.js";
import { ARJUN, MAX, ORG_A, PRIYA, diagnosisWorld, type DiagnosisWorld } from "../support/diagnosis-world.js";
import { MIA } from "../support/agent-session-world.js";

const COMMIT = "a".repeat(40);
const MERGE_QUOTE = "merge commit";
const answer = (value: unknown) => JSON.stringify(value);
const mergeChange = (extra: Record<string, unknown> = {}) => ({ kind: "settings_change", target: "code_settings", path: "mergeMethod", from: "squash", to: "merge", citations: [`doc:merge-method "${MERGE_QUOTE}"`], ...extra });
const deviceChange = (extra: Record<string, unknown> = {}) => ({ kind: "settings_change", target: "setup_item", path: "devcontainer.configPath", from: ".devcontainer/devcontainer.json", to: ".devcontainer/web/devcontainer.json", citations: [`repo:web:.devcontainer/web/devcontainer.json@${COMMIT} "image"`], ...extra });

function ports(overrides: Partial<{ mergeMethod: string; configPath: string | undefined; hasContainer: boolean; revision: number; file: (path: string) => string | undefined | Error; noReader: boolean; repositories: Array<{ name: string; url: string }>; defaultBranchFile: (path: string) => string | undefined | Error; noDefaultBranchReader: boolean }> = {}) {
  const calls = { put: [] as unknown[][], update: [] as unknown[][], read: [] as unknown[][], defaultRead: [] as unknown[][] };
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
    ...(overrides.noDefaultBranchReader === true ? {} : { readDefaultBranchFile: async (...args: unknown[]) => {
      calls.defaultRead.push(args);
      const read = (overrides.defaultBranchFile ?? (() => '{ "image": "node:22" }'))(String(args[2]));
      if (read instanceof Error) throw read;
      return read;
    } }),
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
/** What the screen shows for the proposal at `index`: its target, path, from and to, as the person's press echoes them (DG-1 S3). A number that is not a settings change shows a placeholder. */
async function shownOf(w: DiagnosisWorld, id: string, index: number): Promise<{ target: string; path: string; from: unknown; to: unknown }> {
  const proposal = (await readDiagnosisRecord(w.diagnosis, ORG_A, id))?.proposals[index];
  return proposal?.kind === "settings_change" ? { target: proposal.target, path: proposal.path, from: proposal.from, to: proposal.to } : { target: "code_settings", path: "mergeMethod", from: "squash", to: "merge" };
}
const propose = async (w: DiagnosisWorld, p: DiagnosisProposePorts | undefined, id: string, who: string = MAX, index = 1, requestId: string = randomUUID(), shown?: Record<string, unknown>) =>
  proposeDiagnosisChange(w.diagnosis, p, w.w.caller(who), id, { requestId, index, ...(shown ?? await shownOf(w, id, index)) });
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
    // (the container's own repository is not one of the project's: the file check refuses first, with its own words)
    await refused((w) => ready(w, [deviceChange()]), ports({ repositories: [{ name: "api", url: "https://github.com/acme/api.git" }] }), MAX, /could not check/u);
    await refused((w) => ready(w, [mergeChange({ citations: [`repo:api:README.md@${COMMIT} "xyz"`] })]), ports({ repositories: [{ name: "web", url: "https://github.com/acme/web.git" }] }), MAX, /could not read again/u);
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
    const shown = await shownOf(w, id, 1);
    await expect(proposeDiagnosisChange(w.diagnosis, p.value, w.w.caller(MAX), id, { requestId: "no", index: 1, ...shown })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(proposeDiagnosisChange(w.diagnosis, p.value, w.w.caller(MAX), id, { requestId: randomUUID(), index: 1, ...shown, mergeMethod: "merge" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // DG-1 S3: a press that does not say what it is applying is not a press (an old client sending only the number).
    await expect(proposeDiagnosisChange(w.diagnosis, p.value, w.w.caller(MAX), id, { requestId: randomUUID(), index: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(propose(w, p.value, "dgn_zzzzzzzzzzzzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(propose(w, undefined, id)).rejects.toThrow(/can't be proposed from here/u);
    await expect(proposeDiagnosisChange({ ...w.diagnosis, enabled: false }, p.value, w.w.caller(MAX), id, { requestId: randomUUID(), index: 1, ...shown })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const waiting = diagnosisWorld();
    const queued = await startLightDiagnosis(waiting.diagnosis, waiting.caller(PRIYA), { requestId: randomUUID(), errorRef: waiting.ref() });
    await expect(propose(waiting, p.value, queued.diagnosisId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(p.calls.put).toHaveLength(0);
  });
});

describe("DG-1 S3: the press is bound to the change that was shown", () => {
  it("a press whose target, path, from or to differs from the stored proposal at that index applies nothing, even when the index is a different real proposal", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, [mergeChange(), deviceChange()]);
    const before = snapshot(w);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["the other proposal's change on this index", { target: "setup_item", path: "devcontainer.configPath", from: ".devcontainer/devcontainer.json", to: ".devcontainer/web/devcontainer.json" }],
      ["a different `to`", { ...(await shownOf(w, id, 1)), to: "squash" }],
      ["a different `from`", { ...(await shownOf(w, id, 1)), from: "merge" }],
      ["a different path", { ...(await shownOf(w, id, 1)), path: "devcontainer.configPath" }],
      ["a different target", { ...(await shownOf(w, id, 1)), target: "setup_item" }],
      ["`from` shown as unset", { ...(await shownOf(w, id, 1)), from: null }],
    ];
    for (const [label, shown] of cases) {
      const p = ports();
      await expect(propose(w, p.value, id, MAX, 1, randomUUID(), shown), label).rejects.toThrow(/not the one on record/u);
      expect(p.calls.put, label).toHaveLength(0);
      expect(p.calls.update, label).toHaveLength(0);
    }
    expect(snapshot(w)).toBe(before);
    // The same press with what the screen showed applies.
    const p = ports();
    await expect(propose(w, p.value, id, MAX, 1)).resolves.toMatchObject({ outcome: "applied" });
    expect(p.calls.put).toHaveLength(1);
  });
});

describe("DG-1 S2: the dev container path", () => {
  it("only a dev container path is ever stored as a proposal: any other relative file is dropped by the allow-list", async () => {
    for (const to of ["scripts/ci/devcontainer.json", "package.json", ".devcontainer/a/b/devcontainer.json", ".devcontainer/web/other.json", "devcontainer.json"]) {
      const w = diagnosisWorld();
      const id = await ready(w, [deviceChange({ to })]);
      const record = await readDiagnosisRecord(w.diagnosis, ORG_A, id);
      expect(record?.proposals.some((proposal) => proposal.kind === "settings_change"), to).toBe(false);
    }
    const w = diagnosisWorld();
    const id = await ready(w, [deviceChange({ to: ".devcontainer.json" })]);
    expect((await readDiagnosisRecord(w.diagnosis, ORG_A, id))?.proposals.some((proposal) => proposal.kind === "settings_change")).toBe(true);
  });

  it("and the press refuses a stored proposal that names another file (a record from older code), whatever its citation says", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, []);
    tamper(w, id, [deviceChange({ to: "scripts/ci/devcontainer.json", citations: [`repo:web:scripts/ci/devcontainer.json@${COMMIT} "image"`] }) as DiagnosisProposal]);
    const p = ports();
    await expect(propose(w, p.value, id)).rejects.toThrow(/not a change that can be proposed/u);
    expect(p.calls.update).toHaveLength(0);
  });

  it("the file must be in the container's repository on its default branch now: missing, unreadable, no reader and an unknown repository all refuse, and the right one applies", async () => {
    const attempt = async (p: ReturnType<typeof ports>, expected: RegExp) => {
      const w = diagnosisWorld();
      const id = await ready(w, [deviceChange()]);
      await expect(propose(w, p.value, id)).rejects.toThrow(expected);
      expect(p.calls.update).toHaveLength(0);
    };
    await attempt(ports({ defaultBranchFile: () => undefined }), /isn't in the repository/u);
    await attempt(ports({ defaultBranchFile: () => new Error("GitHub is down") }), /could not check/u);
    await attempt(ports({ noDefaultBranchReader: true }), /could not check/u);
    await attempt(ports({ repositories: [{ name: "api", url: "https://github.com/acme/api.git" }] }), /could not check/u);
    const w = diagnosisWorld();
    const id = await ready(w, [deviceChange()]);
    const p = ports();
    await expect(propose(w, p.value, id)).resolves.toMatchObject({ outcome: "applied" });
    expect(p.calls.defaultRead[0]!.slice(1, 3)).toEqual(["https://github.com/acme/web.git", ".devcontainer/web/devcontainer.json"]);
  });

  it("the merge method needs no file", async () => {
    const w = diagnosisWorld();
    const id = await ready(w, [mergeChange()]);
    const p = ports({ noDefaultBranchReader: true });
    await expect(propose(w, p.value, id)).resolves.toMatchObject({ outcome: "applied" });
  });
});

describe("DG-2: the button says what it does", () => {
  it("the press applies at once as the maintainer's own save, so the button is \"Apply this change\"; the old words are gone from the code that names it", () => {
    expect(DIAGNOSIS_APPLY_BUTTON_LABEL).toBe("Apply this change");
    expect(DIAGNOSIS_APPLY_BUTTON_LABEL).not.toMatch(/propose/iu);
  });
  it("SK-4: the dev container path pattern accepts the places a dev container lives and refuses `.`/`..` segments, absolute paths and anything else (both copies)", () => {
    const good = [".devcontainer/devcontainer.json", ".devcontainer.json", ".devcontainer/node/devcontainer.json", ".devcontainer/a.b-c_d/devcontainer.json", ".devcontainer/.hidden/devcontainer.json", ".devcontainer/v1.2/devcontainer.json"];
    const bad = [
      ".devcontainer/../devcontainer.json", ".devcontainer/./devcontainer.json", ".devcontainer/.../devcontainer.json", ".devcontainer/../../etc/devcontainer.json", ".devcontainer/a/../devcontainer.json",
      "../.devcontainer/devcontainer.json", "/.devcontainer/devcontainer.json", "/devcontainer.json", "/etc/passwd", "devcontainer.json", "src/.devcontainer.json", ".devcontainer/a/b/devcontainer.json",
      ".devcontainer/devcontainer.json\n", ".devcontainer//devcontainer.json", ".devcontainer\\..\\devcontainer.json", "",
    ];
    for (const pattern of [DEVCONTAINER_PATH_PATTERN, DIAGNOSIS_DEVCONTAINER_PATH_PATTERN]) {
      for (const path of good) expect(pattern.test(path), path).toBe(true);
      for (const path of bad) expect(pattern.test(path), JSON.stringify(path)).toBe(false);
    }
  });
  it("the browser-safe copy of the dev container pattern is the setup proposal's own", () => {
    expect(DIAGNOSIS_DEVCONTAINER_PATH_PATTERN.source).toBe(DEVCONTAINER_PATH_PATTERN.source);
    expect(DIAGNOSIS_DEVCONTAINER_PATH_PATTERN.flags).toBe(DEVCONTAINER_PATH_PATTERN.flags);
  });
});

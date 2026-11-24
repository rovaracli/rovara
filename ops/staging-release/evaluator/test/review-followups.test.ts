/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// Follow-ups of the Opus review (REVIEW-OPUS-P8-4ea25ef82): rollback range checks (D manual list + K), the audit backlog never blocks a rollback, and hardening H1 to H5, plus F2 (no home path in the tree).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluate.ts";
import { NEW, SHA, WEB, GWS, cloudInput, codeInput, hex, param, stackIn, uri, rowIn, detail } from "./fixtures.ts";
import { attack, auto, manual } from "./helpers.ts";

const rollbackInput = (): Record<string, any> => {
  const i = codeInput();
  i.trigger = { kind: "rollback", variables: {}, rollback: { lastGoodSha: SHA, floorAncestry: {}, targetIsAncestorOfInstalled: true, priorAutoRollbacksThisHold: 0 } };
  i.holdParameters = ["/rovara-release/staging/code-hold/rollback"];
  return i;
};
const NOTES = "docs/release-notes/0.5.49.md";
const withNotes = (i: Record<string, any>, text: string | null): void => {
  i.changedPaths.push(NOTES);
  i.releaseNotes = [{ path: NOTES, text }];
};

describe("rollback: D's manual list and K run over the range being undone; B, C, J are skipped", () => {
  it("a routine rollback is AUTO", () => { auto(rollbackInput()); });
  for (const path of ["packages/x/migrations/001.sql", "scripts/backfill-feedback.ts", "docs/release-steps/0.5.49.md", "package.json", ".github/workflows/ci.yml", "ops/staging-release/policy/manual-paths.txt", "environments/base/Dockerfile"]) {
    it(`a rollback across ${path} is MANUAL`, () => { const i = rollbackInput(); i.changedPaths.push(path); manual(i, "manual-path", "D"); });
  }
  it("the reason says the path is inside the range a rollback would undo", () => { const i = rollbackInput(); i.changedPaths.push("packages/x/migrations/001.sql"); const d = manual(i, "manual-path", "D"); expect(d.reasons.some((r) => r.message.includes("range a rollback would undo"))).toBe(true); });
  it("a rollback across a requires: marker is MANUAL", () => { const i = rollbackInput(); withNotes(i, "requires: erase backfill (dry run first)\n"); manual(i, "requires-marker", "K"); });
  it("a rollback across a malformed marker is MANUAL", () => { const i = rollbackInput(); withNotes(i, "Requires: x\n"); manual(i, "requires-malformed", "K"); });
  it("a rollback across release notes without a marker is AUTO", () => { const i = rollbackInput(); withNotes(i, "# 0.5.49\nRoutine.\n"); auto(i); });
  it("a rollback whose range has a missing release-notes text is MANUAL", () => { const i = rollbackInput(); i.changedPaths.push(NOTES); manual(i, "notes-missing", "K"); });
  it("the allow-list does not apply to a rollback range (an unknown path is fine)", () => { const i = rollbackInput(); i.changedPaths.push("weird/thing.bin"); auto(i); });
  it("the same unknown path in a push run is MANUAL", () => attack(codeInput, (i) => { i.changedPaths.push("weird/thing.bin"); }, "unknown-path", "D"));
  it("gates, CI and the lock are skipped on a rollback", () => {
    const i = rollbackInput();
    i.gates = [];
    i.ci = { apiError: "down", runs: [] };
    i.changedPaths.push("package-lock.json");
    auto(i);
  });
  it("an unsafe path in the range still fails closed", () => { const i = rollbackInput(); i.changedPaths.push("../x"); manual(i, "path-invalid"); });
});

describe("the audit backlog never blocks an automatic rollback", () => {
  it("a rollback with 99 unaudited runs is AUTO and raises an alert", () => {
    const i = rollbackInput();
    i.unauditedAutoRuns = 99;
    const d = auto(i);
    expect(d.alerts.map((a) => a.code)).toEqual(["audit-backlog-rollback-allowed"]);
    expect(d.alerts[0]?.message).toContain("99");
  });
  it("a rollback at the limit raises no alert", () => { const i = rollbackInput(); i.unauditedAutoRuns = 3; expect(auto(i).alerts).toEqual([]); });
  it("a push with a backlog is still MANUAL and carries no alert", () => { const d = attack(codeInput, (i) => { i.unauditedAutoRuns = 4; }, "audit-backlog", "A"); expect(d.alerts).toEqual([]); });
  it("a rollback that is MANUAL for another reason still reports the alert", () => { const i = rollbackInput(); i.unauditedAutoRuns = 9; i.holdParameters = []; const d = manual(i, "no-hold", "P-RB"); expect(d.alerts).toHaveLength(1); });
  it("every decision carries an alerts array", () => { expect(evaluate(null).alerts).toEqual([]); expect(auto(codeInput()).alerts).toEqual([]); });
});

describe("H1: answers / overrides image values are exact", () => {
  const set = (i: Record<string, any>, value: string): void => { i.answers.current = JSON.stringify({ company: "x", images: { worker: value, slack: i.answers.current && JSON.parse(i.answers.current).images.slack } }); };
  it("another account with a verified digest", () => attack(codeInput, (i) => set(i, `999999999999.dkr.ecr.us-east-1.amazonaws.com/evil@${NEW.worker}`), "answers-image", "E"));
  it("this account but another region", () => attack(codeInput, (i) => set(i, `111111111111.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/worker@${NEW.worker}`), "answers-image", "E"));
  it("this account and region but another repo", () => attack(codeInput, (i) => set(i, uri("evil/repo", NEW.worker)), "answers-image", "E"));
  it("the right URI with text appended", () => attack(codeInput, (i) => set(i, `${uri("agentx-staging/worker", NEW.worker)}#x`), "answers-image", "E"));
  it("the digest with text around it", () => attack(codeInput, (i) => set(i, `x${NEW.worker}`), "answers-image", "E"));
  it("an unverified digest", () => attack(codeInput, (i) => set(i, uri("agentx-staging/worker", `sha256:${hex("7", 64)}`)), "answers-image", "E"));
  it("a non-string value", () => attack(codeInput, (i) => { i.answers.current = JSON.stringify({ company: "x", images: { worker: 5, slack: uri("agentx-staging/slack", NEW.slack) } }); }, "answers-image", "E"));
  it("a verified image URI is fine, and so is a bare verified digest (cloud)", () => { auto(codeInput()); auto(cloudInput()); });
});

describe("H2: the change-set envelope is an allow-list", () => {
  const cs = (i: Record<string, any>): Record<string, any> => stackIn(i, "agentx-staging-control-plane").changeSet;
  it("an unknown top-level field", () => attack(codeInput, (i) => { cs(i).Surprise = 1; }, "changeset-envelope", "F"));
  it("notification targets", () => attack(codeInput, (i) => { cs(i).NotificationARNs = ["arn:aws:sns:us-west-2:111111111111:x"]; }, "changeset-envelope", "F"));
  it("rollback triggers", () => attack(codeInput, (i) => { cs(i).RollbackConfiguration = { RollbackTriggers: [{ Arn: "a", Type: "AWS::CloudWatch::Alarm" }] }; }, "changeset-envelope", "F"));
  it("OnStackFailure set", () => attack(codeInput, (i) => { cs(i).OnStackFailure = "DO_NOTHING"; }, "changeset-envelope", "F"));
  it("import of existing resources", () => attack(codeInput, (i) => { cs(i).ImportExistingResources = true; }, "changeset-envelope", "F"));
  it("a deployment mode", () => attack(codeInput, (i) => { cs(i).DeploymentMode = "REVERT_DRIFT"; }, "changeset-envelope", "F"));
  it("a non-standard deployment config", () => attack(codeInput, (i) => { cs(i).DeploymentConfig = { Mode: "STANDARD", DisableRollback: true }; }, "changeset-envelope", "F"));
  it("the real envelope shape is accepted", () => {
    const i = codeInput();
    Object.assign(cs(i), { ChangeSetName: "x", StackName: "s", Description: "d", NotificationARNs: [], RollbackConfiguration: {}, Tags: [{ Key: "agentx:env", Value: "staging" }], ParentChangeSetId: null, RootChangeSetId: null, OnStackFailure: null, ImportExistingResources: null, StackDriftStatus: null, DeploymentMode: null, DeploymentConfig: { Mode: "STANDARD", DisableRollback: false }, IncludeNestedStacks: false });
    auto(i);
  });
});

describe("H3: a parameter's value and its resolved value must both stay put", () => {
  const ssm = (i: Record<string, any>, liveRaw: string, liveRes: string, newRaw: string, newRes: string): void => {
    const s = stackIn(i, "agentx-staging-control-plane");
    s.liveParameters.push({ ParameterKey: "Ssm", ParameterValue: liveRaw, ResolvedValue: liveRes });
    s.changeSet.Parameters.push({ ParameterKey: "Ssm", ParameterValue: newRaw, ResolvedValue: newRes });
    s.liveTemplate.Parameters.Ssm = { Type: "AWS::SSM::Parameter::Value<String>" };
    s.newTemplate.Parameters.Ssm = { Type: "AWS::SSM::Parameter::Value<String>" };
  };
  it("the SSM path moves while it resolves to the same value", () => attack(codeInput, (i) => ssm(i, "/a/path", "v", "/b/path", "v"), "param-changed", "E"));
  it("the resolved value moves", () => attack(codeInput, (i) => ssm(i, "/a/path", "v", "/a/path", "w"), "param-changed", "E"));
  it("nothing moves", () => { const i = codeInput(); ssm(i, "/a/path", "v", "/a/path", "v"); auto(i); });
  it("UsePreviousValue is not a change", () => { const i = codeInput(); ssm(i, "/a/path", "v", "/a/path", "v"); const p = stackIn(i, "agentx-staging-control-plane").changeSet.Parameters.at(-1); delete p.ParameterValue; delete p.ResolvedValue; p.UsePreviousValue = true; auto(i); });
});

describe("H4: unicode forms of the requires marker", () => {
  const notes = (text: string) => (i: Record<string, any>): void => withNotes(i, text);
  for (const [name, text] of [
    ["a full-width colon", "requires： backfill"],
    ["full-width letters", "ｒｅｑｕｉｒｅｓ: backfill"],
    ["a zero-width space before the colon", "requires​: backfill"],
    ["a zero-width space inside the word", "requ​ires: backfill"],
    ["a byte-order mark first", "﻿requires: backfill"],
  ] as const) {
    it(`${name} is caught`, () => attack(codeInput, notes(text), undefined, "K"));
  }
  it("plain prose is still not a marker", () => { const i = codeInput(); withNotes(i, "this requires a restart\n"); auto(i); });
});

describe("H5: R5 checks the detail path too", () => {
  const r5 = (i: Record<string, any>): Record<string, any> => rowIn(i, "rovara-cloud-staging-web", "AppFilesCustomResource512MiBE2CB5759");
  it("a SourceObjectKeys detail on another property path", () => attack(cloudInput, (i) => { r5(i).Details[0].Target.Path = "/Properties/DestinationBucketName"; }, "row-rejected", "F"));
  it("a detail without a path", () => attack(cloudInput, (i) => { delete r5(i).Details[0].Target.Path; }, "row-rejected", "F"));
  it("a SourceMarkers detail under a deeper path is fine", () => { const i = cloudInput(); r5(i).Details.push(detail("Properties", "SourceMarkers", "/Properties/SourceMarkers/0/x", "DirectModification", "Static")); auto(i); });
  it("a path that only shares a prefix", () => attack(cloudInput, (i) => { r5(i).Details[0].Target.Path = "/Properties/SourceObjectKeysEvil"; }, "row-rejected", "F"));
});

describe("F2: no home path in this tree", () => {
  const source = readFileSync(new URL("./real-previews.test.ts", import.meta.url), "utf8");
  it("real-previews.test.ts reads only the RELEASE_ARTIFACTS env var", () => {
    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/\/home\//);
    expect(source).toContain("process.env.RELEASE_ARTIFACTS");
    expect(source).not.toMatch(/RELEASE_ARTIFACTS \?\?/);
    expect(source).toContain("is not set; skipped");
  });
});

void [param, WEB, GWS];

describe("invisible characters in release notes (Opus delta review): fail closed", () => {
  const CHARS: [string, string][] = [
    ["U+3164 HANGUL FILLER", "ㅤ"], ["U+115F HANGUL CHOSEONG FILLER", "ᅟ"], ["U+1160 HANGUL JUNGSEONG FILLER", "ᅠ"], ["U+FFA0 HALFWIDTH HANGUL FILLER", "ﾠ"],
    ["U+2800 BRAILLE PATTERN BLANK", "⠀"], ["U+180E MONGOLIAN VOWEL SEPARATOR", "᠎"], ["U+200B ZERO WIDTH SPACE", "​"], ["U+2060 WORD JOINER", "⁠"],
    ["U+00AD SOFT HYPHEN", "­"], ["U+034F COMBINING GRAPHEME JOINER", "͏"], ["U+FE0F VARIATION SELECTOR-16", "️"], ["U+FEFF BYTE ORDER MARK", "﻿"], ["U+202E RIGHT-TO-LEFT OVERRIDE", "‮"],
  ];
  for (const [name, ch] of CHARS) {
    for (const [where, text] of [["inside the word", `requ${ch}ires: x`], ["before the colon", `requires${ch}: x`], ["after the colon", `requires:${ch}x`], ["around the marker", `${ch}requires: x${ch}`], ["on its own line", `ok\n${ch}\nok`], ["in plain prose", `a ${ch} b`]] as const) {
      it(`${name} ${where} is MANUAL`, () => { const i = codeInput(); withNotes(i, text); manual(i, undefined, "K"); });
    }
  }
  it("the reason names the character problem, with the file and line", () => { const i = codeInput(); withNotes(i, `ok\nrequㅤires: x`); const d = manual(i, "notes-invisible-char", "K"); expect(d.reasons.some((r) => r.message.includes(`${NOTES}:2`))).toBe(true); });
  it("a hidden marker is still reported as a marker too", () => { const i = codeInput(); withNotes(i, "requires​: x"); manual(i, "requires-marker", "K"); });
  it("ordinary notes with accents, CJK and emoji (no invisible characters) stay AUTO", () => { const i = codeInput(); withNotes(i, "# 0.5.49 — café 日本語 🚀 routine\n"); auto(i); });
  it("rollback ranges get the same check", () => { const i = rollbackInput(); withNotes(i, "requㅤires: x"); manual(i, "notes-invisible-char", "K"); });
});

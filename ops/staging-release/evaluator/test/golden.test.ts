/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// GOLDEN cases from lane P0 (golden-cases.json: 20 past staging releases and the verdict the amended policy must give).
// The file records each release's rows and Details (attribute, name, path, source, evaluation, causing entity) and counts of metadata-only rows, but not values, templates or parameters.
// This adapter therefore SYNTHESIZES the missing parts consistently (values, live and new templates, parameters, images, gates, CI) from the recorded shapes, and runs the real evaluator on the result.
// The file is a checked-in fixture (fixtures/golden-cases.json, copied from lane P0; scanned: no account ids, ARNs, secrets or hostnames, only the <acct> placeholder). If it is missing the tests FAIL.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluate, type Decision } from "../src/evaluate.ts";
import { ACCT, CP, GWS, KNOWN, NEW, OLD, RT, SL, WEB, cloudInput, codeInput, codeKey, detail, hex, imageEntry, param, policyDocument, row, stackFixture, uri, type Obj, type StackFixture } from "./fixtures.ts";

const GOLDEN_PATH = fileURLToPath(new URL("../fixtures/golden-cases.json", import.meta.url));

interface GRow { stack: string; logicalId?: string; type?: string; action?: string; replacement: string | null; scope: string[]; details: Obj[]; ruleAmended?: string; metadataOnlyModifyRowsByType?: Record<string, number> }
interface GCase { id: string; repo: string; manualPathHits: string[]; rows: GRow[]; stacksEvaluated: Record<string, { nonResourceSectionsDiffer?: string[] }>; expectedVerdictAmended: "AUTO" | "MANUAL"; rulesUsedAmended: Record<string, number>; otherFacts?: Record<string, string>; amendedRowFailures: Obj[] }

const META = ["aws:cdk:path", "aws:asset:path", "aws:asset:is-bundled", "aws:asset:property"];

function realDetails(g: Obj[], values: (d: Obj) => Obj): Obj[] {
  return g.map((d) => {
    if (d.attribute === "Metadata") return detail("Metadata", null, d.path, d.changeSource, d.evaluation, { AttributeChangeType: "Remove" });
    return detail(d.attribute, d.name ?? null, d.path ?? null, d.changeSource, d.evaluation, { ...values(d), ...(d.causingEntity === undefined ? {} : { CausingEntity: d.causingEntity }) });
  });
}

function build(c: GCase): Obj {
  const code = c.repo.startsWith("Rovara (Code)");
  const input = code ? codeInput() : cloudInput();
  const stacks: StackFixture[] = [];
  const has = (rule: string): boolean => c.rows.some((r) => r.ruleAmended === rule);
  const wUri = (d: string): string => uri("agentx-staging/worker", d);
  for (const [stackName, info] of Object.entries(c.stacksEvaluated)) {
    const live: Obj = {};
    const next: Obj = {};
    const changes: Obj[] = [];
    let liveParams: Obj[] = [];
    let csParams: Obj[] = [];
    let templateParams: Obj = {};
    const rows = c.rows.filter((r) => r.stack === stackName);
    for (const r of rows) {
      if (r.metadataOnlyModifyRowsByType !== undefined) {
        let n = 0;
        for (const [type, count] of Object.entries(r.metadataOnlyModifyRowsByType)) {
          for (let k = 0; k < count; k += 1) {
            const id = `Meta${type.replace(/\W/g, "")}${n++}`;
            live[id] = { Type: type, Properties: {}, Metadata: { "aws:cdk:path": id } };
            next[id] = { Type: type, Properties: {} };
            changes.push(row(id, type, "Modify", "False", ["Metadata"], META.map((k2) => detail("Metadata", null, `/Metadata/${k2}`, "DirectModification", "Static", { AttributeChangeType: "Remove" }))));
          }
        }
        continue;
      }
      const id = r.logicalId as string;
      const type = r.type as string;
      const rule = r.ruleAmended ?? "";
      const withMeta = r.details.some((d) => d.attribute === "Metadata");
      const addMeta = (res: Obj): Obj => ({ ...res, ...(withMeta ? { Metadata: { "aws:cdk:path": id } } : {}) });
      if (rule === "R8") {
        live[id] = { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v2:x" }, Condition: "CDKMetadataAvailable" };
        changes.push(row(id, type, r.action as string, null, [], []));
      } else if (rule === "R1" || rule === "R6") {
        live[id] = addMeta({ Type: type, Properties: { Code: { S3Bucket: "cdk-assets", S3Key: codeKey("1") }, Handler: "h" } });
        next[id] = { Type: type, Properties: { Code: { S3Bucket: "cdk-assets", S3Key: codeKey("2") }, Handler: "h" } };
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ BeforeValue: codeKey("1"), AfterValue: codeKey("2") }))));
      } else if (rule === "R-SIGNKEY") {
        const res = { Type: type, Properties: { Name: "n", SecretString: { Ref: "CallbackSigningKey" } }, DeletionPolicy: "RetainExceptOnCreate", UpdateReplacePolicy: "Retain" };
        live[id] = addMeta(res);
        next[id] = res;
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ BeforeValue: "****", AfterValue: "****" }))));
      } else if (rule === "R2") {
        live[id] = addMeta({ Type: type, Properties: { Type: "String", Value: { Ref: "WorkerImageUri" } } });
        next[id] = { Type: type, Properties: { Type: "String", Value: { Ref: "WorkerImageUri" } } };
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ BeforeValue: wUri(OLD.worker), AfterValue: wUri(NEW.worker) }))));
      } else if (rule === "R3") {
        const slack = stackName === SL;
        const truncated = r.details.some((d) => d.path === "/Properties/ContainerDefinitions");
        const image = slack ? { Ref: "OrchestratorImageUri" } : { "Fn::Join": ["", [{ Ref: "AWS::AccountId" }, ".dkr.ecr.us-west-2.amazonaws.com/rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc@", { Ref: "ImageDigest" }]] };
        const res = { Type: type, Properties: { Family: id, ContainerDefinitions: [{ Name: "c", Image: image, Environment: [{ Name: "A", Value: "1" }] }] } };
        live[id] = addMeta(res);
        next[id] = res;
        const repo = slack ? "agentx-staging/slack" : "rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc";
        const after = uri(repo, slack ? NEW.slack : NEW.gateway);
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => (truncated ? { BeforeValue: "(Truncated-Signature):aa", AfterValue: "(Truncated-Signature):bb" } : { BeforeValue: uri(repo, slack ? OLD.slack : OLD.gateway), AfterValue: after })), { PolicyAction: "ReplaceAndDelete" }));
      } else if (rule === "R4") {
        const cause = r.details.find((d) => d.causingEntity !== undefined)?.causingEntity as string;
        const res = { Type: type, Properties: { TaskDefinition: { Ref: cause }, DesiredCount: 1 } };
        live[id] = addMeta(res);
        next[id] = res;
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ AfterValue: KNOWN }))));
      } else if (rule === "R4b") {
        const cause = r.details.find((d) => d.causingEntity !== undefined)?.causingEntity as string;
        const res = { Type: type, Properties: { ScheduleExpression: "rate(1 day)", Targets: [{ Arn: "a", EcsParameters: { TaskDefinitionArn: { Ref: cause } } }] } };
        live[id] = addMeta(res);
        next[id] = res;
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ AfterValue: KNOWN }))));
      } else if (rule === "E1") {
        const n = Number(/Statement\/(\d+)\//.exec(r.details[0]?.path ?? "")?.[1] ?? "1");
        const doc = policyDocument();
        const runTask = doc.Statement[1];
        doc.Statement = Array.from({ length: Math.max(n + 1, 3) }, (_, k) => (k === n ? { ...runTask, Resource: { Ref: "PriceFetchTask7EDA4B48" } } : { Effect: "Allow", Action: `x:Do${k}`, Resource: "*" }));
        const res = { Type: type, Properties: { PolicyName: "p", PolicyDocument: doc, Roles: [{ Ref: "R" }] } };
        live[id] = res;
        next[id] = JSON.parse(JSON.stringify(res)) as Obj;
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ AfterValue: KNOWN }))));
      } else if (rule === "R5") {
        const res = (k: string): Obj => ({ Type: type, Properties: { SourceBucketNames: ["b"], SourceObjectKeys: [codeKey(k)], DestinationBucketName: "web" } });
        live[id] = res("7");
        next[id] = res("8");
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ BeforeValue: codeKey("7"), AfterValue: codeKey("8") }))));
      } else if (r.action === "Add") {
        next[id] = { Type: type, Properties: {} };
        changes.push(row(id, type, "Add", null, [], []));
      } else {
        // A row no rule covers (the IAM ServeTask policy change, the API Gateway stage RouteSettings): a real property change.
        live[id] = addMeta({ Type: type, Properties: { Doc: "a", RouteSettings: {} } });
        next[id] = { Type: type, Properties: { Doc: "b", RouteSettings: { "GET /": { ThrottlingRateLimit: 1 } } } };
        changes.push(row(id, type, "Modify", r.replacement, r.scope, realDetails(r.details, () => ({ BeforeValue: "a", AfterValue: "b" }))));
      }
    }
    if (code) {
      if (stackName === CP) {
        liveParams = [param("CallbackSigningKey", "****"), param("StageName", "staging")];
        csParams = [param("CallbackSigningKey", "****"), param("StageName", "staging")];
        templateParams = { CallbackSigningKey: { Type: "String", NoEcho: true }, StageName: { Type: "String" } };
      } else if (stackName === RT) {
        liveParams = [param("WorkerImageUri", wUri(OLD.worker))];
        csParams = [param("WorkerImageUri", wUri(has("R2") ? NEW.worker : OLD.worker))];
        templateParams = { WorkerImageUri: { Type: "String" } };
      } else if (stackName === SL) {
        const changed = rows.some((r) => r.ruleAmended === "R3");
        liveParams = [param("OrchestratorImageUri", uri("agentx-staging/slack", OLD.slack)), param("ExecutorImageUri", "none")];
        csParams = [param("OrchestratorImageUri", uri("agentx-staging/slack", changed ? NEW.slack : OLD.slack)), param("ExecutorImageUri", "none")];
        templateParams = { OrchestratorImageUri: { Type: "String" }, ExecutorImageUri: { Type: "String" } };
      }
    } else if (stackName === GWS) {
      liveParams = [param("ImageDigest", OLD.gateway)];
      csParams = [param("ImageDigest", rows.some((r) => r.ruleAmended === "R3") ? NEW.gateway : OLD.gateway)];
      templateParams = { ImageDigest: { Type: "String" } };
    }
    const differsConditions = (info.nonResourceSectionsDiffer ?? []).includes("Conditions");
    if (changes.some((ch) => ch.ResourceChange.ResourceType === "AWS::CDK::Metadata") || differsConditions) {
      // the preview synth has no CDKMetadataAvailable condition; the live template does
    }
    stacks.push(stackFixture(stackName, {
      live, next, changes, liveParams, csParams, templateParams,
      ...(differsConditions ? { liveConditions: { CDKMetadataAvailable: { "Fn::Equals": [{ Ref: "AWS::Region" }, "us-west-2"] } }, newConditions: {} } : {}),
    }));
  }
  input.stacks = stacks;
  input.images = [imageEntry("agentx-staging/worker", NEW.worker), imageEntry("agentx-staging/slack", NEW.slack), imageEntry("rovara-cloud-staging-gateway-images-images2d38c313-pkjfxof4rizc", NEW.gateway)];
  input.changedPaths = ["packages/web/src/a.ts", "tests/unit/a.test.ts", ...c.manualPathHits];
  const facts = Object.values(c.otherFacts ?? {}).join(" | ");
  if (/46- marker missing/.test(facts)) input.gates = input.gates.filter((g: Obj) => g.name !== "46-gate");
  if (/ci-missing/.test(facts)) input.ci.runs = [];
  if (/CI failure/.test(facts)) input.ci.runs[0].conclusion = "failure";
  if (/sha not on cloud\/next/.test(facts)) input.ancestry.installedIsAncestorOfSha = false;
  void ACCT; void WEB; void hex;
  return input;
}

// Read at load: a missing or unreadable fixture throws here and fails the whole file (never a skip).
const cases: GCase[] = (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { cases: GCase[] }).cases;

describe("golden cases from lane P0 (20 past releases)", () => {
  it("the golden fixture holds the 20 cases", () => {
    expect(cases).toHaveLength(20);
  });
  it("13 of 20 are AUTO and 7 are MANUAL", () => {
    const verdicts = cases.map((c) => evaluate(build(c)).verdict);
    expect(verdicts.filter((v) => v === "AUTO")).toHaveLength(13);
    expect(verdicts.filter((v) => v === "MANUAL")).toHaveLength(7);
  });
  for (const c of cases) {
    it(`${c.id}: ${c.expectedVerdictAmended}`, () => {
      const d: Decision = evaluate(build(c));
      expect(d.verdict, JSON.stringify(d.reasons.slice(0, 6))).toBe(c.expectedVerdictAmended);
      const codes = d.reasons.map((r) => r.code);
      if (c.expectedVerdictAmended === "AUTO") {
        expect(d.reasons).toEqual([]);
        const used: Record<string, number> = {};
        for (const r of d.rows) if (r.rule !== null && r.rule !== "R7") used[r.rule === "R6" ? "R1" : r.rule] = (used[r.rule === "R6" ? "R1" : r.rule] ?? 0) + 1;
        expect(used).toEqual(c.rulesUsedAmended);
      } else {
        const expected: Record<string, string[]> = {
          "0.5.36-code": ["gate-missing"],
          "0.5.37-code": ["gate-missing"],
          "cloud-038094407": ["ci-missing", "row-rejected"],
          "cloud-a05490ec1": ["ci-not-green", "not-forward"],
          "cloud-0b4fc5c80": ["ci-not-green"],
          "0.5.38-cloud-5c6c258ef": ["manual-path"],
          "0.5.48-code-9517796fc": ["row-rejected"],
        };
        for (const want of expected[c.id] ?? []) expect(codes, c.id).toContain(want);
        if (c.id === "0.5.38-cloud-5c6c258ef") expect(d.reasons.some((r) => r.message.includes('"package.json"'))).toBe(true);
        if (c.id === "0.5.48-code-9517796fc") {
          const text = d.reasons.map((r) => r.message).join("\n");
          expect(text).toContain("DefaultStage");
          expect(text).toContain("GithubWebhookSecret");
          expect(text).toContain("GithubWebhookRejectedAlarm");
        }
        if (c.id === "cloud-038094407") expect(d.reasons.map((r) => r.message).join("\n")).toContain("ServeTaskRoleDefaultPolicy");
      }
    });
  }
});

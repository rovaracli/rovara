/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// The gateway IAM-Ref exception E1 (plan v3 section 9 (c)) with the real CloudFormation shape (P0 FACTS, amendment 5): the 13 attack tests, each MUST give MANUAL, and the positive.
import { describe, expect, it } from "vitest";
import { checkE1Documents } from "../src/index.ts";
import { GW, GWS, SL, WEB, cloudInput, codeInput, detail, changesOf, hex, metaDetails, policyDocument, row, rowIn, stackIn, KNOWN, auto } from "./fixtures-index.ts";
import { attack } from "./helpers.ts";

const tpl = (i: Record<string, any>, id: string = GW.policy): Record<string, any> => stackIn(i, GWS).newTemplate.Resources[id];
const policyRow = (i: Record<string, any>): Record<string, any> => rowIn(i, GWS, GW.policy);

describe("E1 positive", () => {
  it("the exact row from a real gateway image change is AUTO", () => {
    const d = auto(cloudInput());
    expect(d.rows.find((r) => r.logicalId === GW.policy)?.rule).toBe("E1");
  });
});

describe("E1 attacks (each MUST give MANUAL)", () => {
  it("1. a second statement added to the default policy", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); }, "row-rejected", "F"));
  it("1b. a second statement added and shown as a row detail", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyDocument.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); policyRow(i).Details.push(detail("Properties", "PolicyDocument", "/Properties/PolicyDocument/Statement/3", "DirectModification", "Static")); }, "row-rejected", "F"));
  it("2. ecs:RunTask widened to *", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyDocument.Statement[1].Resource = "*"; }, "row-rejected", "F"));
  it("2b. the ecs:cluster condition removed", () => attack(cloudInput, (i) => { delete tpl(i).Properties.PolicyDocument.Statement[1].Condition; }, "row-rejected", "F"));
  it("2c. ecs:RunTask action widened to ecs:*", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyDocument.Statement[1].Action = "ecs:*"; }, "row-rejected", "F"));
  it("3. a new iam:PassRole target", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyDocument.Statement[2].Resource.push("arn:aws:iam::111111111111:role/admin"); }, "row-rejected", "F"));
  it("4. the same row caused by a ParameterReference", () => attack(cloudInput, (i) => { policyRow(i).Details[0].ChangeSource = "ParameterReference"; }, "row-rejected", "F"));
  it("4b. a visible after-value that is not KNOWN_AFTER_APPLY", () => attack(cloudInput, (i) => { policyRow(i).Details[0].Target.AfterValue = "arn:aws:ecs:us-west-2:111111111111:task-definition/evil:9"; }, "row-rejected", "F"));
  it("4c. no after-value shown at all", () => attack(cloudInput, (i) => { delete policyRow(i).Details[0].Target.AfterValue; }, "row-rejected", "F"));
  it("4d. a second detail on the row", () => attack(cloudInput, (i) => { policyRow(i).Details.push(detail("Properties", "PolicyDocument", "/Properties/PolicyDocument/Statement/2/Resource", "DirectModification", "Static", { AfterValue: KNOWN })); }, "row-rejected", "F"));
  it("5. the row names a causing entity (a different resource)", () => attack(cloudInput, (i) => { policyRow(i).Details[0].CausingEntity = GW.serve; }, "row-rejected", "F"));
  it("5b. the row names the price-fetch task as causing entity (another shape)", () => attack(cloudInput, (i) => { policyRow(i).Details[0].CausingEntity = GW.fetch; }, "row-rejected", "F"));
  it("6. the row with no R3 PriceFetchTask row in the change set", () => attack(cloudInput, (i) => { stackIn(i, GWS).changeSet.Changes = changesOf(i, GWS).filter((c: Record<string, any>) => c.ResourceChange.LogicalResourceId !== GW.fetch); }, "row-rejected", "F"));
  it("6b. the R3 PriceFetchTask row is itself rejected (unverified image)", () => attack(cloudInput, (i) => { for (const d of rowIn(i, GWS, GW.fetch).Details) d.Target.AfterValue = "x"; }, "row-rejected", "F"));
  it("6c. the statement does not point at the PriceFetchTask", () => attack(cloudInput, (i) => { for (const t of [stackIn(i, GWS).liveTemplate, stackIn(i, GWS).newTemplate]) t.Resources[GW.policy].Properties.PolicyDocument.Statement[1].Resource = { Ref: GW.serve }; }, "row-rejected", "F"));
  it("6d. the path points at a statement that is not the RunTask allow", () => attack(cloudInput, (i) => { policyRow(i).Details[0].Target.Path = "/Properties/PolicyDocument/Statement/0/Resource"; }, "row-rejected", "F"));
  it("6e. the path points past the statements", () => attack(cloudInput, (i) => { policyRow(i).Details[0].Target.Path = "/Properties/PolicyDocument/Statement/9/Resource"; }, "row-rejected", "F"));
  it("7. R3 PriceFetchTask with a changed Family", () => attack(cloudInput, (i) => { tpl(i, GW.fetch).Properties.Family = "other"; }, "row-rejected", "F"));
  it("7. R3 PriceFetchTask with a changed TaskRoleArn", () => attack(cloudInput, (i) => { tpl(i, GW.fetch).Properties.TaskRoleArn = "arn:aws:iam::111111111111:role/admin"; }, "row-rejected", "F"));
  it("7. R3 PriceFetchTask with a changed ExecutionRoleArn", () => attack(cloudInput, (i) => { tpl(i, GW.fetch).Properties.ExecutionRoleArn = "arn:aws:iam::111111111111:role/admin"; }, "row-rejected", "F"));
  it("7. R3 PriceFetchTask with a changed env var", () => attack(cloudInput, (i) => { tpl(i, GW.fetch).Properties.ContainerDefinitions[0].Environment[0].Value = "evil"; }, "row-rejected", "F"));
  it("7. R3 PriceFetchTask with an added env var", () => attack(cloudInput, (i) => { tpl(i, GW.fetch).Properties.ContainerDefinitions[0].Environment.push({ Name: "X", Value: "1" }); }, "row-rejected", "F"));
  it("7. R3 PriceFetchTask with an env var detail on the row", () => attack(cloudInput, (i) => { rowIn(i, GWS, GW.fetch).Details.push(detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions/0/Environment/0/Value", "DirectModification", "Static")); }, "row-rejected", "F"));
  it("7. R3 ServeTask (truncated) with a changed template property", () => attack(cloudInput, (i) => { tpl(i, GW.serve).Properties.ContainerDefinitions[0].Environment[0].Value = "evil"; }, "row-rejected", "F"));
  it("7. R3 ServeTask with the image parameter unchanged", () => attack(cloudInput, (i) => { const p = stackIn(i, GWS).changeSet.Parameters.find((x: Record<string, any>) => x.ParameterKey === "ImageDigest"); p.ParameterValue = stackIn(i, GWS).liveParameters.find((x: Record<string, any>) => x.ParameterKey === "ImageDigest").ParameterValue; }, "row-rejected", "F"));
  it("7. R3 ServeTask row that is not a truncated signature (a visible container change)", () => attack(cloudInput, (i) => { rowIn(i, GWS, GW.serve).Details[0].Target.AfterValue = "plain container list"; }, "row-rejected", "F"));
  it("7. R3 ServeTask with a detail on another path", () => attack(cloudInput, (i) => { rowIn(i, GWS, GW.serve).Details[0].Target.Path = "/Properties/Cpu"; }, "row-rejected", "F"));
  it("8. a row on PriceFetchTaskEventsRole (the Role)", () => attack(cloudInput, (i) => { changesOf(i, GWS).push(row("PriceFetchTaskEventsRoleAAAA1111", "AWS::IAM::Role", "Modify", "False", ["Properties"], [detail("Properties", "PermissionsBoundary", "/Properties/PermissionsBoundary", "DirectModification", "Static")])); }, "row-rejected", "G"));
  it("8b. a Metadata-only row on the Role also counts as an IAM row (E1 needs to be the only one)", () => attack(cloudInput, (i) => {
    const s = stackIn(i, GWS);
    s.liveTemplate.Resources.PriceFetchTaskEventsRole = { Type: "AWS::IAM::Role", Properties: {}, Metadata: { "aws:cdk:path": "x" } };
    s.newTemplate.Resources.PriceFetchTaskEventsRole = { Type: "AWS::IAM::Role", Properties: {} };
    changesOf(i, GWS).push(row("PriceFetchTaskEventsRole", "AWS::IAM::Role", "Modify", "False", ["Metadata"], metaDetails()));
  }, "row-rejected", "F"));
  it("8c. the role's boundary changed in the template with no row", () => attack(cloudInput, (i) => { const s = stackIn(i, GWS); s.liveTemplate.Resources.PriceFetchTaskEventsRole = { Type: "AWS::IAM::Role", Properties: { PermissionsBoundary: "a" } }; s.newTemplate.Resources.PriceFetchTaskEventsRole = { Type: "AWS::IAM::Role", Properties: { PermissionsBoundary: "b" } }; }, "template-no-row", "G"));
  it("9. a second AWS::IAM::Policy row elsewhere in the same stack", () => attack(cloudInput, (i) => { changesOf(i, GWS).push(row("ServeTaskRoleDefaultPolicy928E7343", "AWS::IAM::Policy", "Modify", "False", ["Properties"], [detail("Properties", "PolicyDocument", "/Properties/PolicyDocument", "DirectModification", "Static")])); }, "row-rejected", "G"));
  it("9b. a second AWS::IAM::Policy row in another stack of the run", () => attack(cloudInput, (i) => { const s = stackIn(i, WEB); s.liveTemplate.Resources.P = { Type: "AWS::IAM::Policy", Properties: { A: 1 } }; s.newTemplate.Resources.P = { Type: "AWS::IAM::Policy", Properties: { A: 2 } }; s.changeSet.Changes.push(row("P", "AWS::IAM::Policy", "Modify", "False", ["Properties"], [detail("Properties", "A", "/Properties/A", "DirectModification", "Static")])); }, "row-rejected", "F"));
  it("10. an IAM row in a Code stack", () => attack(codeInput, (i) => { changesOf(i, SL).push(row("PriceFetchTaskEventsRoleDefaultPolicyE756D0DB", "AWS::IAM::Policy", "Modify", "False", ["Properties"], [detail("Properties", "PolicyDocument", "/Properties/PolicyDocument/Statement/1/Resource", "DirectModification", "Static", { AfterValue: KNOWN })])); }, "row-rejected", "G"));
  it("11. a lookalike logical id in another stack (web)", () => attack(cloudInput, (i) => { const s = stackIn(i, WEB); s.liveTemplate.Resources.PriceFetchTaskEventsRoleDefaultPolicyE756D0DB = JSON.parse(JSON.stringify(tpl(i))); s.newTemplate.Resources.PriceFetchTaskEventsRoleDefaultPolicyE756D0DB = JSON.parse(JSON.stringify(tpl(i))); s.changeSet.Changes.push(JSON.parse(JSON.stringify(changesOf(i, GWS).find((c: Record<string, any>) => c.ResourceChange.LogicalResourceId === GW.policy)))); }, "row-rejected", "G"));
  it("11b. a lookalike id with lower-case hex", () => attack(cloudInput, (i) => { policyRow(i).LogicalResourceId = "PriceFetchTaskEventsRoleDefaultPolicye756d0db"; const s = stackIn(i, GWS); s.liveTemplate.Resources.PriceFetchTaskEventsRoleDefaultPolicye756d0db = s.liveTemplate.Resources[GW.policy]; s.newTemplate.Resources.PriceFetchTaskEventsRoleDefaultPolicye756d0db = s.newTemplate.Resources[GW.policy]; }, "row-rejected", "G"));
  it("11c. a lookalike id with an extra suffix", () => attack(cloudInput, (i) => { policyRow(i).LogicalResourceId = `${GW.policy}X`; const s = stackIn(i, GWS); s.liveTemplate.Resources[`${GW.policy}X`] = s.liveTemplate.Resources[GW.policy]; s.newTemplate.Resources[`${GW.policy}X`] = s.newTemplate.Resources[GW.policy]; }, "row-rejected", "G"));
  it("12. a template resource JSON that differs by one key (PolicyName)", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyName = "other"; }, "row-rejected", "F"));
  it("12b. an extra key on the resource", () => attack(cloudInput, (i) => { tpl(i).DeletionPolicy = "Retain"; }, "row-rejected", "F"));
  it("12c. the Roles list changed", () => attack(cloudInput, (i) => { tpl(i).Properties.Roles = [{ Ref: "OtherRole" }]; }, "row-rejected", "F"));
  it("12d. the Version of the document changed", () => attack(cloudInput, (i) => { tpl(i).Properties.PolicyDocument.Version = "2008-10-17"; }, "row-rejected", "F"));
  it("12e. a Metadata block added (not a removal)", () => attack(cloudInput, (i) => { tpl(i).Metadata = { "aws:cdk:path": "x" }; }, "row-rejected", "F"));
  it("the policy row with Replacement True", () => attack(cloudInput, (i) => { policyRow(i).Replacement = "True"; }, "row-rejected", "F"));
  it("the policy row with a wider scope", () => attack(cloudInput, (i) => { policyRow(i).Scope = ["Properties", "Tags"]; }, "row-rejected", "F"));
  it("the policy row with a Metadata scope", () => attack(cloudInput, (i) => { policyRow(i).Scope = ["Properties", "Metadata"]; }, "row-rejected", "F"));
});

describe("13. after deploy: the PostCheck document comparison", () => {
  const arn = (n: number): string => `arn:aws:ecs:us-west-2:111111111111:task-definition/price-fetch:${n}`;
  const doc = (n: number): Record<string, any> => { const d = policyDocument(); d.Statement[1].Resource = arn(n); return d; };
  it("only the RunTask revision moved up to the schedule target: OK", () => expect(checkE1Documents(doc(4), doc(5), arn(5))).toEqual([]));
  it("accepts JSON text", () => expect(checkE1Documents(JSON.stringify(doc(4)), JSON.stringify(doc(5)), arn(5))).toEqual([]));
  it("a second statement appeared", () => { const a = doc(5); a.Statement.push({ Effect: "Allow", Action: "s3:*", Resource: "*" }); expect(checkE1Documents(doc(4), a, arn(5)).length).toBeGreaterThan(0); });
  it("an action widened", () => { const a = doc(5); a.Statement[1].Action = "ecs:*"; expect(checkE1Documents(doc(4), a, arn(5)).length).toBeGreaterThan(0); });
  it("the revision and a condition both changed", () => { const a = doc(5); delete a.Statement[1].Condition; expect(checkE1Documents(doc(4), a, arn(5)).length).toBeGreaterThan(0); });
  it("a different statement's Resource changed", () => { const a = doc(4); a.Statement[0].Resource = "arn:aws:ecs:*"; expect(checkE1Documents(doc(4), a, arn(4)).length).toBeGreaterThan(0); });
  it("the family changed", () => { const a = doc(5); a.Statement[1].Resource = "arn:aws:ecs:us-west-2:111111111111:task-definition/serve:5"; expect(checkE1Documents(doc(4), a, a.Statement[1].Resource).length).toBeGreaterThan(0); });
  it("the revision did not go up", () => expect(checkE1Documents(doc(5), doc(5), arn(5)).length).toBeGreaterThan(0));
  it("the revision went down", () => expect(checkE1Documents(doc(5), doc(4), arn(4)).length).toBeGreaterThan(0));
  it("the new ARN is not the schedule target's ARN", () => expect(checkE1Documents(doc(4), doc(5), arn(6)).length).toBeGreaterThan(0));
  it("the account changed", () => { const a = doc(5); a.Statement[1].Resource = "arn:aws:ecs:us-west-2:222222222222:task-definition/price-fetch:5"; expect(checkE1Documents(doc(4), a, a.Statement[1].Resource).length).toBeGreaterThan(0); });
  it("the resource is a wildcard", () => { const a = doc(5); a.Statement[1].Resource = "*"; expect(checkE1Documents(doc(4), a, "*").length).toBeGreaterThan(0); });
  it("unparsable documents", () => expect(checkE1Documents("{", "{", undefined).length).toBeGreaterThan(0));
  it("identical documents (nothing moved)", () => expect(checkE1Documents(doc(4), doc(4)).length).toBeGreaterThan(0));
});

void [hex];

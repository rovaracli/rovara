import { describe, expect, it, vi } from "vitest";
import {
  CALLBACK_FAILURE_REASONS,
  CLOUDFORMATION_RESPONSE_MAX_BYTES,
  TEST_ACCESS_DEFAULT_REGIONS,
  TEST_ACCESS_TEMPLATE_PARAMETERS,
  buildCloudFormationResponse,
  buildQuickCreateLink,
  buildTestAccessLink,
  callbackPhysicalId,
  connectionExternalId,
  isCloudFormationResponseUrl,
  parseConnectionExternalId,
  parseTestAccessCallback,
  sendCloudFormationResponse,
  snsServicePrincipal,
  testAccessTopicArn,
  testAccessTopicName,
} from "../../packages/cloud-contracts/src/test-access-connect.js";

const ORG = `org_${"a".repeat(20)}`;
const CONN = `conn_${"b".repeat(20)}`;
const EXTERNAL_ID = `rovara-${ORG}-${CONN}`;
const ACCOUNT = "123456789012";
const OTHER_ACCOUNT = "999999999999";
const REGION = "us-west-2";
const STACK_ID = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555`;
const RESPONSE_URL = "https://cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com/arn%3Aaws%3Acloudformation%3Aus-west-2%3A123456789012%3Astack?X-Amz-Signature=abc";
const TEMPLATE_URL = "https://rovara-templates.s3.us-east-1.amazonaws.com/test-access/1.0.0/rovara-test-access.template.yaml";
const token = (): string => ["t", "o", "k", "e", "n"].join("") + "_" + "x".repeat(20);

const properties = (over: Record<string, unknown> = {}) => ({
  ServiceToken: `arn:aws:sns:${REGION}:000000000001:rovara-test-access-callback`,
  ServiceTimeout: "300",
  RoleArn: `arn:aws:iam::${ACCOUNT}:role/Rovara-test-access-RovaraTestRole-ABC`,
  CleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/Rovara-test-access-RovaraTestCleanupRole-DEF`,
  AccountId: ACCOUNT,
  Region: REGION,
  ExternalId: EXTERNAL_ID,
  ConnectToken: token(),
  TemplateVersion: "1.0.0",
  ...over,
});
const request = (type: "Create" | "Update" | "Delete", over: Record<string, unknown> = {}) =>
  JSON.stringify({
    RequestType: type,
    RequestId: "req-1",
    StackId: STACK_ID,
    ResponseURL: RESPONSE_URL,
    ResourceType: "Custom::RovaraTestAccess",
    LogicalResourceId: "RovaraCallback",
    ...(type === "Create" ? {} : { PhysicalResourceId: callbackPhysicalId(EXTERNAL_ID) }),
    ResourceProperties: properties(),
    ...(type === "Update" ? { OldResourceProperties: properties() } : {}),
    ...over,
  });

describe("ids", () => {
  it("makes the external id from the org and the connection, and reads it back", () => {
    expect(connectionExternalId(ORG, CONN)).toBe(EXTERNAL_ID);
    expect(parseConnectionExternalId(EXTERNAL_ID)).toEqual({ orgId: ORG, connectionId: CONN });
    expect(parseConnectionExternalId("rovara-org-conn")).toBeUndefined();
    expect(() => connectionExternalId("not-an-org", CONN)).toThrow();
    expect(() => connectionExternalId(ORG, "x")).toThrow();
  });
  it("has a topic in each default Region under one name, and the right service principal (opt-in Regions name their own)", () => {
    expect(new Set(TEST_ACCESS_DEFAULT_REGIONS).size).toBe(TEST_ACCESS_DEFAULT_REGIONS.length);
    expect(testAccessTopicName("agentx-staging")).toBe("agentx-staging-test-access-callback");
    expect(testAccessTopicArn({ region: REGION, accountId: ACCOUNT, topicName: "t" })).toBe(`arn:aws:sns:${REGION}:${ACCOUNT}:t`);
    expect(() => testAccessTopicArn({ region: "nowhere", accountId: ACCOUNT, topicName: "t" })).toThrow();
    expect(snsServicePrincipal("us-west-2")).toBe("sns.amazonaws.com");
    expect(snsServicePrincipal("ap-east-1")).toBe("sns.ap-east-1.amazonaws.com");
  });
});

describe("the quick-create link", () => {
  const input = { region: REGION, templateUrl: TEMPLATE_URL, orgId: ORG, connectionId: CONN, connectToken: token(), rovaraPrincipalArn: "arn:aws:iam::000000000001:role/rovara-broker", callbackTopicArn: `arn:aws:sns:${REGION}:000000000001:rovara-test-access-callback` };

  it("opens the console in the stack's Region with the template and every parameter filled", () => {
    const link = buildTestAccessLink(input);
    const url = new URL(link);
    expect(url.origin).toBe(`https://${REGION}.console.aws.amazon.com`);
    expect(url.searchParams.get("region")).toBe(REGION);
    const query = new URLSearchParams(url.hash.slice(url.hash.indexOf("?") + 1));
    expect(url.hash.startsWith("#/stacks/quickcreate?")).toBe(true);
    expect(query.get("templateURL")).toBe(TEMPLATE_URL);
    expect(query.get("stackName")).toBe("Rovara-test-access");
    expect(query.get(`param_${TEST_ACCESS_TEMPLATE_PARAMETERS.externalId}`)).toBe(EXTERNAL_ID);
    expect(query.get(`param_${TEST_ACCESS_TEMPLATE_PARAMETERS.connectToken}`)).toBe(input.connectToken);
    expect(query.get(`param_${TEST_ACCESS_TEMPLATE_PARAMETERS.rovaraPrincipal}`)).toBe(input.rovaraPrincipalArn);
    expect(query.get(`param_${TEST_ACCESS_TEMPLATE_PARAMETERS.callbackTopicArn}`)).toBe(input.callbackTopicArn);
    expect([...query.keys()].sort()).toEqual(["param_CallbackTopicArn", "param_ConnectToken", "param_ExternalId", "param_RovaraPrincipal", "stackName", "templateURL"]);
  });

  it("is the same link for the same input (pure)", () => {
    expect(buildTestAccessLink(input)).toBe(buildTestAccessLink({ ...input }));
  });

  it("refuses a topic in another Region (the service token must be in the stack's Region), a template that is not plain https S3, and values the link cannot carry", () => {
    expect(() => buildTestAccessLink({ ...input, callbackTopicArn: "arn:aws:sns:eu-west-1:000000000001:t" })).toThrow(/Region/u);
    expect(() => buildTestAccessLink({ ...input, rovaraPrincipalArn: "arn:aws:iam::000000000001:user/someone" })).toThrow();
    expect(() => buildTestAccessLink({ ...input, connectToken: "short" })).toThrow();
    for (const templateUrl of ["http://rovara-templates.s3.amazonaws.com/t.yaml", "https://example.com/t.yaml", "https://rovara-templates.s3.amazonaws.com/t.yaml?x=1", "https://u:p@rovara-templates.s3.amazonaws.com/t.yaml", "https://evil.com/.s3.amazonaws.com/t.yaml"]) {
      expect(() => buildTestAccessLink({ ...input, templateUrl }), templateUrl).toThrow();
    }
    expect(() => buildQuickCreateLink({ region: "cn-north-1", templateUrl: TEMPLATE_URL, stackName: "s", parameters: {} })).toThrow(/commercial/u);
    expect(() => buildQuickCreateLink({ region: REGION, templateUrl: TEMPLATE_URL, stackName: "bad name", parameters: {} })).toThrow();
    expect(() => buildQuickCreateLink({ region: REGION, templateUrl: TEMPLATE_URL, stackName: "ok", parameters: { "bad-name": "x" } })).toThrow();
    expect(() => buildQuickCreateLink({ region: REGION, templateUrl: TEMPLATE_URL, stackName: "ok", parameters: { A: "line\nbreak" } })).toThrow();
  });

  it("encodes a value so it cannot add a parameter of its own", () => {
    const link = buildQuickCreateLink({ region: REGION, templateUrl: TEMPLATE_URL, stackName: "ok", parameters: { A: "x&param_B=evil#frag" } });
    const query = new URLSearchParams(new URL(link).hash.slice(new URL(link).hash.indexOf("?") + 1));
    expect(query.get("param_A")).toBe("x&param_B=evil#frag");
    expect(query.has("param_B")).toBe(false);
  });
});

describe("reading a callback", () => {
  it("reads a Create, an Update and a Delete from the Region's topic", () => {
    for (const type of ["Create", "Update", "Delete"] as const) {
      const parsed = parseTestAccessCallback(request(type), REGION);
      expect(parsed.ok, type).toBe(true);
      if (parsed.ok) expect(parsed.request.RequestType).toBe(type);
    }
  });

  it("refuses what is not JSON or not a request, with a fixed code", () => {
    expect(parseTestAccessCallback("not json", REGION)).toEqual({ ok: false, code: "malformed" });
    expect(parseTestAccessCallback(JSON.stringify({ RequestType: "Create" }), REGION)).toEqual({ ok: false, code: "malformed" });
    expect(parseTestAccessCallback(JSON.stringify({ RequestType: "Other" }), REGION)).toEqual({ ok: false, code: "malformed" });
    expect(parseTestAccessCallback(request("Create", { ResourceProperties: properties({ RoleArn: "arn:aws:iam::123456789012:user/x" }) }), REGION)).toEqual({ ok: false, code: "malformed" });
  });

  it("binds the report to where it came from: a stack in one account cannot report another account's role", () => {
    const foreignRole = request("Create", { ResourceProperties: properties({ RoleArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/victim` }) });
    expect(parseTestAccessCallback(foreignRole, REGION)).toMatchObject({ ok: false, code: "account_mismatch" });
    const foreignCleanup = request("Create", { ResourceProperties: properties({ CleanupRoleArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/victim` }) });
    expect(parseTestAccessCallback(foreignCleanup, REGION)).toMatchObject({ ok: false, code: "account_mismatch" });
    const claimed = request("Create", { ResourceProperties: properties({ AccountId: OTHER_ACCOUNT }) });
    expect(parseTestAccessCallback(claimed, REGION)).toMatchObject({ ok: false, code: "account_mismatch" });
    // control: the same message from its own account is accepted
    expect(parseTestAccessCallback(request("Create"), REGION).ok).toBe(true);
  });

  it("binds the report to the topic's Region", () => {
    expect(parseTestAccessCallback(request("Create"), "us-east-1")).toMatchObject({ ok: false, code: "region_mismatch" });
    expect(parseTestAccessCallback(request("Create", { ResourceProperties: properties({ Region: "eu-west-1" }) }), REGION)).toMatchObject({ ok: false, code: "region_mismatch" });
  });

  it("answers a Delete whatever its properties hold, so deleting the customer's stack never waits", () => {
    expect(parseTestAccessCallback(request("Delete", { ResourceProperties: { anything: "goes" } }), "us-east-1").ok).toBe(true);
    expect(parseTestAccessCallback(request("Delete", { ResourceProperties: undefined }), REGION).ok).toBe(true);
  });
});

describe("the answer to CloudFormation", () => {
  const base = { StackId: STACK_ID, RequestId: "req-1", LogicalResourceId: "RovaraCallback" };

  it("copies StackId, RequestId and LogicalResourceId, and gives a Create the connection's physical id", () => {
    expect(buildCloudFormationResponse({ ...base, RequestType: "Create", ResourceProperties: properties() }, { status: "SUCCESS" })).toEqual({ Status: "SUCCESS", PhysicalResourceId: callbackPhysicalId(EXTERNAL_ID), ...base });
  });

  it("keeps the physical id the same in every answer: an Update returns the one CloudFormation sent, so it is never a replacement", () => {
    const sent = callbackPhysicalId(EXTERNAL_ID);
    expect(buildCloudFormationResponse({ ...base, RequestType: "Update", PhysicalResourceId: sent, ResourceProperties: properties() }, { status: "SUCCESS" }).PhysicalResourceId).toBe(sent);
    expect(buildCloudFormationResponse({ ...base, RequestType: "Update", PhysicalResourceId: sent, ResourceProperties: properties() }, { status: "FAILED", code: "token_refused" }).PhysicalResourceId).toBe(sent);
  });

  it("fails a Create with a fixed reason that echoes nothing from the request, and still has a physical id when the properties cannot be read", () => {
    const answer = buildCloudFormationResponse({ ...base, RequestType: "Create", ResourceProperties: { ExternalId: "attacker text" } }, { status: "FAILED", code: "malformed" });
    expect(answer).toMatchObject({ Status: "FAILED", Reason: CALLBACK_FAILURE_REASONS.malformed });
    expect(answer.PhysicalResourceId).toMatch(/^rovara-connection-[A-Za-z0-9-]+$/u);
    expect(JSON.stringify(answer)).not.toContain("attacker");
    for (const reason of Object.values(CALLBACK_FAILURE_REASONS)) expect(reason).not.toMatch(/\$\{|\{\{/u);
  });

  it("always succeeds a Delete, even when the outcome is a failure (positive control: the same outcome fails an Update)", () => {
    const failure = { status: "FAILED", code: "not_ready" } as const;
    const deletion = buildCloudFormationResponse({ ...base, RequestType: "Delete", PhysicalResourceId: callbackPhysicalId(EXTERNAL_ID) }, failure);
    expect(deletion.Status).toBe("SUCCESS");
    expect(deletion.Reason).toBeUndefined();
    expect(buildCloudFormationResponse({ ...base, RequestType: "Update", PhysicalResourceId: callbackPhysicalId(EXTERNAL_ID) }, failure).Status).toBe("FAILED");
  });

  it("sends no data: the token and the role are not echoed", () => {
    const answer = buildCloudFormationResponse({ ...base, RequestType: "Create", ResourceProperties: properties() }, { status: "SUCCESS" });
    expect(answer.Data).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("token_");
  });
});

describe("sending the answer", () => {
  const response = buildCloudFormationResponse({ StackId: STACK_ID, RequestId: "req-1", LogicalResourceId: "RovaraCallback", RequestType: "Create", ResourceProperties: properties() }, { status: "SUCCESS" });

  it("accepts only CloudFormation's own pre-signed S3 URLs", () => {
    expect(isCloudFormationResponseUrl(RESPONSE_URL)).toBe(true);
    expect(isCloudFormationResponseUrl("https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/arn%3Aaws")).toBe(true);
    for (const bad of [
      "http://cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com/x",
      "https://example.com/x",
      "https://169.254.169.254/latest/meta-data",
      "https://cloudformation-custom-resource-response-uswest2.s3.amazonaws.com.evil.com/x",
      "https://evil.com/cloudformation-custom-resource-response-uswest2.s3.amazonaws.com/x",
      "https://user:pw@cloudformation-custom-resource-response-uswest2.s3.amazonaws.com/x",
      "https://cloudformation-custom-resource-response-uswest2.s3.amazonaws.com:8443/x",
      "https://cloudformation-custom-resource-response-uswest2.s3.amazonaws.com",
      "https://my-bucket.s3.amazonaws.com/x",
      "not a url",
    ]) expect(isCloudFormationResponseUrl(bad), bad).toBe(false);
  });

  it("puts the JSON to the URL and says whether CloudFormation took it", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect(await sendCloudFormationResponse(RESPONSE_URL, response, { fetch })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(RESPONSE_URL);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual(response);
  });

  it("never calls out to a URL that is not CloudFormation's", async () => {
    const fetch = vi.fn();
    expect(await sendCloudFormationResponse("https://example.com/x", response, { fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a failure a bounded number of times and never throws", async () => {
    const down = vi.fn().mockRejectedValue(new Error("network"));
    expect(await sendCloudFormationResponse(RESPONSE_URL, response, { fetch: down, attempts: 3, timeoutMs: 50 })).toBe(false);
    expect(down).toHaveBeenCalledTimes(3);
    const flaky = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, status: 200 });
    expect(await sendCloudFormationResponse(RESPONSE_URL, response, { fetch: flaky, timeoutMs: 50 })).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
    const expired = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    expect(await sendCloudFormationResponse(RESPONSE_URL, response, { fetch: expired })).toBe(false);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(await sendCloudFormationResponse(RESPONSE_URL, response, { fetch: vi.fn().mockResolvedValue({ ok: false, status: 500 }), attempts: 99, timeoutMs: 50 })).toBe(false);
  });

  it("cuts an oversized answer down to a bare one, because CloudFormation refuses a body over 4,096 bytes", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const big = { ...response, Status: "FAILED" as const, Reason: "x".repeat(5_000) };
    await sendCloudFormationResponse(RESPONSE_URL, big, { fetch });
    const body = (fetch.mock.calls[0] as [string, { body: string }])[1].body;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(CLOUDFORMATION_RESPONSE_MAX_BYTES);
    expect(JSON.parse(body)).toMatchObject({ Status: "FAILED", PhysicalResourceId: response.PhysicalResourceId });
  });
});

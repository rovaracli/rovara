// Customer test AWS account, lane TA2: the SDK adapter of the AWS port, against fake clients. Nothing here calls AWS. What matters: the exact AssumeRole input, the fixed words for every error, and that the queue calls refuse anything that is
// not a run-named queue before they send.
import { describe, expect, it } from "vitest";
import type { AssumeFailureError } from "../../packages/broker/src/test-access/aws-port.js";
import { realSdkClients, sdkAccountCalls, sdkTestAccessAws, type SdkClient, type SdkClients } from "../../packages/broker/src/test-access/aws-sdk.js";

const ACCOUNT = "222233334444";
const REGION = "us-west-2";
const failure = (name: string, message = "x") => Object.assign(new Error(message), { name });

function fakeClients(handler: (service: string, command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) {
  const sent: Array<{ service: string; command: string; input: Record<string, unknown> }> = [];
  const client = (service: string): SdkClient => ({ send: (command) => {
    const typed = command as { constructor: { name: string }; input: Record<string, unknown> };
    sent.push({ service, command: typed.constructor.name, input: typed.input });
    try { return Promise.resolve(handler(service, typed)); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("failed")); }
  } });
  const clients = Object.fromEntries(["sts", "iam", "sqs", "dynamodb", "s3", "sns", "lambda", "logs", "secretsmanager", "ssm", "states"].map((service) => [service, client(service)])) as unknown as SdkClients;
  return { clients, sent };
}

describe("assume role", () => {
  it("sends exactly the request it is given (role, name, external id, policy, tags, duration), and returns the credentials and the assumed role's ARN", async () => {
    const { clients, sent } = fakeClients(() => ({ Credentials: { AccessKeyId: "k", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(5) }, AssumedRoleUser: { Arn: "arn:aws:sts::1:assumed-role/r/n" } }));
    const aws = sdkTestAccessAws({ sts: clients.sts, clientsFor: () => clients });
    const result = await aws.assumeRole({ RoleArn: "arn:aws:iam::1:role/r", RoleSessionName: "n", ExternalId: "e", DurationSeconds: 3600, Policy: "{}", Tags: [{ Key: "rovara-run", Value: "ab12cd34" }] });
    expect(sent).toEqual([{ service: "sts", command: "AssumeRoleCommand", input: { RoleArn: "arn:aws:iam::1:role/r", RoleSessionName: "n", DurationSeconds: 3600, ExternalId: "e", Policy: "{}", Tags: [{ Key: "rovara-run", Value: "ab12cd34" }] } }]);
    expect(result).toEqual({ credentials: { accessKeyId: "k", secretAccessKey: "s", sessionToken: "t", expiration: new Date(5) }, assumedRoleArn: "arn:aws:sts::1:assumed-role/r/n" });
    await aws.assumeRole({ RoleArn: "arn:aws:iam::1:role/r", RoleSessionName: "n", DurationSeconds: 900 });
    expect(Object.keys(sent[1]!.input).sort()).toEqual(["DurationSeconds", "RoleArn", "RoleSessionName"]);
  });

  it("maps access denied to refused and everything else, and an incomplete answer, to unreachable, without keeping AWS's text", async () => {
    const run = async (handler: () => unknown) => {
      const { clients } = fakeClients(handler);
      return sdkTestAccessAws({ sts: clients.sts, clientsFor: () => clients }).assumeRole({ RoleArn: "a", RoleSessionName: "n", DurationSeconds: 900 }).then(() => undefined, (error: AssumeFailureError) => error);
    };
    for (const name of ["AccessDenied", "AccessDeniedException", "MalformedPolicyDocument"]) expect((await run(() => { throw failure(name, "arn:aws:iam::222233334444:role/x"); }))?.failure, name).toBe("refused");
    for (const name of ["ThrottlingException", "TimeoutError", "ServiceUnavailable"]) expect((await run(() => { throw failure(name); }))?.failure, name).toBe("unreachable");
    expect((await run(() => ({ Credentials: { AccessKeyId: "k" } })))?.failure).toBe("unreachable");
    expect((await run(() => ({})))?.message).not.toContain("222233334444");
  });
});

describe("the calls", () => {
  it("probes one read per service, and tells a service control policy from the role's own refusal and from an outage", async () => {
    const scp = fakeClients((service) => { if (service === "dynamodb") throw failure("AccessDeniedException", "with an explicit deny in a service control policy"); if (service === "sqs") throw failure("AccessDenied", "no identity-based policy"); if (service === "sns") throw failure("ThrottlingException"); return {}; });
    const calls = sdkAccountCalls(scp.clients, REGION, ACCOUNT);
    expect(await calls.probeService("dynamodb")).toBe("scp_blocked");
    expect(await calls.probeService("sqs")).toBe("no_access");
    expect(await calls.probeService("sns")).toBe("unreachable");
    expect(await calls.probeService("s3")).toBe("ok");
    expect(await calls.probeService("events")).toBe("no_client");
    expect(await calls.probeService("kinesis")).toBe("no_client");
    for (const sent of scp.sent) expect(sent.command).toMatch(/^(List|Describe)/u);
  });

  it("reads the alias and the boundary, and a refusal is no alias and no boundary", async () => {
    const ok = sdkAccountCalls(fakeClients((_, command) => (command.constructor.name === "GetRoleCommand" ? { Role: { PermissionsBoundary: { PermissionsBoundaryArn: "arn:aws:iam::1:policy/b" } } } : { AccountAliases: ["beta"] })).clients, REGION, ACCOUNT);
    expect(await ok.listAccountAliases()).toEqual(["beta"]);
    expect(await ok.roleBoundary("r")).toBe("arn:aws:iam::1:policy/b");
    const denied = sdkAccountCalls(fakeClients(() => { throw failure("AccessDenied"); }).clients, REGION, ACCOUNT);
    expect(await denied.listAccountAliases()).toEqual([]);
    expect(await denied.roleBoundary("r")).toBeUndefined();
  });

  it("lists the names of existing resources, one call per service, and nothing for a refused or unknown service", async () => {
    const { clients, sent } = fakeClients((service) => (service === "dynamodb" ? { TableNames: ["a", "b", "c"] } : service === "sqs" ? { QueueUrls: [`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/q1`] } : service === "s3" ? { Buckets: [{ Name: "bk" }, {}] } : service === "sns" ? { Topics: [{ TopicArn: `arn:aws:sns:${REGION}:${ACCOUNT}:t1` }] } : {}));
    const calls = sdkAccountCalls(clients, REGION, ACCOUNT);
    expect(await calls.listNames("dynamodb", 2)).toEqual(["a", "b"]);
    expect(await calls.listNames("sqs", 10)).toEqual(["q1"]);
    expect(await calls.listNames("s3", 10)).toEqual(["bk"]);
    expect(await calls.listNames("sns", 10)).toEqual(["t1"]);
    expect(await calls.listNames("lambda", 10)).toBeUndefined();
    expect(sent.map((entry) => entry.command)).toEqual(["ListTablesCommand", "ListQueuesCommand", "ListBucketsCommand", "ListTopicsCommand"]);
    expect(await sdkAccountCalls(fakeClients(() => { throw failure("AccessDenied"); }).clients, REGION, ACCOUNT).listNames("dynamodb", 5)).toBeUndefined();
  });

  it("creates only a run-named queue, tagged with the run, and refuses any other name before sending", async () => {
    const { clients, sent } = fakeClients(() => ({ QueueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/rv-ab12cd34-conntest` }));
    const calls = sdkAccountCalls(clients, REGION, ACCOUNT);
    expect(await calls.createQueue("rv-ab12cd34-conntest", "ab12cd34")).toEqual({ ok: true, queueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/rv-ab12cd34-conntest` });
    expect(sent[0]).toMatchObject({ command: "CreateQueueCommand", input: { QueueName: "rv-ab12cd34-conntest", tags: { "rovara-run": "ab12cd34" } } });
    for (const name of ["orders", "rv-ab12cd34", "rv-zzzzzzzz-x", "rv-ab12cd34-", "rv-ab12cd34-x y", "../x"]) expect(await calls.createQueue(name, "ab12cd34"), name).toEqual({ ok: false, code: "error" });
    expect(await calls.createQueue("rv-ab12cd34-ok", "xxxxxxxx")).toEqual({ ok: false, code: "error" });
    expect(sent).toHaveLength(1);
    expect(await sdkAccountCalls(fakeClients(() => { throw failure("AccessDenied"); }).clients, REGION, ACCOUNT).createQueue("rv-ab12cd34-x", "ab12cd34")).toEqual({ ok: false, code: "denied" });
  });

  it("deletes a queue by URL only when it is a run-named queue of this account and Region; by name, any plain name in this account (the not-ours probe); and reads the outcome as a word", async () => {
    const outcome = (error?: Error) => sdkAccountCalls(fakeClients(() => { if (error !== undefined) throw error; return {}; }).clients, REGION, ACCOUNT);
    const own = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/rv-ab12cd34-conntest`;
    expect(await outcome().deleteQueueByUrl(own)).toBe("deleted");
    for (const url of [`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/orders`, `https://sqs.${REGION}.amazonaws.com/555566667777/rv-ab12cd34-x`, `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/rv-ab12cd34-x`, `${own}?x=1`, `http://sqs.${REGION}.amazonaws.com/${ACCOUNT}/rv-ab12cd34-x`, "https://attacker.example.com/rv-ab12cd34-x"]) expect(await outcome().deleteQueueByUrl(url), url).toBe("error");
    expect(await outcome(failure("AccessDeniedException")).deleteQueueByName("orders")).toBe("denied");
    expect(await outcome(failure("QueueDoesNotExist")).deleteQueueByName("orders")).toBe("not_found");
    expect(await outcome(failure("AWS.SimpleQueueService.NonExistentQueue")).deleteQueueByName("orders")).toBe("not_found");
    expect(await outcome(failure("ThrottlingException")).deleteQueueByName("orders")).toBe("error");
    expect(await outcome().deleteQueueByName("bad name/../x")).toBe("error");
    const { clients, sent } = fakeClients(() => ({}));
    await sdkAccountCalls(clients, REGION, ACCOUNT).deleteQueueByName("orders");
    expect(sent[0]!.input).toEqual({ QueueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/orders` });
  });

  it("builds real SDK clients in memory (no call is made): Regional ones in the connection's Region and IAM global", async () => {
    const clients = realSdkClients({ accessKeyId: "k", secretAccessKey: "s", sessionToken: "t", expiration: new Date(Date.now() + 1_000) }, REGION);
    expect(Object.keys(clients).sort()).toEqual(["dynamodb", "iam", "lambda", "logs", "s3", "secretsmanager", "sns", "sqs", "ssm", "states", "sts"]);
    expect(await (clients.sqs as unknown as { config: { region(): Promise<string> } }).config.region()).toBe(REGION);
    expect(await (clients.iam as unknown as { config: { region(): Promise<string> } }).config.region()).toBe("us-east-1");
  });
});

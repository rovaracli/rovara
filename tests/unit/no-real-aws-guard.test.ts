// SUBAGENT-AWS-DEFAULT-CLIENT-SLIP: the setup file tests/support/no-real-aws.ts blocks any real AWS SDK send. This tests the guard itself.
// No test here reaches a network: a blocked call throws before the SDK builds a request, and the allowed cases are stopped by a middleware or by a refused loopback port.
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOW_REAL_AWS_ENV, RealAwsCallBlockedError, takeRealAwsViolations, withRealAwsAllowed } from "../support/no-real-aws.js";

const credentials = { accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake" };
const command = () => new GetParameterCommand({ Name: "/rovara/x" });
/** Stops a send at the first middleware step, so a call the guard lets through never builds a request. */
function stopAtInitialize<C extends SSMClient | EC2Client>(client: C): C {
  (client.middlewareStack as { add: (...args: unknown[]) => void }).add(() => async () => ({ output: { $metadata: {}, Parameter: { Name: "stopped" } } }), { step: "initialize", name: "stop" });
  return client;
}

afterEach(() => {
  delete process.env[ALLOW_REAL_AWS_ENV];
});

describe("the real AWS call guard", () => {
  it("blocks a default client, naming the test, the client and the command, and records the attempt", async () => {
    const client = new SSMClient({ region: "us-west-2", credentials });
    let error: unknown;
    try {
      await client.send(command());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RealAwsCallBlockedError);
    const message = (error as Error).message;
    expect(message).toContain("blocks a default client, naming the test");
    expect(message).toContain("no-real-aws-guard.test.ts");
    expect(message).toContain("SSMClient.send(GetParameterCommand)");
    expect(message).toContain(ALLOW_REAL_AWS_ENV);
    expect(takeRealAwsViolations()).toHaveLength(1);
  });

  it("blocks every client class, not only one (the guard sits on the shared Client.prototype.send)", () => {
    expect(() => new EC2Client({ region: "us-west-2", credentials }).send(new DescribeInstancesCommand({}))).toThrow(RealAwsCallBlockedError);
    expect(takeRealAwsViolations()).toHaveLength(1);
  });

  it("blocks the callback form too, and a client given an ordinary remote endpoint", async () => {
    const remote = new SSMClient({ region: "us-west-2", credentials, endpoint: "https://ssm.us-west-2.amazonaws.com" });
    await expect(remote.send(command())).rejects.toBeInstanceOf(RealAwsCallBlockedError);
    expect(takeRealAwsViolations()).toHaveLength(1);
    expect(() => new SSMClient({ region: "us-west-2", credentials }).send(command(), () => undefined)).toThrow(RealAwsCallBlockedError);
    expect(takeRealAwsViolations()).toHaveLength(1);
  });

  it("records a blocked call even when the code under test swallows the error, so the test would still fail (the afterEach hook reads the record)", async () => {
    const client = new SSMClient({ region: "us-west-2", credentials });
    const probe = async () => {
      try {
        return await client.send(command());
      } catch {
        return undefined;
      }
    };
    expect(await probe()).toBeUndefined();
    const found = takeRealAwsViolations();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Real AWS call blocked");
  });

  it("lets a client with a fake request handler through (it never reaches the network)", async () => {
    const handled: unknown[] = [];
    const requestHandler = {
      handle: async (request: unknown) => {
        handled.push(request);
        throw new Error("fake handler reached");
      },
      destroy: () => undefined,
      updateHttpClientConfig: () => undefined,
      httpHandlerConfigs: () => ({}),
    };
    const client = new SSMClient({ region: "us-west-2", credentials, requestHandler, maxAttempts: 1 });
    await expect(client.send(command())).rejects.toThrow(/fake handler reached/u);
    expect(handled).toHaveLength(1);
    expect(takeRealAwsViolations()).toEqual([]);
  });

  it("lets a loopback endpoint through (a fake server the test started), and nothing else about the endpoint", async () => {
    // Port 1 refuses at once; the error is the connection's, not the guard's.
    const client = new SSMClient({ region: "us-west-2", credentials, endpoint: "http://127.0.0.1:1", maxAttempts: 1 });
    const failure = await client.send(command()).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeDefined();
    expect(failure).not.toBeInstanceOf(RealAwsCallBlockedError);
    expect(takeRealAwsViolations()).toEqual([]);
  });

  it("is switched off by the environment variable, for a live test", async () => {
    process.env[ALLOW_REAL_AWS_ENV] = "1";
    const output = await stopAtInitialize(new SSMClient({ region: "us-west-2", credentials })).send(command());
    expect(output.Parameter?.Name).toBe("stopped");
    expect(takeRealAwsViolations()).toEqual([]);
  });

  it("is switched off inside withRealAwsAllowed only, and back on after it", async () => {
    const output = await withRealAwsAllowed(() => stopAtInitialize(new SSMClient({ region: "us-west-2", credentials })).send(command()));
    expect(output.Parameter?.Name).toBe("stopped");
    expect(() => new SSMClient({ region: "us-west-2", credentials }).send(command())).toThrow(RealAwsCallBlockedError);
    expect(takeRealAwsViolations()).toHaveLength(1);
  });

  it("is installed once, however many test files import it in one process", async () => {
    await import("../support/no-real-aws.js");
    expect(() => new SSMClient({ region: "us-west-2", credentials }).send(command())).toThrow(/Real AWS call blocked/u);
    expect(takeRealAwsViolations()).toHaveLength(1);
  });
});

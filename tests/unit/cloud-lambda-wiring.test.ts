// Rovara Cloud on Lambda, wired end to end (PrepLabsAI/Rovara-cloud#11): the real handler reads its address from SSM and its client
// secret from Secrets Manager (a local fake of both), keeps sign-ins in DynamoDB (DynamoDB Local in Docker), and serves the page shell.
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOUD_TABLE, DynamoSessionStore, cloudDocumentClient } from "../../packages/cloud-server/src/index.js";
import { handler } from "../../scripts/cloud-lambda.js";

const docker = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!docker) console.warn("cloud-lambda-wiring.test.ts: Docker isn't running, so the Lambda entry is not tested end to end here.");

const ORIGIN = "https://d111111abcdef8.cloudfront.net";
const TABLE = "cloud-lambda-wiring";

describe.skipIf(!docker)("Rovara Cloud on Lambda, end to end", () => {
  let container = "", fake: Server | undefined, client: DynamoDBClient | undefined;
  const asked: string[] = [];

  beforeAll(async () => {
    container = execFileSync("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::8000", "amazon/dynamodb-local:2.6.1", "-jar", "DynamoDBLocal.jar", "-inMemory"], { encoding: "utf8" }).trim();
    const dynamo = `http://127.0.0.1:${execFileSync("docker", ["port", container, "8000/tcp"], { encoding: "utf8" }).trim().split(":").at(-1)!}`;
    // SSM and Secrets Manager speak JSON over POST, named by X-Amz-Target.
    fake = createServer((request, response) => {
      const target = String(request.headers["x-amz-target"] ?? "");
      asked.push(target);
      response.setHeader("content-type", "application/x-amz-json-1.1");
      if (target === "AmazonSSM.GetParameter") return response.end(JSON.stringify({ Parameter: { Name: "/rovara-cloud/production/web/origin", Value: ORIGIN } }));
      if (target === "secretsmanager.GetSecretValue") return response.end(JSON.stringify({ SecretString: "client-secret", Name: "rovara-cloud/production/code-client-secret" }));
      response.statusCode = 400;
      response.end("{}");
    });
    await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));
    const port = (fake.address() as { port: number }).port;
    const app = mkdtempSync(join(tmpdir(), "cloud-shell-"));
    writeFileSync(join(app, "index.html"), "<!doctype html><title>Rovara</title>");
    Object.assign(process.env, {
      AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local",
      AWS_ENDPOINT_URL_DYNAMODB: dynamo, AWS_ENDPOINT_URL_SSM: `http://127.0.0.1:${String(port)}`, AWS_ENDPOINT_URL_SECRETS_MANAGER: `http://127.0.0.1:${String(port)}`,
      CLOUD_TABLE: TABLE, CLOUD_ORIGIN_PARAMETER: "/rovara-cloud/production/web/origin", CLOUD_CLIENT_SECRET_ID: "rovara-cloud/production/code-client-secret",
      CLOUD_APP_DIRECTORY: app, ROVARA_CODE_URL: "https://code.example.test",
    });
    client = new DynamoDBClient({ endpoint: dynamo, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
    for (let tries = 0; ; tries += 1) {
      try {
        await client.send(new CreateTableCommand({
          TableName: TABLE, BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [CLOUD_TABLE.partitionKey, CLOUD_TABLE.sortKey, CLOUD_TABLE.startedByKey, CLOUD_TABLE.startedBySort].map((name) => ({ AttributeName: name, AttributeType: "S" })),
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
          GlobalSecondaryIndexes: [{ IndexName: "startedBy", Projection: { ProjectionType: "ALL" }, KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }] }],
        }));
        break;
      } catch (error) {
        if (tries > 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }, 60_000);

  afterAll(() => {
    fake?.close();
    if (container !== "") execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  });

  const call = (rawPath: string, rawQueryString = ""): Promise<Awaited<ReturnType<typeof handler>>> =>
    handler({ rawPath, rawQueryString, headers: { "accept-encoding": "br" }, requestContext: { http: { method: "GET" } } });

  it("starts a sign-in with Code on its CloudFront address, and keeps the sign-in under way where another copy finds it", async () => {
    const answer = await call("/v1/auth/browser/authorize", "return_to=%2Fapp");
    expect(answer.statusCode).toBe(302);
    const location = new URL(answer.headers.location!);
    expect(location.origin).toBe("https://code.example.test");
    expect(location.searchParams.get("client_id")).toBe("rovara-cloud");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(asked).toEqual(expect.arrayContaining(["AmazonSSM.GetParameter", "secretsmanager.GetSecretValue"]));
    // Another copy of the function, on the same table, takes it, once.
    const other = new DynamoSessionStore(cloudDocumentClient(client!), TABLE);
    expect(await other.takePending(location.searchParams.get("state")!)).toMatchObject({ returnTo: "/app" });
    expect(await other.takePending(location.searchParams.get("state")!)).toBeUndefined();
  });

  it("serves the page shell with its security headers, and asks for a sign-in on the API without one", async () => {
    const page = await call("/app/projects");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>Rovara</title>");
    expect(page.headers["strict-transport-security"]).toBeDefined();
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect((await call("/v1/web/me")).statusCode).toBe(401);
  });
});

// The REAL cdk binary, driven with the stage CLI's own argument vector, against a pretend AWS on 127.0.0.1 (no AWS call, dummy credentials, a fake account id).
// Why: the argument vector of `cdk deploy --no-execute` was only ever checked as a list of words (pipeline-stage-review-opus.test.ts). The beta adoption rerun then failed at
// Beta/CloudGateway because, without --exclusively, cdk also took the dependency stack (gateway-images) and handed it ImageDigest, which CloudFormation refuses
// ("Parameters: [ImageDigest] do not exist in the template"). Here cdk itself decides what to select and where each parameter goes, and the pretend CloudFormation refuses
// exactly what the real one refuses (a parameter the stack's template does not declare). cdk is given the synthesized assembly in place of `--app "node infra/dist/bin/agentx.js"`
// (a shim named npx swaps only that one argument), because the app's own build is not what is under test.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CloudAppStack, cloudAppStackName } from "../../infra/lib/cloud-app.js";
import { CloudWebStack, cloudWebStackName } from "../../infra/lib/cloud-web.js";
import { createRealPorts } from "../../ops/pipeline/ports.ts";
import { FAKE_ACCOUNT, config } from "./pipeline-stage-fakes.ts";

const REPO = resolve(import.meta.dirname, "../..");
const CDK = join(REPO, "node_modules/.bin/cdk");
const root = mkdtempSync(join(tmpdir(), "stage-cdk-real-"));
const NAME = "rovara-pipeline-1a2b3c4d";
const GATEWAY = "rovara-cloud-beta-gateway";
const IMAGES = "rovara-cloud-beta-gateway-images";
const WEB = cloudWebStackName("beta");
const APP = cloudAppStackName("beta");
const DIGEST = `sha256:${"a".repeat(64)}`;

// ---- the pretend AWS ------------------------------------------------------------------------------------------------------------------------------------------------

type Template = { Parameters?: Record<string, { Default?: string }> };
interface Created { stack: string; name: string; params: Record<string, string> }
const created: Created[] = [];
const changeSets = new Set<string>();
const templates = new Map<string, Template>(); // stack name -> its synthesized template (every stack here "exists", as in beta)
let server: Server;
let endpoint = "";

const xml = (res: ServerResponse, status: number, body: string): void => { res.statusCode = status; res.setHeader("content-type", "text/xml"); res.end(body); };
const failure = (res: ServerResponse, code: string, message: string): void => xml(res, 400, `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>r</RequestId></ErrorResponse>`);
const esc = (v: string): string => v.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
const ns = "http://cloudformation.amazonaws.com/doc/2010-05-15/";
const meta = "<ResponseMetadata><RequestId>r</RequestId></ResponseMetadata>";

function handleQuery(form: URLSearchParams, res: ServerResponse): void {
  const action = form.get("Action") ?? "";
  // cdk names a stack by its name first and by its id (an ARN) afterwards.
  const stackRaw = form.get("StackName") ?? "";
  const stack = stackRaw.startsWith("arn:") ? (/:stack\/([^/]+)\//u.exec(stackRaw)?.[1] ?? stackRaw) : stackRaw;
  const csRaw = form.get("ChangeSetName") ?? "";
  const csName = csRaw.startsWith("arn:") ? (/:changeSet\/([^/]+)\//u.exec(csRaw)?.[1] ?? csRaw) : csRaw;
  const owner = stack === "" ? (created.find((c) => c.name === csName)?.stack ?? "") : stack;
  const key = `${owner}/${csName}`;
  if (action === "GetCallerIdentity") return xml(res, 200, `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${FAKE_ACCOUNT}:user/x</Arn><UserId>X</UserId><Account>${FAKE_ACCOUNT}</Account></GetCallerIdentityResult>${meta}</GetCallerIdentityResponse>`);
  if (action === "AssumeRole") return xml(res, 200, `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><AssumedRoleUser><AssumedRoleId>AROAX:s</AssumedRoleId><Arn>arn:aws:sts::${FAKE_ACCOUNT}:assumed-role/r/s</Arn></AssumedRoleUser><Credentials><AccessKeyId>ASIAFAKEFAKE</AccessKeyId><SecretAccessKey>fake</SecretAccessKey><SessionToken>tok</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult>${meta}</AssumeRoleResponse>`);
  const template = templates.get(stack) ?? (stack === "" ? templates.get(created.find((c) => c.name === csName)?.stack ?? "") : undefined);
  if (["DescribeStacks", "GetTemplate", "CreateChangeSet", "DeleteChangeSet", "DescribeChangeSet"].includes(action) && template === undefined) return failure(res, "ValidationError", `Stack with id ${stack} does not exist`);
  if (action === "DescribeStacks") {
    const members = Object.entries(template!.Parameters ?? {}).map(([k, v]) => `<member><ParameterKey>${k}</ParameterKey><ParameterValue>${esc(v.Default ?? "kept")}</ParameterValue></member>`).join("");
    return xml(res, 200, `<DescribeStacksResponse xmlns="${ns}"><DescribeStacksResult><Stacks><member><StackId>arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:stack/${stack}/1</StackId><StackName>${stack}</StackName><StackStatus>UPDATE_COMPLETE</StackStatus><CreationTime>2026-01-01T00:00:00Z</CreationTime><Parameters>${members}</Parameters></member></Stacks></DescribeStacksResult>${meta}</DescribeStacksResponse>`);
  }
  if (action === "GetTemplate") return xml(res, 200, `<GetTemplateResponse xmlns="${ns}"><GetTemplateResult><TemplateBody>${esc(JSON.stringify(template))}</TemplateBody></GetTemplateResult>${meta}</GetTemplateResponse>`);
  if (action === "CreateChangeSet") {
    const params: Record<string, string> = {};
    for (let i = 1; form.get(`Parameters.member.${i}.ParameterKey`) !== null; i += 1) { // UsePreviousValue entries carry no value: only a value cdk was TOLD to set counts
      const value = form.get(`Parameters.member.${i}.ParameterValue`);
      if (value !== null) params[form.get(`Parameters.member.${i}.ParameterKey`)!] = value;
    }
    // What CloudFormation does: a parameter the stack's template does not declare is refused.
    const declared = Object.keys(template!.Parameters ?? {});
    const unknown = Object.keys(params).filter((k) => !declared.includes(k));
    created.push({ stack, name: csName, params });
    if (unknown.length > 0) return failure(res, "ValidationError", `Parameters: [${unknown.join(",")}] do not exist in the template`);
    changeSets.add(key);
    return xml(res, 200, `<CreateChangeSetResponse xmlns="${ns}"><CreateChangeSetResult><Id>arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:changeSet/${csName}/1</Id><StackId>arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:stack/${stack}/1</StackId></CreateChangeSetResult>${meta}</CreateChangeSetResponse>`);
  }
  if (action === "DeleteChangeSet") { changeSets.delete(key); return xml(res, 200, `<DeleteChangeSetResponse xmlns="${ns}"><DeleteChangeSetResult/>${meta}</DeleteChangeSetResponse>`); }
  if (action === "DescribeChangeSet") {
    if (!changeSets.has(key)) return failure(res, "ChangeSetNotFound", `ChangeSet [${csName}] does not exist`);
    // An adoption run: nothing to change (CloudFormation's own empty-change-set answer).
    return xml(res, 200, `<DescribeChangeSetResponse xmlns="${ns}"><DescribeChangeSetResult><ChangeSetName>${csName}</ChangeSetName><ChangeSetId>cs-1</ChangeSetId><StackName>${stack}</StackName><StackId>arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:stack/${stack}/1</StackId><Status>FAILED</Status><ExecutionStatus>UNAVAILABLE</ExecutionStatus><StatusReason>The submitted information didn't contain changes. Submit different information to create a change set.</StatusReason><Changes/></DescribeChangeSetResult>${meta}</DescribeChangeSetResponse>`);
  }
  return failure(res, "Unhandled", `the pretend AWS does not answer ${action}`);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    if (String(req.headers["x-amz-target"] ?? "").startsWith("AmazonSSM.")) { // the bootstrap version
      res.setHeader("content-type", "application/x-amz-json-1.1");
      return void res.end(JSON.stringify({ Parameter: { Name: "/cdk-bootstrap/hnb659fds/version", Type: "String", Value: "30", Version: 1 } }));
    }
    if (req.method === "POST" && url.pathname === "/" && body.toString("latin1").startsWith("Action=")) return handleQuery(new URLSearchParams(body.toString("utf8")), res);
    // S3 (the template and asset uploads): a location, an empty listing, then accept every PUT.
    if (req.method === "GET" && url.searchParams.has("location")) return xml(res, 200, `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></LocationConstraint>`);
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") return xml(res, 200, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`);
    // Large assets go up in parts.
    if (req.method === "POST" && url.searchParams.has("uploads")) return xml(res, 200, `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>b</Bucket><Key>k</Key><UploadId>u1</UploadId></InitiateMultipartUploadResult>`);
    if (req.method === "POST" && url.searchParams.has("uploadId")) return xml(res, 200, `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>l</Location><Bucket>b</Bucket><Key>k</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`);
    if (req.method === "PUT") { res.setHeader("etag", "\"x\""); res.statusCode = 200; return void res.end(); }
    res.statusCode = 404;
    res.end("<Error><Code>NotFound</Code></Error>");
  });
}

// ---- the synthesized apps -------------------------------------------------------------------------------------------------------------------------------------------

function register(assembly: { stacks: ReadonlyArray<{ stackName: string; template: unknown }> }): void {
  for (const s of assembly.stacks) templates.set(s.stackName, s.template as Template);
}
let gatewayAssembly = "";
let cloudAssembly = "";

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The gateway app exactly as the pipeline selects it (-c rovaraModelGateway=beta): the images stack and the gateway stack that depends on it.
  const gateway = buildAgentXApp({ rovaraModelGateway: "beta" }).synth();
  gatewayAssembly = gateway.directory;
  register(gateway);
  // The web and app stacks of the Cloud app, with the stand-in built web app and inline code the other infra tests use (no bundling, no web build).
  const built = mkdtempSync(join(root, "web-app-"));
  mkdirSync(join(built, "assets"));
  writeFileSync(join(built, "index.html"), "<!doctype html>");
  writeFileSync(join(built, "assets", "index-abc.js"), "export {};");
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" } });
  const web = new CloudWebStack(app, "RovaraCloudWeb", { stackName: WEB, environmentName: "beta", env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});") });
  const cloud = new CloudAppStack(app, "RovaraCloudApp", { stackName: APP, environmentName: "beta", env: { region: "us-east-1" }, movedTo: web.origin });
  cloud.addStackDependency(web, "its first address sends people to the web stack's address");
  const synthesized = app.synth();
  cloudAssembly = synthesized.directory;
  register(synthesized);
  // A shim named npx: drops `--no-install cdk`, swaps ONLY the --app value for the synthesized assembly (TEST_ASSEMBLY), and runs the real cdk with everything else untouched.
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "npx"), `#!/bin/bash
[ "$1" = "--no-install" ] && [ "$2" = "cdk" ] || { echo "unexpected npx call: $*" >&2; exit 97; }
shift 2
args=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--app" ]; then args+=("--app" "$TEST_ASSEMBLY"); shift 2; else args+=("$1"); shift; fi
done
exec "${CDK}" "\${args[@]}"
`);
  chmodSync(join(root, "bin", "npx"), 0o755);
}, 120_000);

afterAll(() => { server.close(); });

/** The environment cdk runs in: the pretend AWS for every service, dummy credentials, a home with no AWS files, and nothing that goes to the internet (notices, version check, telemetry). */
function cdkEnv(assembly: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, HOME: mkdtempSync(join(root, "home-")), TEST_ASSEMBLY: assembly,
    AWS_ENDPOINT_URL: endpoint, AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE", AWS_SECRET_ACCESS_KEY: "fake", AWS_EC2_METADATA_DISABLED: "true",
    CI: "true", CDK_DISABLE_VERSION_CHECK: "1", CDK_DISABLE_CLI_TELEMETRY: "true", CDK_NOTICES_TIMEOUT: "1",
  };
  delete env.AWS_PROFILE;
  delete env.AWS_SESSION_TOKEN;
  return env;
}

const realPorts = (assembly: string) => { Object.assign(process.env, cdkEnv(assembly)); return createRealPorts({ config, env: "beta", region: "us-east-1", exec8: "1a2b3c4d", profile: null, cwd: root }); };

/** The argument vector the stage CLI used BEFORE this change: no --exclusively, parameters unprefixed. */
const oldArgv = (stackIds: string[], parameters: Record<string, string>): string[] => ["--no-install", "cdk", "deploy", ...stackIds, "--app", "node infra/dist/bin/agentx.js", "--no-execute", "--require-approval", "never", "--change-set-name", NAME, "--progress", "events", "-c", "rovaraModelGateway=beta", ...Object.entries(parameters).flatMap(([k, v]) => ["--parameters", `${k}=${v}`])];
const runOld = (argv: string[], assembly: string): Promise<{ code: number; text: string }> => new Promise((ok) => {
  execFile(join(root, "bin", "npx"), argv, { cwd: root, env: cdkEnv(assembly), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => ok({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, text: `${stdout}\n${stderr}` }));
});

describe("the stage CLI's cdk call, against the real cdk binary and a pretend CloudFormation", () => {
  it("the gateway call (ImageDigest) selects only the gateway stack, applies the parameter to it, and never touches the images stack", async () => {
    created.length = 0; changeSets.clear();
    await realPorts(gatewayAssembly).cdk.deployNoExecute({ dir: root, stacks: [{ stackId: "RovaraModelGateway", stackName: GATEWAY, parameters: { ImageDigest: DIGEST } }], changeSetName: NAME, context: { rovaraModelGateway: "beta" } });
    expect(created).toEqual([{ stack: GATEWAY, name: NAME, params: { ImageDigest: DIGEST } }]);
    expect(created.some((c) => c.stack === IMAGES)).toBe(false);
  }, 180_000);

  it("the argument vector of 2c7fecbd (no --exclusively, ImageDigest unprefixed) FAILS here exactly as it did in beta: the images stack is handed ImageDigest", async () => {
    created.length = 0; changeSets.clear();
    const old = await runOld(oldArgv(["RovaraModelGateway"], { ImageDigest: DIGEST }), gatewayAssembly);
    expect(old.code).not.toBe(0);
    expect(old.text).toContain("Parameters: [ImageDigest] do not exist in the template");
    expect(created.some((c) => c.stack === IMAGES && c.params.ImageDigest === DIGEST)).toBe(true);
  }, 180_000);

  it("cdk matches a parameter prefix with the stack NAME: the construct id as a prefix applies it to nothing", async () => {
    created.length = 0; changeSets.clear();
    const r = await runOld(["--no-install", "cdk", "deploy", "RovaraModelGateway", "--exclusively", "--app", "x", "--no-execute", "--require-approval", "never", "--change-set-name", NAME, "--progress", "events", "--parameters", `RovaraModelGateway:ImageDigest=${DIGEST}`], gatewayAssembly);
    expect(r.code).toBe(0);
    expect(created).toEqual([{ stack: GATEWAY, name: NAME, params: {} }]); // not applied: a wrong prefix would have silently kept the live digest
  }, 180_000);

  it("the web and app call hands CodeUrl to each of the two stacks by name, and to nothing else", async () => {
    created.length = 0; changeSets.clear();
    await realPorts(cloudAssembly).cdk.deployNoExecute({
      dir: root, changeSetName: NAME, context: { rovaraCloudApp: "beta" },
      stacks: [{ stackId: "RovaraCloudApp", stackName: APP, parameters: { CodeUrl: "https://code.example.test" } }, { stackId: "RovaraCloudWeb", stackName: WEB, parameters: { CodeUrl: "https://code.example.test" } }],
    });
    expect(created.map((c) => c.stack).sort()).toEqual([APP, WEB].sort());
    for (const c of created) expect(c).toMatchObject({ name: NAME, params: { CodeUrl: "https://code.example.test" } });
  }, 240_000);
});

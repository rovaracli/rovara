// Company-approved images: the worker's pull login (`company-image-login`). A run gets a login for ONE mirrored image of its own company, only while the image is still approved and copied, only for an image its pinned
// plan named, and only a few times; everything else is refused with the same words.
import { afterEach, describe, expect, it } from "vitest";
import { COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION, SavedEnvRegistryAuthSchema, companyImageRepositoryName } from "@agentx/contracts";
import { COMPANY_IMAGE_LOGIN_REFUSED, handleCompanyImageLogin, type CompanyImageLoginDeps, type CompanyImageLoginOperation } from "../../packages/broker/src/aws/broker/company-image-login.js";
import { operationKey } from "../../packages/broker/src/aws/cancellation.js";
import { expectedRepositoryPolicy, type SavedEnvSessionPorts } from "../../packages/broker/src/test-env/saved-env-session.js";
import { companyImageIdOf, type CompanyImage } from "../../packages/broker/src/test-env/company-images.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { sha } from "../support/catalog-pinning.js";

const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const CONFIG = { enabled: true, env: "staging", scope: { partition: "aws", region: "us-east-1", account: "123456789012" }, kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000" } as const;
const ON = { TEST_SERVICES_ENABLED: "1", PROJECT_IMAGES_ENABLED: "1" } as NodeJS.ProcessEnv;
const ADMIN = "a".repeat(64);
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.PROJECT_IMAGES_ENABLED; });

const image = (change: Partial<CompanyImage> = {}): CompanyImage => {
  const base = { registry: "ghcr.io", repository: "acme/postgres", digest: sha("approved platform manifest"), ...change };
  return {
    orgId: TEST_ORG, revision: 2, status: "approved", tag: "18", family: "postgres", version: "18", origin: "admin", cycle: "c".repeat(16), proposedBy: ADMIN, proposedAt: new Date(NOW).toISOString(), approvedBy: ADMIN, approvedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...base, imageId: companyImageIdOf(base, base.digest),
  };
};

function bench(options: { sessions?: boolean; repositoryMatches?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const assumed: Array<{ roleArn: string; policy: string }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const ports: SavedEnvSessionPorts = {
    assume: async (request) => { assumed.push({ roleArn: request.roleArn, policy: request.policy }); return { credentials: { accessKeyId: "AKIAFAKE", secretAccessKey: "s".repeat(20), sessionToken: "t".repeat(20) }, expiresAtMs: NOW + 1_800_000 }; },
    authorizationToken: async () => ({ password: "registry-password-for-test", registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com", expiresAtMs: NOW + 40_000_000 }),
    inspectRepository: async () => ({ encryptionType: "KMS", kmsKey: options.repositoryMatches === false ? "arn:aws:kms:us-east-1:123456789012:key/other" : CONFIG.kmsKeyArn, imageTagMutability: "IMMUTABLE", policyText: JSON.stringify(expectedRepositoryPolicy(CONFIG)) }),
    readApproved: async () => undefined, proveHolds: async () => false, now: () => NOW,
  };
  const deps: CompanyImageLoginDeps = { documentClient: db, tableName: "state", ...(options.sessions === false ? {} : { sessions: { config: CONFIG, ports } }), now: () => NOW, log: (event) => { logs.push(event); } };
  const operation = (change: Partial<CompanyImageLoginOperation> = {}): CompanyImageLoginOperation => ({ kind: "task", workflowMode: "IMPLEMENT", status: "RUNNING", workspaceId: WORKSPACE, id: OPERATION, orgId: TEST_ORG, ...change });
  db.set({ ...operationKey(WORKSPACE, OPERATION), id: OPERATION, kind: "task" });
  const put = (value: CompanyImage, extra: { mirror?: Record<string, unknown> | "none" } = {}) => {
    db.set({ pk: `ORG#${value.orgId}`, sk: `TESTIMAGE#${value.imageId}`, entityType: "COMPANY_TEST_IMAGE", ...value });
    if (extra.mirror !== "none") db.set({ pk: `COMPANY_IMAGE_MIRROR#${value.orgId}`, sk: value.imageId, entityType: "COMPANY_IMAGE_MIRROR", state: "ready", digest: value.digest, repository: companyImageRepositoryName({ env: "staging", orgId: value.orgId, imageId: value.imageId }), attempts: 1, startedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...(extra.mirror ?? {}) });
  };
  return { db, deps, assumed, logs, operation, put };
}
const refused = async (promise: Promise<unknown>): Promise<void> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  expect(String((error as Error).message)).toContain(COMPANY_IMAGE_LOGIN_REFUSED);
};

describe("the company image login", () => {
  it("gives a login for the one repository of the approved, copied image the run's plan named, and logs no credential", async () => {
    const b = bench();
    const value = image();
    b.put(value);
    const reply = await handleCompanyImageLogin(b.deps, b.operation({ companyImageIds: [value.imageId] }), { imageId: value.imageId }, ON);
    const repository = companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: value.imageId });
    expect(SavedEnvRegistryAuthSchema.safeParse(reply.login).success).toBe(true);
    expect(reply.login).toMatchObject({ registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com", repository, username: "AWS" });
    // The session is the PULL role's, for that one repository, with the pull actions only.
    const pull = b.assumed.filter((request) => request.roleArn.endsWith("-img-pull"));
    expect(pull).toHaveLength(1);
    const statements = (JSON.parse(pull[0]!.policy) as { Statement: Array<{ Action: string | string[]; Resource: string }> }).Statement;
    expect(statements.find((statement) => statement.Resource !== "*")).toMatchObject({ Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: `arn:aws:ecr:us-east-1:123456789012:repository/${repository}` });
    expect(JSON.stringify(b.logs)).not.toContain("registry-password-for-test");
    expect(b.logs.map((event) => event["event"])).toEqual(["company_image.login_issued"]);
  });

  it("is off with either switch off, and refuses a run that is not a running task or preparation of a company", async () => {
    const b = bench();
    const value = image();
    b.put(value);
    const ask = (operation: CompanyImageLoginOperation, env: NodeJS.ProcessEnv = ON) => handleCompanyImageLogin(b.deps, operation, { imageId: value.imageId }, env);
    const ok = b.operation({ companyImageIds: [value.imageId] });
    await refused(ask(ok, {}));
    await refused(ask(ok, { TEST_SERVICES_ENABLED: "1" }));
    await refused(ask(ok, { PROJECT_IMAGES_ENABLED: "1" }));
    for (const change of [{ status: "SUCCEEDED" }, { status: "ACCEPTED" }, { kind: "cancel" }, { kind: "publish" }, { workflowMode: "PLAN" }, { workflowMode: "REVIEW" }, { orgId: undefined }, { id: undefined }]) {
      await refused(ask({ ...ok, ...change }));
    }
    expect(b.assumed).toEqual([]);
    // A task's coding and checks runs and a candidate check's preparation are the ones that run services.
    for (const change of [{ workflowMode: "CHECKS" }, { workflowMode: undefined }, { kind: "prepare", workflowMode: undefined }]) {
      expect((await ask({ ...ok, ...change })).login.repository).toContain("rovara-env/staging/");
    }
  });

  it("gives a login only for an image the run's own plan named, even when another image of the company is approved and copied", async () => {
    const b = bench();
    const named = image(), other = image({ digest: sha("another approved image") });
    b.put(named); b.put(other);
    await refused(handleCompanyImageLogin(b.deps, b.operation({ companyImageIds: [named.imageId] }), { imageId: other.imageId }, ON));
    await refused(handleCompanyImageLogin(b.deps, b.operation({ companyImageIds: [] }), { imageId: named.imageId }, ON));
    await refused(handleCompanyImageLogin(b.deps, b.operation(), { imageId: named.imageId }, ON));
    expect(b.assumed).toEqual([]);
  });

  it("asks the approval, the company's registry list and the copy NOW: a revoked, waiting, off-list or uncopied image gets no login", async () => {
    const run = async (arrange: (b: ReturnType<typeof bench>, value: CompanyImage) => void, value = image()) => {
      const b = bench();
      arrange(b, value);
      await refused(handleCompanyImageLogin(b.deps, b.operation({ companyImageIds: [value.imageId] }), { imageId: value.imageId }, ON));
      expect(b.assumed).toEqual([]);
    };
    await run(() => undefined);                                                            // revoked: no row at all
    await run((b, value) => b.put({ ...value, status: "proposed", revision: 1, approvedBy: undefined, approvedAt: undefined } as unknown as CompanyImage));  // waiting, never approved
    await run((b, value) => b.put(value, { mirror: "none" }));                           // approved, no copy yet
    await run((b, value) => b.put(value, { mirror: { state: "copying" } }));
    await run((b, value) => b.put(value, { mirror: { state: "failed", reason: "no_arm64" } }));
    await run((b, value) => b.put(value, { mirror: { digest: sha("a copy of another digest") } }));
    await run((b, value) => b.put(value, { mirror: { repository: "rovara-env/staging/o" + "a".repeat(32) + "/c" + "b".repeat(32) } }));  // a state that names another repository
    await run((b, value) => b.put(value, { mirror: { state: "ready", digest: "not a digest" } }));
    await run((b, value) => b.put(value), image({ registry: "registry.example.com" }));        // its registry is not on the company's list
  });

  it("serves an image from a registry the company listed, and stops when the company takes it off the list", async () => {
    const b = bench();
    const value = image({ registry: "registry.example.com" });
    b.put(value);
    b.db.set({ pk: `ORG#${TEST_ORG}`, sk: "TESTIMAGE_REGISTRIES", revision: 1, hosts: ["registry.example.com"] });
    const operation = b.operation({ companyImageIds: [value.imageId] });
    expect((await handleCompanyImageLogin(b.deps, operation, { imageId: value.imageId }, ON)).login.repository).toContain("rovara-env/staging/");
    b.db.set({ pk: `ORG#${TEST_ORG}`, sk: "TESTIMAGE_REGISTRIES", revision: 2, hosts: [] });
    await refused(handleCompanyImageLogin(b.deps, operation, { imageId: value.imageId }, ON));
  });

  it("keeps the companies apart: a run of another company is refused for this company's image, with the same words", async () => {
    const b = bench();
    const value = image();
    b.put(value);
    await refused(handleCompanyImageLogin(b.deps, b.operation({ orgId: OTHER_ORG, companyImageIds: [value.imageId] }), { imageId: value.imageId }, ON));
    expect(b.assumed).toEqual([]);
  });

  it("refuses a body that is not exactly an image id, and a repository that is not the one the creation template makes", async () => {
    const b = bench();
    const value = image();
    b.put(value);
    const operation = b.operation({ companyImageIds: [value.imageId] });
    for (const body of [{}, { imageId: "img_*" }, { imageId: value.imageId, repository: "rovara-env/staging/x" }, { imageId: 7 }, null, "x", [value.imageId]]) {
      await expect(handleCompanyImageLogin(b.deps, operation, body, ON), JSON.stringify(body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    const squatted = bench({ repositoryMatches: false });
    squatted.put(value);
    await refused(handleCompanyImageLogin(squatted.deps, squatted.operation({ companyImageIds: [value.imageId] }), { imageId: value.imageId }, ON));
    const none = bench({ sessions: false });
    none.put(value);
    await refused(handleCompanyImageLogin(none.deps, none.operation({ companyImageIds: [value.imageId] }), { imageId: value.imageId }, ON));
  });

  it("gives a run only a few logins, counted on the operation, then refuses", async () => {
    const b = bench();
    const value = image();
    b.put(value);
    const operation = b.operation({ companyImageIds: [value.imageId] });
    for (let index = 0; index < COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION; index += 1) await handleCompanyImageLogin(b.deps, operation, { imageId: value.imageId }, ON);
    await refused(handleCompanyImageLogin(b.deps, operation, { imageId: value.imageId }, ON));
    expect(b.db.get(operationKey(WORKSPACE, OPERATION).pk, operationKey(WORKSPACE, OPERATION).sk)?.["companyImageLogins"]).toBe(COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION);
  });
});

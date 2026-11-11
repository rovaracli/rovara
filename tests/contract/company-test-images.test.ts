// Company-approved extra test-service images, the parts under the routes: reading a reference, the registry lookup, the setup flow that proposes images, and an environment naming an image (approved only for an approved one).
import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_DEPENDENCY_LABEL_WORDS } from "@agentx/contracts";
import { dynamoCompanyImageStore } from "../../packages/broker/src/org/company-test-image-store.js";
import { environmentUnusedReason } from "../../packages/broker/src/test-env/usable.js";
import { dependencyEvidenceOf } from "../../packages/broker/src/rovara-code/dependency-evidence.js";
import { proposeTestEnvironment } from "../../packages/broker/src/org/test-environment.js";
import { proposeImagesFromSetup, approveImage, revokeImage, type CompanyImageAuditEntry, type CompanyImageDeps } from "../../packages/broker/src/org/company-test-images.js";
import { COMPANY_IMAGES_MAX, COMPANY_IMAGES_MAX_WAITING, companyImageIdOf, readCompanyImage, companyImageStanding, serviceImageServed, type CompanyImage } from "../../packages/broker/src/test-env/company-images.js";
import { registryDigestResolver } from "../../packages/broker/src/test-env/company-image-resolver.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OMAR } from "../support/developer-task-broker.js";
import { pinnedCatalog, sha, verifiedCatalog } from "../support/catalog-pinning.js";
import { draftBody, setupWizardBench, NAME } from "../support/setup-wizard-testenv.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.PROJECT_IMAGES_ENABLED; delete process.env.TEST_ENVIRONMENT_ENABLED; });
const catalog = verifiedCatalog(pinnedCatalog());

describe("reading an image reference", () => {
  it("reads a plain tagged name the way Docker does and finds its family and major version", () => {
    expect(readCompanyImage("postgres:18")).toMatchObject({ ok: true, image: { registry: "docker.io", repository: "library/postgres", tag: "18" }, family: "postgres", major: "18" });
    expect(readCompanyImage("ghcr.io/acme/mysql:8.4-alpine")).toMatchObject({ ok: true, image: { registry: "ghcr.io", repository: "acme/mysql", tag: "8.4-alpine" }, family: "mysql", major: "8" });
    expect(readCompanyImage("valkey/valkey:8.1")).toMatchObject({ ok: true, family: "redis", major: "8" });
    expect(readCompanyImage("index.docker.io/redis:v7.2")).toMatchObject({ ok: true, image: { registry: "docker.io", repository: "library/redis" }, major: "7" });
  });

  it("refuses everything that is not plain: a digest, no tag, no version, upper case, credentials, addresses, ports and private names", () => {
    const refused = (text: unknown) => (readCompanyImage(text) as { ok: false; reason: string }).reason;
    expect(refused(`postgres@sha256:${"a".repeat(64)}`)).toBe("has_digest");
    expect(readCompanyImage("user:pw@ghcr.io/acme/postgres:18").ok).toBe(false);
    expect(refused("postgres")).toBe("no_tag");
    expect(refused("postgres:latest")).toBe("no_version");
    for (const text of ["Postgres:18", "a b:18", "", 7, undefined, "x".repeat(400), "https://ghcr.io/acme/postgres:18", "10.0.0.5/acme/postgres:18", "169.254.169.254/postgres:18",
      "registry.example.com:5000/postgres:18", "localhost/postgres:18", "registry.corp.internal/postgres:18", "ghcr.io/Acme/postgres:18", "ghcr.io//postgres:18", "ghcr.io/../postgres:18", "[::1]:443/postgres:18"]) {
      expect(refused(text), String(text)).toBe("not_a_reference");
    }
  });
});

describe("the registry lookup", () => {
  type Reply = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
  const reply = (status: number, headers: Record<string, string> = {}, body = ""): Reply => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body });
  const image = { registry: "docker.io", repository: "library/postgres", tag: "18" };
  const digest = sha("manifest");

  it("asks for a pull token when the registry does, then reads the digest header, over https with no redirect followed", async () => {
    const calls: Array<{ url: string; redirect?: string; auth?: string }> = [];
    const resolve = registryDigestResolver(async (url, init) => {
      calls.push({ url, ...(init?.redirect === undefined ? {} : { redirect: init.redirect }), ...(init?.headers?.authorization === undefined ? {} : { auth: init.headers.authorization }) });
      if (url.startsWith("https://auth.docker.io/")) return reply(200, {}, JSON.stringify({ token: "t0k" }));
      return init?.headers?.authorization === undefined ? reply(401, { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' }) : reply(200, { "docker-content-digest": `sha256:${digest}` });
    });
    expect(await resolve(image)).toBe(digest);
    expect(calls.map((call) => call.url)).toEqual([
      "https://registry-1.docker.io/v2/library/postgres/manifests/18", "https://auth.docker.io/token?scope=repository%3Alibrary%2Fpostgres%3Apull&service=registry.docker.io", "https://registry-1.docker.io/v2/library/postgres/manifests/18",
    ]);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(calls[2]!.auth).toBe("Bearer t0k");
  });

  it("says nothing for a failure of any kind: a redirect, a bad digest header, a token address that is not a public https name, an error, a thrown fetch", async () => {
    const answers: Array<(url: string) => Reply | Promise<Reply>> = [
      () => reply(302, { location: "https://elsewhere.example.org/" }),
      () => reply(200, { "docker-content-digest": "sha256:abc" }),
      () => reply(200, { "docker-content-digest": `sha512:${digest}` }),
      () => reply(200),
      () => reply(401, { "www-authenticate": 'Bearer realm="http://auth.example.org/token"' }),
      () => reply(401, { "www-authenticate": 'Bearer realm="https://169.254.169.254/token"' }),
      () => reply(401, { "www-authenticate": 'Bearer realm="https://auth.corp.internal/token"' }),
      () => reply(401, { "www-authenticate": 'Basic realm="x"' }),
      () => reply(500),
      () => { throw new Error("socket closed with a secret in it"); },
    ];
    for (const answer of answers) expect(await registryDigestResolver(async (url) => answer(url))(image)).toBeUndefined();
    // A private registry name is never asked.
    let asked = 0;
    expect(await registryDigestResolver(async () => { asked += 1; return reply(200, { "docker-content-digest": `sha256:${digest}` }); })({ registry: "registry.corp.internal", repository: "acme/postgres", tag: "18" })).toBeUndefined();
    expect(asked).toBe(0);
  });
});

const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const ADMIN = "a".repeat(64);
const lookup = new Map<string, string>([["docker.io/library/postgres:18", sha("pg18")], ["docker.io/library/postgres:16", sha("pg16")], ["docker.io/clickhouse/clickhouse-server:24", sha("ch24")], ["ghcr.io/acme/mysql:9", sha("my9")]]);
function bench(options: { noAudit?: boolean; admin?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db, now: () => NOW });
  const store = dynamoCompanyImageStore({ documentClient: db, tableName: "state", ...(options.noAudit === true ? {} : { audit: capture.audit }) });
  const deps: CompanyImageDeps = {
    store, edition: "public", now: () => new Date(NOW), catalog: async () => catalog,
    resolveDigest: async (image) => lookup.get(`${image.registry}/${image.repository}:${image.tag}`),
    requireAdmin: async () => { if (options.admin === false) throw new Error("FORBIDDEN"); },
    readSession: async () => ({ authTime: new Date(NOW).toISOString(), developerId: ADMIN }),
  };
  return { db, capture, store, deps };
}
const caller = { orgId: TEST_ORG, developerId: ADMIN, sessionId: "session-1" };
const approve = (deps: CompanyImageDeps, image: CompanyImage) => approveImage(deps, caller, { imageId: image.imageId, expectedRevision: image.revision, expectedDigest: image.digest });

describe("the setup flow proposes images that are in neither list", () => {
  it("makes a waiting card for an image Rovara's list does not cover; nothing runs, and a covered or unrunnable image makes none", async () => {
    const { deps, capture } = bench();
    const outcomes = await proposeImagesFromSetup(deps, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: ["postgres:18", "postgres:16", "clickhouse/clickhouse-server:24", "postgres:99", "not an image", "ghcr.io/acme/mysql:9"] });
    expect(outcomes.map((outcome) => (outcome.status === "refused" ? `refused:${outcome.reason}` : outcome.status))).toEqual(["waiting", "covered", "refused:no_profile", "refused:no_digest", "refused:not_a_reference", "waiting"]);
    const waiting = await deps.store.list(TEST_ORG);
    expect(waiting.map((image) => [image.status, image.origin, image.project, image.family])).toEqual(expect.arrayContaining([["proposed", "setup", NAME, "postgres"], ["proposed", "setup", NAME, "mysql"]]));
    expect(waiting).toHaveLength(2);
    for (const image of waiting) expect(serviceImageServed({ catalog, edition: "public", approved: waiting, request: { imageId: image.imageId } })).toEqual({ ok: false, reason: "not_approved" });
    expect(capture.recordedBy("company_image.proposed").map((event) => event.facts?.authority)).toEqual(["project_setup", "project_setup"]);
    // Asked again once an admin approved it, the same image is "approved" and makes no second card.
    const [pg] = waiting.filter((image) => image.family === "postgres");
    expect((await approve(deps, pg!)).status).toBe("approved");
    expect((await proposeImagesFromSetup(deps, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: ["postgres:18"] }))[0]).toMatchObject({ status: "approved", imageId: pg!.imageId });
    expect(await deps.store.list(TEST_ORG)).toHaveLength(2);
    const now = await deps.store.list(TEST_ORG);
    const standing = (major: string, digest: string) => companyImageStanding({ catalog, edition: "public", approved: now, family: "postgres", major, name: "docker.io/library/postgres", digest });
    expect([standing("18", sha("pg18")), standing("18", sha("moved")), standing("16", sha("pg16"))]).toEqual(["approved", "changed", "catalog"]);
    // Rovara's list holds Rovara's own images: the same kind and version from another publisher is not "covered".
    const other = (name: string, major: string) => companyImageStanding({ catalog, edition: "public", approved: now, family: "postgres", major, name, digest: sha("x") });
    expect([other("ghcr.io/acme/postgres", "16"), other("docker.io/acme/postgres", "16"), other("docker.io/library/postgres", "16")]).toEqual(["none", "none", "catalog"]);
  });

  it("never throws and holds nothing up: a lookup that throws, a catalog that cannot be read, and a bad caller are quiet", async () => {
    const { deps } = bench();
    const broken: CompanyImageDeps = { ...deps, resolveDigest: async () => { throw new Error("registry says: secret"); } };
    expect((await proposeImagesFromSetup(broken, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: ["postgres:18"] }))[0]).toEqual({ status: "refused", reason: "no_digest" });
    const noCatalog: CompanyImageDeps = { ...deps, catalog: async () => undefined };
    expect((await proposeImagesFromSetup(noCatalog, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: ["postgres:18"] }))[0]).toEqual({ status: "refused", reason: "no_catalog" });
    expect(await proposeImagesFromSetup(deps, { orgId: TEST_ORG, developerId: "not-a-person", project: NAME, images: ["postgres:18"] })).toEqual([]);
    expect(await deps.store.list(TEST_ORG)).toEqual([]);
  });

  it("holds at most the company's cap of waiting images", async () => {
    const { deps } = bench();
    const many = Array.from({ length: COMPANY_IMAGES_MAX_WAITING + 3 }, (_, index) => `ghcr.io/acme/postgres:${String(100 + index)}`);
    for (const [index] of many.entries()) lookup.set(`ghcr.io/acme/postgres:${String(100 + index)}`, sha(`many-${String(index)}`));
    const results: string[] = [];
    for (let at = 0; at < many.length; at += 8) for (const outcome of await proposeImagesFromSetup(deps, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: many.slice(at, at + 8) })) results.push(outcome.status === "refused" ? outcome.reason : outcome.status);
    expect(results.filter((result) => result === "waiting")).toHaveLength(COMPANY_IMAGES_MAX_WAITING);
    expect(results.filter((result) => result === "too_many")).toHaveLength(3);
    expect(await deps.store.list(TEST_ORG)).toHaveLength(COMPANY_IMAGES_MAX_WAITING);
    expect(COMPANY_IMAGES_MAX).toBeGreaterThan(COMPANY_IMAGES_MAX_WAITING);
  });
});

describe("the store", () => {
  const image = (changes: Partial<CompanyImage> = {}): CompanyImage => {
    const digest = changes.digest ?? sha("store-image");
    const base = { registry: "docker.io", repository: "library/postgres" };
    return {
      orgId: TEST_ORG, imageId: companyImageIdOf(base, digest), revision: 1, status: "proposed", ...base, tag: "18", digest, family: "postgres", version: "18", origin: "admin", cycle: "c".repeat(16), proposedBy: ADMIN,
      proposedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...changes,
    };
  };
  const entry = (next: CompanyImage, action: CompanyImageAuditEntry["action"] = "company_image.proposed"): CompanyImageAuditEntry => ({
    orgId: next.orgId, action, actor: ADMIN, at: next.updatedAt, imageId: next.imageId, revision: next.revision, digest: next.digest, authority: "live_admin", cycle: next.cycle, image: "postgres:18",
  });

  it("writes the row and the audit together, reads them back for its own company only, and fences every write at the revision read", async () => {
    const { store, capture } = bench();
    const first = image();
    expect(await store.commit(first, null, entry(first))).toBe(true);
    expect(await store.commit(first, null, entry(first))).toBe(false);
    expect(await store.get(TEST_ORG, first.imageId)).toEqual(first);
    expect(await store.get("org_bbbbbbbbbbbbbbbbbbbb", first.imageId)).toBeUndefined();
    const second = { ...first, status: "approved" as const, revision: 2, approvedBy: ADMIN, approvedAt: first.updatedAt };
    expect(await store.commit(second, 5, entry(second, "company_image.approved"))).toBe(false);
    expect(await store.commit(second, 1, entry(second, "company_image.approved"))).toBe(true);
    expect(await store.remove(first, entry(first, "company_image.revoked"))).toBe(false);
    expect(await store.remove(second, entry({ ...second, revision: 3 }, "company_image.revoked"))).toBe(true);
    expect(await store.get(TEST_ORG, first.imageId)).toBeUndefined();
    expect(capture.recorded().map((event) => event.action)).toEqual(["company_image.proposed", "company_image.approved", "company_image.revoked"]);
    expect(JSON.stringify(capture.recorded().map((event) => event.facts))).not.toContain("postgres");
  });

  it("refuses every write when there is no audit ledger, and a row that is not a company image is no row", async () => {
    const { store, db } = bench({ noAudit: true });
    const first = image();
    await expect(store.commit(first, null, entry(first))).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await store.list(TEST_ORG)).toEqual([]);
    // A row whose id is not its own digest's, or one of another company, is never read as an approval.
    db.set({ pk: `ORG#${TEST_ORG}`, sk: "TESTIMAGE#img_" + "f".repeat(20), entityType: "COMPANY_TEST_IMAGE", ...image({ status: "approved", approvedBy: ADMIN, approvedAt: first.updatedAt }), imageId: "img_" + "f".repeat(20) });
    expect(await store.list(TEST_ORG)).toEqual([]);
  });
});

describe("authority", () => {
  it("approval needs an admin and a fresh sign-in of the same person; a stale card, a digest that moved and a missing catalog refuse; revoke needs an admin", async () => {
    const { deps, capture } = bench();
    await proposeImagesFromSetup(deps, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: ["postgres:18"] });
    const [waiting] = await deps.store.list(TEST_ORG);
    const input = { imageId: waiting!.imageId, expectedRevision: 1, expectedDigest: waiting!.digest };
    await expect(approveImage({ ...bench({ admin: false }).deps, store: deps.store }, caller, input)).rejects.toThrow("FORBIDDEN");
    for (const session of [undefined, { developerId: "b".repeat(64), authTime: new Date(NOW).toISOString() }, { developerId: ADMIN }, { developerId: ADMIN, authTime: new Date(NOW - 11 * 60_000).toISOString() }, { developerId: ADMIN, authTime: new Date(NOW).toISOString(), revokedAt: new Date(NOW).toISOString() }]) {
      await expect(approveImage({ ...deps, readSession: async () => session }, caller, input)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    await expect(approveImage(deps, { ...caller, sessionId: undefined }, input)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(approveImage(deps, caller, { ...input, expectedDigest: sha("moved") })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(approveImage({ ...deps, catalog: async () => undefined }, caller, input)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await deps.store.list(TEST_ORG))[0]).toMatchObject({ status: "proposed", revision: 1 });
    expect(capture.recordedBy("company_image.approved")).toEqual([]);
    await approveImage(deps, caller, input);
    await expect(revokeImage({ ...deps, requireAdmin: async () => { throw new Error("FORBIDDEN"); } }, caller, { imageId: waiting!.imageId, expectedRevision: 2 })).rejects.toThrow("FORBIDDEN");
    expect(await deps.store.list(TEST_ORG)).toHaveLength(1);
    await revokeImage(deps, caller, { imageId: waiting!.imageId, expectedRevision: 2 });
    expect(await deps.store.list(TEST_ORG)).toEqual([]);
  });
});

describe("an environment that names an approved image", () => {
  const dependency = (imageId: string) => ({
    id: "db", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "project_image", imageId },
    connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
  });

  it("is accepted only while tx and pj are on and an admin has approved that exact image; a waiting, unknown or revoked one is refused", async () => {
    const t = await setupWizardBench({ autoCandidate: false, brokerExtra: { serviceCatalog: async () => catalog } });
    const { deps, store } = bench();
    // The bench's own table is the one the broker reads: write through a store over it.
    const own = dynamoCompanyImageStore({ documentClient: t.db, tableName: "state", audit: capturingAuditDeps({ db: t.db, now: () => NOW }).audit });
    const ownDeps: CompanyImageDeps = { ...deps, store: own };
    void store;
    const propose = (imageId: string) => proposeTestEnvironment(
      { documentClient: t.db, tableName: "state", now: () => Date.now(), serviceCatalog: async () => catalog } as never,
      { orgId: TEST_ORG, project: NAME, proposedBy: OMAR.developerId, role: "maintainer", body: draftBody({ dependencies: [dependency(imageId)] }) },
    );
    process.env.TEST_ENVIRONMENT_ENABLED = "1";
    process.env.TEST_SERVICES_ENABLED = "1";
    await proposeImagesFromSetup(ownDeps, { orgId: TEST_ORG, developerId: ADMIN, project: NAME, images: ["postgres:18"] });
    const [waiting] = await own.list(TEST_ORG);
    await expect(propose(waiting!.imageId)).rejects.toThrow(/not available yet/u);
    process.env.PROJECT_IMAGES_ENABLED = "1";
    await expect(propose(waiting!.imageId)).rejects.toThrow(/not been approved/u);
    await expect(propose("img_" + "1".repeat(20))).rejects.toThrow(/not been approved/u);
    await approve(ownDeps, waiting!);
    expect((await propose(waiting!.imageId)).digest).toMatch(/^[a-f0-9]{64}$/u);
    await revokeImage(ownDeps, caller, { imageId: waiting!.imageId, expectedRevision: 2 });
    await expect(propose(waiting!.imageId)).rejects.toThrow(/not been approved/u);
  });
});

describe("with pj off, company images change nothing", () => {
  const dependency = {
    id: "db", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "project_image", imageId: "img_" + "1".repeat(20) },
    connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
  };
  const environment = (): never => ({ revision: 1, environment: draftBody({ dependencies: [dependency] }) } as never);

  it("an environment that names an approved image is used by a task only while pj is on; with pj off it is 'not available yet' and the project's own checks run, as before", () => {
    expect(environmentUnusedReason(environment(), { TEST_SERVICES_ENABLED: "1" })).toBe("dependencies_not_available_yet");
    expect(environmentUnusedReason(environment(), { TEST_SERVICES_ENABLED: "1", PROJECT_IMAGES_ENABLED: "0" })).toBe("dependencies_not_available_yet");
    expect(environmentUnusedReason(environment(), { TEST_SERVICES_ENABLED: "1", PROJECT_IMAGES_ENABLED: "1" })).toBeUndefined();
    expect(environmentUnusedReason(environment(), { PROJECT_IMAGES_ENABLED: "1" })).toBe("dependencies_not_connected");
    // An environment with only catalog dependencies does not care about pj.
    const catalogOnly = { revision: 1, environment: draftBody({ dependencies: [{ ...dependency, backing: { kind: "local", catalogId: "postgres@16", config: {} } }] }) } as never;
    expect(environmentUnusedReason(catalogOnly, { TEST_SERVICES_ENABLED: "1" })).toBeUndefined();
  });
});

describe("the evidence of a company image", () => {
  it("says it is the company's image, never Rovara's", () => {
    const rows = dependencyEvidenceOf([{ id: "db", name: "Postgres", backing: "project_image" }], { dependencies: [{ id: "db", started: true, healthy: true, startMs: 800, resetCount: 1 }], unknownCalls: { domains: [], otherCount: 0 } } as never);
    expect(rows.dependencies).toMatchObject([{ name: "Postgres", backing: "project_image", label: "real_project_image" }]);
    expect(EVIDENCE_DEPENDENCY_LABEL_WORDS.real_project_image).toBe("real (company-approved image)");
    const notRun = dependencyEvidenceOf([{ id: "db", name: "Postgres", backing: "project_image" }], undefined);
    expect(notRun.dependencies[0]).toMatchObject({ backing: "none", label: "not_available", fellBack: { from: "project_image" } });
  });
});

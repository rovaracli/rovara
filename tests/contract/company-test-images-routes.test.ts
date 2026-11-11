// Company-approved extra test-service images (switches `tx` and `pj`), through the whole broker with live browser sessions: an admin names an image, approves the exact digest the card showed (admin + a fresh sign-in),
// revokes it; a member, a token and the API cannot approve; the catalog still serves; an unapproved or changed image is refused; every change is audited with ids and digests only.
import { afterEach, describe, expect, it } from "vitest";
import { dynamoCompanyImageStore, readCompanyImages } from "../../packages/broker/src/org/company-test-image-store.js";
import { companyImagesOf, serviceImageServed, type CompanyImage } from "../../packages/broker/src/test-env/company-images.js";
import { TaskDependencyPlanSchema, companyImageRepositoryName, type CompanyImageMirrorJob } from "@agentx/contracts";
import { taskDependencyPlansOf } from "../../packages/broker/src/test-env/dependency-plan.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR, type Developer } from "../support/developer-task-broker.js";
import { pinnedCatalog, verifiedCatalog, sha } from "../support/catalog-pinning.js";
import { draftBody, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

afterEach(() => { delete process.env.TEST_SERVICES_ENABLED; delete process.env.PROJECT_IMAGES_ENABLED; });
const PATH = "/v1/app/org/test-images";
const on = () => { process.env.TEST_SERVICES_ENABLED = "1"; process.env.PROJECT_IMAGES_ENABLED = "1"; };
const catalog = verifiedCatalog(pinnedCatalog());

/** The registry's answers by `registry/repository:tag`. A test moves a tag by changing the map. */
function registry() {
  const digests = new Map<string, string>([["docker.io/library/postgres:18", sha("postgres-18-a")], ["docker.io/library/postgres:18.1", sha("postgres-18-b")], ["registry.example.com/acme/postgres:18", sha("own-postgres-18")]]);
  const asked: Array<{ registry: string; extra: readonly string[] | undefined }> = [];
  return { digests, asked, resolve: async (image: { registry: string; repository: string; tag: string }, extra?: readonly string[]) => { asked.push({ registry: image.registry, extra }); return digests.get(`${image.registry}/${image.repository}:${image.tag}`); } };
}
async function bench(options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const lookup = registry();
  const jobs: CompanyImageMirrorJob[] = [];
  const t = await setupWizardBench({ audit, brokerExtra: { serviceCatalog: async () => catalog, companyImageResolver: lookup.resolve, companyImageMirrorStart: async (job: CompanyImageMirrorJob) => { jobs.push(job); } } });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, audit, lookup, jobs };
}
const events = (audit: ReturnType<typeof capturingAuditDeps>, prefix = "company_image.") => audit.recorded().filter((event) => event.action.startsWith(prefix));
const get = (t: Bench, who: Developer = OMAR) => t.web(who, "GET", PATH);
const post = (t: Bench, body: unknown, who: Developer = OMAR) => t.web(who, "POST", PATH, body);
interface Row { imageId: string; revision: number; status: string; digest: string; image: string; family: string }
const list = async (t: Bench, who: Developer = OMAR) => (await get(t, who)).body as unknown as { images: Row[]; kinds: string[]; catalogAvailable: boolean };
const rows = (t: Bench) => t.db.find((item) => String(item.sk).startsWith("TESTIMAGE#"));
const stored = (t: Bench) => readCompanyImages({ documentClient: t.db, tableName: "state" }, TEST_ORG);
/** Adds `postgres:18` and approves what the card showed. */
async function approvePostgres(t: Bench, image = "postgres:18"): Promise<Row> {
  expect((await post(t, { action: "add", image })).status).toBe(200);
  const waiting = (await list(t)).images.find((row) => row.status === "proposed")!;
  const done = await post(t, { action: "approve", imageId: waiting.imageId, expectedRevision: waiting.revision, expectedDigest: waiting.digest });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return (await list(t)).images.find((row) => row.imageId === waiting.imageId)!;
}

describe("behind tx and pj", () => {
  it("every path is not found unless both switches are exactly 1, and nothing is stored", async () => {
    const { t } = await bench();
    for (const [tx, pj] of [[undefined, undefined], ["1", undefined], [undefined, "1"], ["1", "0"], ["true", "1"], [" 1", "1"]] as const) {
      for (const [name, value] of [["TEST_SERVICES_ENABLED", tx], ["PROJECT_IMAGES_ENABLED", pj]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      expect((await get(t)).status, String([tx, pj])).toBe(404);
      expect((await post(t, { action: "add", image: "postgres:18" })).status).toBe(404);
    }
    expect(rows(t)).toEqual([]);
  });
});

describe("who may", () => {
  it("a member cannot list, add, approve or revoke; a token and the API can read but never change; nothing is stored or audited", async () => {
    const { t, audit } = await bench({ maya: "member" });
    on();
    await approvePostgres(t);
    const [row] = (await list(t)).images;
    const before = JSON.stringify(rows(t));
    const eventsBefore = events(audit).length;
    expect((await get(t, MAYA)).status).toBe(403);
    for (const body of [{ action: "add", image: "postgres:17.5" }, { action: "approve", imageId: row!.imageId, expectedRevision: row!.revision, expectedDigest: row!.digest }, { action: "revoke", imageId: row!.imageId, expectedRevision: row!.revision }]) {
      expect((await post(t, body, MAYA)).status, JSON.stringify(body)).toBe(403);
      const api = await t.dev(OMAR, "POST", PATH, body);
      expect(api.status).toBe(403);
      expect(JSON.stringify(api.body)).toContain("Use a live browser session");
    }
    // The API (a signed-in admin without a browser session) may read.
    const read = await t.dev(OMAR, "GET", PATH);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body as { images: Row[] }).images.map((image) => image.imageId)).toEqual([row!.imageId]);
    expect(JSON.stringify(rows(t))).toBe(before);
    expect(events(audit)).toHaveLength(eventsBefore);
  });

  it("a member cannot approve a waiting image even when it is the exact digest on the card", async () => {
    const { t } = await bench({ maya: "member" });
    on();
    await post(t, { action: "add", image: "postgres:18" });
    const [waiting] = (await list(t)).images;
    const refused = await post(t, { action: "approve", imageId: waiting!.imageId, expectedRevision: 1, expectedDigest: waiting!.digest }, MAYA);
    expect(refused.status).toBe(403);
    expect((await list(t)).images[0]).toMatchObject({ status: "proposed" });
    expect((await stored(t)).filter((image) => image.status === "approved")).toEqual([]);
  });

  it("refuses a body that is not one of the actions, with field names only", async () => {
    const { t } = await bench();
    on();
    for (const body of [{ action: "approve", imageId: "nope" }, { action: "add", image: "postgres:18", extra: 1 }, { action: "shrug" }, { action: "add", image: "" }]) expect((await post(t, body)).status).toBe(400);
  });
});

describe("the company's own registries and the copy into the install's registry", () => {
  const registries = async (t: Bench, who: Developer = OMAR) => ((await get(t, who)).body as unknown as { registries: { revision: number; hosts: string[] } }).registries;

  it("an image from a registry that is not on the company's list is refused before any lookup; an admin adds the registry from a live browser session, and then it can be named", async () => {
    const { t, audit, lookup } = await bench();
    on();
    expect(await registries(t)).toEqual({ revision: 0, hosts: [] });
    const refused = await post(t, { action: "add", image: "registry.example.com/acme/postgres:18" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("not on your company's list");
    expect((await post(t, { action: "add", image: "ghcr.io.evil.example.com/acme/postgres:18" })).status).toBe(400);
    expect(lookup.asked).toEqual([]);
    expect((await post(t, { action: "add_registry", host: "registry.example.com", expectedRevision: 0 })).status).toBe(200);
    expect(await registries(t)).toEqual({ revision: 1, hosts: ["registry.example.com"] });
    expect((await post(t, { action: "add", image: "registry.example.com/acme/postgres:18" })).status).toBe(200);
    expect(lookup.asked).toEqual([{ registry: "registry.example.com", extra: ["registry.example.com"] }]);
    expect((await list(t)).images.map((row) => row.status)).toEqual(["proposed"]);
    expect(events(audit, "company_image.registries_changed").map((event) => event.facts)).toEqual([{ registryCount: 1, authority: "fresh_sign_in" }]);
    expect((await post(t, { action: "remove_registry", host: "registry.example.com", expectedRevision: 1 })).status).toBe(200);
    expect(await registries(t)).toEqual({ revision: 2, hosts: [] });
  });

  it("a member, a token and the API cannot change the registry list; a bad host, a stale revision and an unknown host are refused; nothing is stored or audited for any of them", async () => {
    const { t, audit } = await bench({ maya: "member" });
    on();
    await post(t, { action: "add_registry", host: "registry.example.com", expectedRevision: 0 });
    const before = JSON.stringify(t.db.find((item) => item.sk === "TESTIMAGE_REGISTRIES"));
    const eventsBefore = events(audit, "company_image.registries_changed").length;
    for (const body of [{ action: "add_registry", host: "other.example.com", expectedRevision: 1 }, { action: "remove_registry", host: "registry.example.com", expectedRevision: 1 }]) {
      expect((await post(t, body, MAYA)).status, JSON.stringify(body)).toBe(403);
      const api = await t.dev(OMAR, "POST", PATH, body);
      expect(api.status).toBe(403);
      expect(JSON.stringify(api.body)).toContain("Use a live browser session");
    }
    expect((await get(t, MAYA)).status).toBe(403);
    for (const body of [{ action: "add_registry", host: "https://registry.example.com", expectedRevision: 1 }, { action: "add_registry", host: "10.0.0.1", expectedRevision: 1 }, { action: "add_registry", host: "ghcr.io", expectedRevision: 1 }]) expect((await post(t, body)).status, JSON.stringify(body)).toBe(400);
    expect((await post(t, { action: "add_registry", host: "other.example.com", expectedRevision: 0 })).status).toBe(409);
    expect((await post(t, { action: "remove_registry", host: "unknown.example.com", expectedRevision: 1 })).status).toBe(404);
    expect((await post(t, { action: "remove_registry", host: "registry.example.com", expectedRevision: 7 })).status).toBe(409);
    expect((await post(t, { action: "add_registry", host: "x.example.com", expectedRevision: 1, extra: true })).status).toBe(400);
    expect(JSON.stringify(t.db.find((item) => item.sk === "TESTIMAGE_REGISTRIES"))).toBe(before);
    expect(events(audit, "company_image.registries_changed")).toHaveLength(eventsBefore);
  });

  it("approving starts the copy and the card says so until it is finished; revoking deletes the copy", async () => {
    const { t, jobs } = await bench();
    on();
    const approved = await approvePostgres(t);
    expect(jobs.map((job) => job.action)).toEqual(["copy"]);
    expect(jobs[0]).toMatchObject({ imageId: approved.imageId, registry: "docker.io", extraRegistries: [] });
    expect((await list(t)).images[0]).toMatchObject({ status: "approved", copy: "none" });
    const key = { pk: `COMPANY_IMAGE_MIRROR#${TEST_ORG}`, sk: approved.imageId };
    const base = { ...key, entityType: "COMPANY_IMAGE_MIRROR", digest: approved.digest, repository: `rovara-env/staging/o${"1".repeat(32)}/c${"2".repeat(32)}`, attempts: 1, startedAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z" };
    for (const state of ["copying", "failed", "ready"] as const) {
      t.db.set({ ...base, state, ...(state === "failed" ? { reason: "no_arm64" } : {}) });
      expect((await list(t)).images[0], state).toMatchObject({ copy: state });
    }
    // A state for another digest says nothing about this image.
    t.db.set({ ...base, state: "ready", digest: sha("another") });
    expect((await list(t)).images[0]).toMatchObject({ copy: "none" });
    const revoked = await post(t, { action: "revoke", imageId: approved.imageId, expectedRevision: approved.revision });
    expect(revoked.status).toBe(200);
    expect(jobs.at(-1)).toMatchObject({ action: "delete", imageId: approved.imageId });
  });
});

describe("naming, approving and revoking", () => {
  it("naming an image only makes it wait: the row pins the digest the registry gave, nothing is served, and the audit holds ids only", async () => {
    const { t, audit, lookup } = await bench();
    on();
    expect((await post(t, { action: "add", image: "postgres:18" })).status).toBe(200);
    const [row] = (await list(t)).images;
    expect(row).toMatchObject({ status: "proposed", revision: 1, digest: lookup.digests.get("docker.io/library/postgres:18"), image: "postgres:18", family: "postgres" });
    const images = await stored(t);
    expect(serviceImageServed({ catalog, edition: "public", approved: images, request: { imageId: row!.imageId } })).toEqual({ ok: false, reason: "not_approved" });
    const [event] = events(audit, "company_image.proposed");
    expect(event).toMatchObject({ actor: { id: OMAR.developerId }, facts: { imageId: row!.imageId, digest: row!.digest, authority: "live_admin" } });
    expect(JSON.stringify(event?.facts)).not.toContain("postgres");
    // Naming it again changes nothing.
    expect((await post(t, { action: "add", image: "postgres:18" })).status).toBe(200);
    expect(rows(t).filter((item) => String(item.sk).startsWith("TESTIMAGE#img_"))).toHaveLength(1);
  });

  it("approves exactly the digest the card showed, needs an admin with a sign-in in the last 10 minutes, and audits the approval", async () => {
    const { t, audit, lookup } = await bench();
    on();
    await post(t, { action: "add", image: "postgres:18" });
    const [waiting] = (await list(t)).images;
    const approve = { action: "approve", imageId: waiting!.imageId, expectedRevision: 1, expectedDigest: waiting!.digest };
    for (const minutes of [11, undefined]) {
      t.ageSignIn(OMAR, minutes);
      const stale = await post(t, approve);
      expect(stale.status, JSON.stringify(stale.body)).toBe(403);
      expect(JSON.stringify(stale.body)).toContain("REAUTH_REQUIRED");
    }
    expect((await list(t)).images[0]).toMatchObject({ status: "proposed", revision: 1 });
    expect(events(audit, "company_image.approved")).toEqual([]);
    t.ageSignIn(OMAR, 9);
    // A digest other than the one the card showed (the tag moved under the admin) is stale.
    expect((await post(t, { ...approve, expectedDigest: sha("something else") })).status).toBe(409);
    expect((await post(t, { ...approve, expectedRevision: 2 })).status).toBe(409);
    expect((await post(t, approve)).status).toBe(200);
    expect((await list(t)).images[0]).toMatchObject({ status: "approved", revision: 2, digest: lookup.digests.get("docker.io/library/postgres:18") });
    expect(events(audit, "company_image.approved")[0]).toMatchObject({ actor: { id: OMAR.developerId }, facts: { imageId: waiting!.imageId, digest: waiting!.digest, authority: "fresh_sign_in" } });
  });

  it("revokes an approved image: it is served no more, the row is gone, and the revoke is audited; a waiting image can be dismissed", async () => {
    const { t, audit } = await bench();
    on();
    const approved = await approvePostgres(t);
    const served = () => stored(t).then((images) => serviceImageServed({ catalog, edition: "public", approved: images, request: { imageId: approved.imageId } }));
    expect(await served()).toMatchObject({ ok: true, source: "company", digest: approved.digest });
    expect((await post(t, { action: "revoke", imageId: approved.imageId, expectedRevision: 1 })).status).toBe(409);
    expect((await post(t, { action: "revoke", imageId: approved.imageId, expectedRevision: approved.revision })).status).toBe(200);
    expect(await served()).toEqual({ ok: false, reason: "not_approved" });
    expect((await list(t)).images).toEqual([]);
    expect(rows(t).filter((item) => String(item.sk).startsWith("TESTIMAGE#img_"))).toEqual([]);
    expect(events(audit).map((event) => `${event.action}@${String(event.facts?.authority)}`)).toEqual(["company_image.proposed@live_admin", "company_image.approved@fresh_sign_in", "company_image.revoked@live_admin"]);
    // Revoking is not repeated, and a dismissed proposal leaves the same trace.
    expect((await post(t, { action: "revoke", imageId: approved.imageId, expectedRevision: 2 })).status).toBe(404);
    await post(t, { action: "add", image: "postgres:18.1" });
    const [waiting] = (await list(t)).images;
    expect((await post(t, { action: "revoke", imageId: waiting!.imageId, expectedRevision: 1 })).status).toBe(200);
    expect((await list(t)).images).toEqual([]);
  });

  it("approve, revoke, approve again, revoke again: every round reaches the ledger with event ids of its own (a repeated id would be dropped as a duplicate)", async () => {
    const { t, audit } = await bench();
    on();
    let approved = await approvePostgres(t);
    expect((await post(t, { action: "revoke", imageId: approved.imageId, expectedRevision: approved.revision })).status).toBe(200);
    // The same image at the same digest, a week later: its row starts again at revision 1.
    const again = await approvePostgres(t);
    expect(again.imageId).toBe(approved.imageId);
    expect(again.revision).toBe(2);
    expect((await post(t, { action: "revoke", imageId: again.imageId, expectedRevision: again.revision })).status).toBe(200);
    approved = await approvePostgres(t);
    const all = events(audit);
    expect(all.map((event) => event.action)).toEqual([
      "company_image.proposed", "company_image.approved", "company_image.revoked", "company_image.proposed", "company_image.approved", "company_image.revoked", "company_image.proposed", "company_image.approved",
    ]);
    expect(new Set(all.map((event) => (event as { eventId: string }).eventId)).size).toBe(8);
    expect(all.filter((event) => event.action === "company_image.approved").map((event) => event.facts?.imageId)).toEqual([approved.imageId, approved.imageId, approved.imageId]);
  });

  it("flags an image that is not an official one on the admin's card, and not one that is", async () => {
    const { t, lookup } = await bench();
    on();
    lookup.digests.set("ghcr.io/acme/postgres:16", sha("acme-pg16"));
    await post(t, { action: "add", image: "postgres:18" });
    await post(t, { action: "add", image: "ghcr.io/acme/postgres:16" });
    const images = (await list(t)).images as Array<Row & { official: boolean }>;
    expect(images.map((image) => [image.image, image.official]).sort()).toEqual([["acme/postgres:16", false], ["postgres:18", true]]);
  });

  it("a tag that moved is another digest: the old approval never serves it, and it waits for its own approval", async () => {
    const { t, lookup } = await bench();
    on();
    const first = await approvePostgres(t);
    const moved = sha("postgres-18-moved");
    lookup.digests.set("docker.io/library/postgres:18", moved);
    expect((await post(t, { action: "add", image: "postgres:18" })).status).toBe(200);
    const images = (await list(t)).images;
    const waiting = images.find((row) => row.status === "proposed")!;
    expect(waiting.digest).toBe(moved);
    expect(waiting.imageId).not.toBe(first.imageId);
    const approved = await stored(t);
    // The name at the new digest is "changed", not served; the old pin keeps serving only the old digest.
    expect(serviceImageServed({ catalog, edition: "public", approved, request: { name: "docker.io/library/postgres", digest: moved } })).toEqual({ ok: false, reason: "digest_changed" });
    expect(serviceImageServed({ catalog, edition: "public", approved, request: { imageId: first.imageId, digest: moved } })).toEqual({ ok: false, reason: "digest_changed" });
    expect(serviceImageServed({ catalog, edition: "public", approved, request: { imageId: first.imageId, digest: first.digest } })).toMatchObject({ ok: true });
    expect((await post(t, { action: "approve", imageId: waiting.imageId, expectedRevision: 1, expectedDigest: moved })).status).toBe(200);
    expect(serviceImageServed({ catalog, edition: "public", approved: await stored(t), request: { name: "docker.io/library/postgres", digest: moved } })).toMatchObject({ ok: true, source: "company", digest: moved });
  });

  it("refuses what Rovara cannot run or look up, in fixed words and with nothing stored", async () => {
    const { t } = await bench();
    on();
    const token = ["g", "hp_"].join("") + "a".repeat(36);
    for (const image of [
      "clickhouse/clickhouse-server:24", `https://user:${token}@evil.example.com/postgres:18`, "postgres", "postgres:latest", `postgres@sha256:${"a".repeat(64)}`,
      "10.0.0.5/library/postgres:18", "registry.corp.internal/postgres:18", "localhost/postgres:18", "Postgres:18", "postgres:99",
    ]) {
      const refused = await post(t, { action: "add", image });
      expect(refused.status, image).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain(token);
    }
    expect(rows(t)).toEqual([]);
  });

  it("does not propose an image Rovara's list already has at that version: the catalog is the default allow set", async () => {
    const { t, lookup } = await bench();
    on();
    lookup.digests.set("docker.io/library/postgres:16", sha("postgres-16"));
    expect((await post(t, { action: "add", image: "postgres:16" })).status).toBe(200);
    expect((await list(t)).images).toEqual([]);
    // The same kind and version from another publisher is not Rovara's image: it is proposed.
    lookup.digests.set("ghcr.io/acme/postgres:16", sha("acme-pg16"));
    expect((await post(t, { action: "add", image: "ghcr.io/acme/postgres:16" })).status).toBe(200);
    expect((await list(t)).images.map((image) => image.status)).toEqual(["proposed"]);
    expect((await list(t)).kinds).toEqual(expect.arrayContaining(["postgres", "mysql", "redis"]));
  });
});

describe("what a run is told", () => {
  const dependency = (imageId: string) => ({
    id: "db", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "project_image", imageId },
    connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
  });
  // The finished copies of the approved images in the install's registry (what the mirror records), by image id.
  const mirrorsOf = (images: readonly CompanyImage[] | undefined): Map<string, { repository: string; digest: string }> =>
    new Map((images ?? []).filter((image) => image.status === "approved").map((image) => [image.imageId, { repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: image.imageId }), digest: image.digest }]));
  const plan = (imageId: string, companyImages: readonly CompanyImage[] | undefined, edition: "public" | "enterprise" = "public", mirrors: ReadonlyMap<string, { repository: string; digest: string }> | undefined = mirrorsOf(companyImages)) => taskDependencyPlansOf({
    body: draftBody({ dependencies: [dependency(imageId)] }), catalog, edition, projectId: "web", ...(companyImages === undefined ? {} : { companyImages }), companyMirrors: mirrors,
  });

  it("serves the catalog as before, and an approved image with the approved digest and the catalog's own run profile", async () => {
    const { t } = await bench();
    on();
    const approved = await approvePostgres(t);
    const images = await stored(t);
    expect(serviceImageServed({ catalog, edition: "public", approved: images, request: { catalogId: "postgres@16" } })).toMatchObject({ ok: true, source: "catalog", catalogId: "postgres@16" });
    const planned = plan(approved.imageId, images);
    expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
    const [entry] = (planned as { dependencies: Array<{ backing: string; catalogId: string; repository: string; digest: string; company?: unknown }> }).dependencies;
    // The profile is the signed catalog's postgres entry; the digest is the approved one; and the plan says in its own words that it is a COMPANY image, from where, under which approval: never a catalog plan.
    expect(entry).toMatchObject({ backing: "company", catalogId: "postgres@16", repository: "svc/postgres", digest: approved.digest, company: { imageId: approved.imageId, registry: "docker.io", repository: "library/postgres", digest: approved.digest, mirror: { repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: approved.imageId }), digest: approved.digest } } });
    expect(TaskDependencyPlanSchema.safeParse(entry).success).toBe(true);
    // A company block on a catalog plan, a company plan with no block, and one that runs another digest than the approved one are not plans at all.
    const withCatalog = { ...(entry as object), backing: "local" };
    const withoutBlock = { ...(entry as object), company: undefined };
    const otherDigest = { ...(entry as { digest: string }), digest: sha("tampered") };
    // The mirrored copy must be exactly the approved digest too.
    const company = (entry as unknown as { company: { mirror: object } }).company;
    const otherMirror = { ...(entry as object), company: { ...company, mirror: { ...company.mirror, digest: sha("another copy") } } };
    expect([withCatalog, withoutBlock, otherDigest, otherMirror].map((plan) => TaskDependencyPlanSchema.safeParse(plan).success)).toEqual([false, false, false, false]);
    // Approved but not copied into the install's registry yet (no finished copy, or a copy of another digest): no plan, in the words "still being copied". The worker never pulls from the source.
    expect(plan(approved.imageId, images, "public", new Map())).toEqual({ ok: false, reason: "image_copying" });
    expect(plan(approved.imageId, images, "public", new Map([[approved.imageId, { repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: approved.imageId }), digest: sha("old copy") }]]))).toEqual({ ok: false, reason: "image_copying" });
  });

  it("refuses an image that is waiting, never approved, revoked, changed, or has no list at all; and a catalog that cannot be read", async () => {
    const { t } = await bench();
    on();
    await post(t, { action: "add", image: "postgres:18" });
    const [waiting] = await stored(t);
    expect(plan(waiting!.imageId, [waiting!])).toEqual({ ok: false, reason: "image_not_approved" });
    expect(plan("img_" + "0".repeat(20), await stored(t))).toEqual({ ok: false, reason: "image_not_approved" });
    expect(plan(waiting!.imageId, [])).toEqual({ ok: false, reason: "image_not_approved" });
    // With pj off no list is given at all: a company image is "not available yet", as before company images existed.
    expect(plan(waiting!.imageId, undefined)).toEqual({ ok: false, reason: "not_available_yet" });
    // ... even with a finished copy on record: pj off means no company image, and no plan reads the mirror's state.
    expect(plan(waiting!.imageId, undefined, "public", new Map([[waiting!.imageId, { repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: waiting!.imageId }), digest: waiting!.digest }]]))).toEqual({ ok: false, reason: "not_available_yet" });
    const approved = await approvePostgres(t);
    expect(plan(approved.imageId, await stored(t))).toMatchObject({ ok: true });
    await post(t, { action: "revoke", imageId: approved.imageId, expectedRevision: approved.revision });
    expect(plan(approved.imageId, await stored(t))).toEqual({ ok: false, reason: "image_not_approved" });
    const tampered: CompanyImage = { ...(approved as unknown as CompanyImage), digest: sha("other") };
    expect(serviceImageServed({ catalog, edition: "public", approved: [], request: { imageId: tampered.imageId, digest: tampered.digest } })).toEqual({ ok: false, reason: "not_approved" });
    expect(taskDependencyPlansOf({ body: draftBody({ dependencies: [dependency(approved.imageId)] }), catalog: undefined, edition: "public" })).toEqual({ ok: false, reason: "no_catalog" });
  });

  it("refuses an image of another kind than the dependency's, even when it is approved", async () => {
    const { t } = await bench();
    on();
    const approved = await approvePostgres(t);
    const images = await stored(t);
    const mysql = { ...dependency(approved.imageId), family: "mysql", kind: "database", name: "MySQL" };
    const planned = taskDependencyPlansOf({ body: draftBody({ dependencies: [mysql] }), catalog, edition: "public", projectId: "web", companyImages: images });
    expect(planned).toEqual({ ok: false, reason: "not_available_yet" });
  });

  it("keeps the company's rows apart: another company's approval is never an approval", async () => {
    const { t } = await bench();
    on();
    const approved = await approvePostgres(t);
    const mine = await stored(t);
    expect(mine).toHaveLength(1);
    const store = dynamoCompanyImageStore({ documentClient: t.db, tableName: "state" });
    expect(await store.list(("org_" + "1".repeat(20)) as never)).toEqual([]);
    expect(await store.get(("org_" + "1".repeat(20)) as never, approved.imageId)).toBeUndefined();
    // A row that parses but names another company is dropped by the filter itself, whatever key it was read from.
    const foreign = { ...mine[0]!, orgId: "org_" + "1".repeat(20) };
    expect(companyImagesOf([foreign, mine[0]], TEST_ORG)).toEqual(mine);
    expect(companyImagesOf([foreign], TEST_ORG)).toEqual([]);
  });
});

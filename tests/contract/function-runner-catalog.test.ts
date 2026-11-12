import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CatalogEntrySchema, ServiceCatalogSchema, catalogPins, catalogPrepullList, catalogRepositories, sha256HexOf, type ServiceCatalog } from "@rovara-code/contracts";
import {
  checkMirrorServesDigest, resolveCatalogImage, FUNCTION_RUNNER_AGENT_ID, FUNCTION_RUNNER_CATALOG_IDS, FUNCTION_RUNNER_PLATFORM, FUNCTION_RUNNER_PREPULL_MAX_IMAGES, FUNCTION_RUNNER_REPOSITORIES, FUNCTION_RUNNER_RUNTIME_IMAGES, FunctionRunnerPrepullListSchema,
  functionRunnerImageReference, functionRunnerPrepullList, isFunctionRunnerCatalogId, isFunctionRunnerEntry, isFunctionRunnerFamily, isFunctionRunnerRepository, servicesPrepullList, TaskDependencyPlanSchema, TEST_SERVICES_FUNCTIONS_PLAN_FEATURE, WORKER_INVOCATION_FEATURES,
} from "@agentx/cloud-contracts";
import { isPrepulledEntry } from "../../packages/broker/src/test-env/dependency-plan.js";
import { profileEntryOf, serviceImageServed } from "../../packages/broker/src/test-env/company-images.js";
import { digestOfId, pinnedCatalogWithRunner, sha, shippedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

// Slice 4, lane C1: the function runner's catalog entries (UNPINNED, to join the signed catalog at its next revision) and the rules that keep them out of the services pre-pull and out of dependency plans.
const ENTRIES_FILE = "environments/service-catalog/function-runner-entries.json";
const entriesText = readFileSync(ENTRIES_FILE, "utf8");
const entriesRaw = (JSON.parse(entriesText) as { schemaVersion: number; entries: Array<Record<string, unknown>> }).entries;
const shippedRaw = () => JSON.parse(readFileSync("environments/service-catalog/catalog.json", "utf8")) as { revision: number; pinned: boolean; entries: Array<Record<string, unknown>> };

/** The shipped (signed) catalog's entries plus the runner's, as the next revision would hold them. `pinRunner` pins the runner's entries with test digests (never real ones). */
function nextCatalog(pinRunner: boolean): ServiceCatalog {
  const raw = shippedRaw();
  raw.revision += 1;
  const added = (JSON.parse(entriesText) as { entries: Array<Record<string, unknown>> }).entries;
  if (pinRunner) {
    for (const entry of added) {
      const id = entry["id"] as string;
      (entry["image"] as { digest?: string }).digest = digestOfId(id);
      entry["sbomRef"] = sha(`sbom:${id}`);
      entry["scan"] = { scannedAt: "2026-11-12T00:00:00.000Z", criticalOpen: 0, highOpen: 0 };
    }
  }
  raw.entries.push(...added);
  return ServiceCatalogSchema.parse(raw);
}

describe("function-runner-entries.json", () => {
  it("holds exactly the runner's five entries: four AWS Lambda base images and the agent, every one a valid, UNPINNED catalog entry for linux/arm64 only", () => {
    expect(entriesRaw.map((entry) => entry["id"]).sort()).toEqual([...FUNCTION_RUNNER_CATALOG_IDS]);
    expect(Object.values(FUNCTION_RUNNER_RUNTIME_IMAGES).every((id) => entriesRaw.some((entry) => entry["id"] === id))).toBe(true);
    for (const entry of entriesRaw) {
      const parsed = CatalogEntrySchema.parse(entry);
      expect(parsed.image.platforms, parsed.id).toEqual([FUNCTION_RUNNER_PLATFORM]);
      expect(parsed.image.digest, parsed.id).toBeUndefined();
      expect(parsed.sbomRef, parsed.id).toBeUndefined();
      expect(parsed.scan, parsed.id).toBeUndefined();
      expect(parsed.status, parsed.id).toBe("available");
      expect(parsed.backing, parsed.id).toBe("local");
      expect(parsed.image.repository, parsed.id).toBe(`svc/${parsed.family}`);
      expect(FUNCTION_RUNNER_REPOSITORIES, parsed.id).toContain(parsed.image.repository);
    }
    expect([...new Set(entriesRaw.map((entry) => (entry["image"] as { repository: string }).repository))].sort()).toEqual([...FUNCTION_RUNNER_REPOSITORIES]);
  });

  it("is placeholder-free: no digest, hash, SBOM, scan time or any 64-hex string anywhere in the file (a pin comes only from catalog-build)", () => {
    expect(entriesText).not.toMatch(/[a-f0-9]{64}/u);
    expect(entriesText).not.toMatch(/sha256|sbomRef|scannedAt|"digest"|TODO|placeholder|0{16}/iu);
    // And no tag-shaped upstream reference: the file names no registry or image at all.
    expect(entriesText).not.toMatch(/public\.ecr\.aws|docker\.io|:latest|@sha/u);
  });

  it("joins the shipped signed catalog without breaking it: the next revision parses unpinned (the shipped pins untouched) and with the runner pinned, and no runner entry is in the shipped file", () => {
    const shipped = shippedCatalog();
    expect(shipped.entries.some((entry) => isFunctionRunnerCatalogId(entry.id))).toBe(false);
    const unpinned = nextCatalog(false);
    expect(unpinned.entries).toHaveLength(shipped.entries.length + 5);
    // The shipped entries are carried over unchanged (including postgres@16 and local-aws@r1 with their pins).
    for (const entry of shipped.entries) expect(unpinned.entries.find((candidate) => candidate.id === entry.id)).toEqual(entry);
    expect(catalogPins(unpinned).map((pin) => pin.id).sort()).toEqual(catalogPins(shipped).map((pin) => pin.id).sort());
    const pinned = nextCatalog(true);
    expect(catalogPins(pinned).filter((pin) => isFunctionRunnerCatalogId(pin.id)).map((pin) => pin.id)).toEqual(expect.arrayContaining([...FUNCTION_RUNNER_CATALOG_IDS]));
    // One default per family still holds; the new families have none.
    expect(pinned.entries.filter((entry) => isFunctionRunnerCatalogId(entry.id) && entry.status === "default")).toEqual([]);
  });

  it("needs the registry repositories the control plane creates: the runner's repositories are exactly the next revision's new ones", () => {
    const shippedRepositories = catalogRepositories(shippedCatalog());
    const next = catalogRepositories(nextCatalog(false));
    expect(next.filter((repository) => !shippedRepositories.includes(repository))).toEqual([...FUNCTION_RUNNER_REPOSITORIES]);
  });
});

describe("keeping the runner's images out of the services pre-pull and out of plans", () => {
  const pinned = nextCatalog(true);
  it("shows the hazard the guards answer: the vendored pre-pull list holds EVERY pinned local entry, so the runner's images would be pulled as services", () => {
    const vendored = catalogPrepullList(pinned).images.map((image) => image.id);
    for (const id of FUNCTION_RUNNER_CATALOG_IDS) expect(vendored).toContain(id);
  });

  it("servicesPrepullList leaves them out and everything else as it was; functionRunnerPrepullList holds only them", () => {
    const services = servicesPrepullList(pinned);
    expect(services.images.map((image) => image.id).sort()).toEqual(catalogPrepullList(shippedCatalog()).images.map((image) => image.id).sort());
    expect(services.images.some((image) => isFunctionRunnerCatalogId(image.id))).toBe(false);
    const runner = functionRunnerPrepullList(pinned);
    expect(runner.images.map((image) => image.id)).toEqual([...FUNCTION_RUNNER_CATALOG_IDS]);
    expect(runner.catalogRevision).toBe(pinned.revision);
    for (const image of runner.images) {
      expect(image.platforms).toEqual(["linux/arm64"]);
      expect(image.digest).toBe(digestOfId(image.id));
    }
  });

  it("gives the empty runner list for the shipped catalog (nothing pinned yet), and for entries that are not pinned or are retired", () => {
    expect(functionRunnerPrepullList(shippedCatalog()).images).toEqual([]);
    expect(functionRunnerPrepullList(nextCatalog(false)).images).toEqual([]);
    const retired = nextCatalog(true);
    const python = retired.entries.find((entry) => entry.id === "lambda-python@3.12")!;
    python.status = "retired";
    expect(functionRunnerPrepullList(retired).images.map((image) => image.id)).not.toContain("lambda-python@3.12");
  });

  it("the broker never lets a plan start one of them as a dependency, pinned or not (isPrepulledEntry is false for every runner id and still true for postgres@16)", () => {
    const verified = verifiedCatalog(pinned);
    for (const id of FUNCTION_RUNNER_CATALOG_IDS) expect(isPrepulledEntry(verified, id), id).toBe(false);
    expect(isPrepulledEntry(verified, "postgres@16")).toBe(true);
    expect(isPrepulledEntry(verified, "local-aws@r1")).toBe(true);
  });

  it("is keyed on the FAMILY and the repository, not a list of ids: a runtime added later (lambda-python@3.14, lambda-provided@al2023, an entry in a runner repository under another name) is a runner entry the day it is pinned", () => {
    const later = [
      { id: "lambda-python@3.14", family: "lambda-python", repository: "svc/lambda-python" },
      { id: "lambda-provided@al2023", family: "lambda-provided", repository: "svc/lambda-provided" },
      { id: "function-agent@r2", family: "function-agent", repository: "svc/function-agent" },
      { id: "pyrt@1", family: "pyrt", repository: "svc/lambda-python" },
    ];
    const catalog = pinnedCatalogWithRunner(later);
    const verified = verifiedCatalog(catalog);
    for (const entry of catalog.entries.filter((candidate) => isFunctionRunnerEntry(candidate))) {
      expect(isPrepulledEntry(verified, entry.id), entry.id).toBe(false);
      expect(servicesPrepullList(catalog).images.map((image) => image.id), entry.id).not.toContain(entry.id);
      expect(functionRunnerPrepullList(catalog).images.map((image) => image.id), entry.id).toContain(entry.id);
    }
    for (const entry of later) expect(isFunctionRunnerEntry({ id: entry.id, family: entry.family, image: { repository: entry.repository } }), entry.id).toBe(true);
    // Every entry of the catalog that lives in one of the runner's repositories is a runner entry, whatever its id or family says.
    for (const entry of catalog.entries) {
      if (FUNCTION_RUNNER_REPOSITORIES.includes(entry.image.repository)) expect(isFunctionRunnerEntry(entry), entry.id).toBe(true);
      else if (!entry.family.startsWith("lambda-") && entry.family !== "function-agent") expect(isFunctionRunnerEntry(entry), entry.id).toBe(false);
    }
    // The services stay as they were.
    expect(servicesPrepullList(catalog).images.map((image) => image.id).sort()).toEqual(servicesPrepullList(pinnedCatalogWithRunner()).images.map((image) => image.id).sort());
    expect(isPrepulledEntry(verified, "postgres@16")).toBe(true);
    // The predicates by name.
    for (const family of ["lambda-python", "lambda-anything", "function-agent"]) expect(isFunctionRunnerFamily(family), family).toBe(true);
    for (const family of ["postgres", "local-aws", "lambda", "my-lambda-x", "function-agentx"]) expect(isFunctionRunnerFamily(family), family).toBe(false);
    expect(isFunctionRunnerRepository("svc/lambda-ruby")).toBe(true);
    expect(isFunctionRunnerRepository("svc/postgres")).toBe(false);
  });

  it("the 16-image bound counts services only: more runtimes can never throw the services' list away (and so never turn every service 'not available yet')", () => {
    const more = Array.from({ length: 8 }, (_, index) => ({ id: `lambda-extra${String(index)}@1`, family: `lambda-extra${String(index)}`, repository: `svc/lambda-extra${String(index)}` }));
    const catalog = pinnedCatalogWithRunner(more);
    // The hazard: the vendored list over this catalog has more than 16 images and throws (a list taken out of its RESULT would be too late).
    expect(() => catalogPrepullList(catalog)).toThrow();
    // The services' list is made without the runner's entries, so it is unchanged, and the broker answers from it, with a handler that fails the test if a list could not be made.
    expect(() => servicesPrepullList(catalog)).not.toThrow();
    const verified = verifiedCatalog(catalog);
    const loud = (error: unknown): never => { throw new Error(`a services pre-pull list could not be made: ${String(error)}`); };
    expect(isPrepulledEntry(verified, "postgres@16", loud)).toBe(true);
    expect(isPrepulledEntry(verified, "local-aws@r1", loud)).toBe(true);
    expect(isPrepulledEntry(verified, "lambda-extra3@1", loud)).toBe(false);
    // And a runner list over its own bound (12) is refused: the 13 runner images here are refused as a list, never half-written.
    expect(() => functionRunnerPrepullList(catalog)).toThrow();
  });

  it("the company-image paths treat them as not in the catalog: no profile entry, not servable (also for a runtime added later)", () => {
    const catalog = verifiedCatalog(pinnedCatalogWithRunner([{ id: "lambda-provided@al2023", family: "lambda-provided", repository: "svc/lambda-provided" }]));
    for (const family of ["lambda-python", "lambda-nodejs", "function-agent", "lambda-provided"]) expect(profileEntryOf(catalog, family, "3", "public"), family).toBeUndefined();
    for (const catalogId of ["lambda-python@3.12", "function-agent@r1", "lambda-provided@al2023"]) {
      expect(serviceImageServed({ catalog, edition: "public", approved: [], request: { catalogId } }), catalogId).toEqual({ ok: false, reason: "not_in_catalog" });
    }
    expect(serviceImageServed({ catalog, edition: "public", approved: [], request: { catalogId: "postgres@16" } })).toMatchObject({ ok: true });
  });

  it("an UNPINNED runner entry cannot resolve to an image to start, even when a real registry check passed for some digest (a tag or no pin is never served), and a pinned one resolves only to its own digest", async () => {
    const bytes = Buffer.from("a manifest");
    const digest = sha256HexOf(bytes);
    const check = await checkMirrorServesDigest({ manifestBytes: async () => bytes }, { id: "lambda-python@3.12", repositoryName: "rovara-catalog/staging/svc/lambda-python", digest });
    const input = (catalog: ReturnType<typeof verifiedCatalog>) => ({ catalogId: "lambda-python@3.12", catalog, edition: "public", served: { source: "rovara_registry", check }, approvals: { find: async () => undefined } }) as never;
    const refused = await resolveCatalogImage(input(verifiedCatalog(nextCatalog(false))));
    expect(refused).toMatchObject({ ok: false, code: "not_pinned" });
    // Pinned to another digest than the registry served: a mismatch, never a start.
    const other = await resolveCatalogImage(input(verifiedCatalog(nextCatalog(true))));
    expect(other).toMatchObject({ ok: false, code: "digest_mismatch" });
  });
});

describe("the runner's pre-pull list", () => {
  const good = (): Record<string, unknown> => ({ schemaVersion: 1, catalogRevision: 4, images: [
    { id: "function-agent@r1", repository: "svc/function-agent", digest: "a".repeat(64), platforms: ["linux/arm64"] },
    { id: "lambda-python@3.12", repository: "svc/lambda-python", digest: "b".repeat(64), platforms: ["linux/arm64"] },
  ] });
  const withImage = (change: (image: Record<string, unknown>) => void) => { const list = good(); change((list["images"] as Array<Record<string, unknown>>)[1]!); return list; };
  const ok = (value: unknown) => FunctionRunnerPrepullListSchema.safeParse(value).success;

  it("takes the runner's ids, one arm64 platform and the repository each id has, by a 64-hex digest", () => {
    expect(ok(good())).toBe(true);
    expect(ok({ schemaVersion: 1, catalogRevision: 1, images: [] })).toBe(true);
    expect(ok(withImage((image) => { image["platforms"] = ["linux/amd64"]; }))).toBe(false);
    expect(ok(withImage((image) => { image["platforms"] = ["linux/arm64", "linux/amd64"]; }))).toBe(false);
    expect(ok(withImage((image) => { image["id"] = "postgres@16"; image["repository"] = "svc/postgres"; }))).toBe(false);
    expect(ok(withImage((image) => { image["repository"] = "svc/lambda-nodejs"; }))).toBe(false);
    expect(ok(withImage((image) => { image["digest"] = "latest"; }))).toBe(false);
    expect(ok(withImage((image) => { image["digest"] = `sha256:${"b".repeat(64)}`; }))).toBe(false);
    expect(ok(withImage((image) => { image["tag"] = "3.12"; }))).toBe(false);
  });

  it("holds an id once and at most the bound", () => {
    const list = good();
    (list["images"] as unknown[]).push((list["images"] as unknown[])[0]);
    expect(ok(list)).toBe(false);
    expect(FUNCTION_RUNNER_PREPULL_MAX_IMAGES).toBe(12);
    const many = good();
    many["images"] = Array.from({ length: FUNCTION_RUNNER_PREPULL_MAX_IMAGES + 1 }, (_, index) => ({ id: `lambda-python@${String(index)}`, repository: "svc/lambda-python", digest: "b".repeat(64), platforms: ["linux/arm64"] }));
    expect(ok(many)).toBe(false);
  });

  it("builds the base image reference for a runtime by DIGEST in the install's registry, and for no unknown runtime", () => {
    const list = FunctionRunnerPrepullListSchema.parse(good());
    const install = { registry: "944937319445.dkr.ecr.us-west-2.amazonaws.com", env: "staging" };
    expect(functionRunnerImageReference(list, "python3.12", install)).toBe(`944937319445.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/lambda-python@sha256:${"b".repeat(64)}`);
    // python3.13 has no pinned image in this list: undefined, never a tag or another version's image.
    expect(functionRunnerImageReference(list, "python3.13", install)).toBeUndefined();
    for (const runtime of ["java21", "provided.al2023", "python3.12:latest", "", "__proto__", "constructor"]) expect(functionRunnerImageReference(list, runtime, install), runtime).toBeUndefined();
    expect(() => functionRunnerImageReference(list, "python3.12", { registry: "https://evil.example/x", env: "staging" })).toThrow();
    expect(() => functionRunnerImageReference(list, "python3.12", { registry: install.registry, env: "../x" })).toThrow();
    expect(FUNCTION_RUNNER_AGENT_ID).toBe("function-agent@r1");
  });
});

describe("the plan field and the worker feature", () => {
  const emulated = (aws: Record<string, unknown>) => ({ id: "aws-s3", name: "S3", kind: "object_store", family: "aws:s3", backing: "emulated", catalogId: "local-aws@r1", repository: "svc/local-aws", digest: "c".repeat(64), config: {}, aliases: ["aws"], connect: [], seeds: [], reset: "fresh_per_round", aws });
  const ok = (value: unknown) => TaskDependencyPlanSchema.safeParse(value).success;

  it("takes aws.functions.runner as auto or all on an emulated dependency, and refuses anything else (and an extra key)", () => {
    expect(ok(emulated({ services: ["s3"], region: "us-east-1" }))).toBe(true);
    expect(ok(emulated({ services: ["s3"], region: "us-east-1", functions: { runner: "auto" } }))).toBe(true);
    expect(ok(emulated({ services: ["s3"], region: "us-east-1", functions: { runner: "all" } }))).toBe(true);
    expect(ok(emulated({ services: ["s3"], region: "us-east-1", functions: { runner: "none" } }))).toBe(false);
    expect(ok(emulated({ services: ["s3"], region: "us-east-1", functions: { runner: "all", image: "x" } }))).toBe(false);
    expect(ok(emulated({ services: ["s3"], region: "us-east-1", functions: {} }))).toBe(false);
    // Only an emulated dependency has an `aws` block at all.
    expect(ok({ ...emulated({ services: ["s3"], region: "us-east-1", functions: { runner: "all" } }), backing: "local", catalogId: "postgres@16", family: "postgres", repository: "svc/postgres" })).toBe(false);
  });

  it("is a worker feature string the shared schema knows", () => {
    expect(TEST_SERVICES_FUNCTIONS_PLAN_FEATURE).toBe("task.testServices.functions.v2");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_FUNCTIONS_PLAN_FEATURE);
  });
});

// Test services TS19: what the catalog's pins mean. Where an image lives, the pre-pull list, the Enterprise bundle's image list, and the one function that decides which digest may start (owner Q9, DC-TS-1).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as contracts from "@agentx/contracts";
import {
  CATALOG_IMAGE_MESSAGES,
  CATALOG_IMAGE_REFUSALS,
  PREPULL_MAX_IMAGES,
  PrepullListSchema,
  SERVICE_CATALOG_REPOSITORIES,
  bundleCatalogProblems,
  checkBundleImages,
  checkCatalogMirror,
  checkMirrorServesDigest,
  catalogBundleImageName,
  catalogBundleImages,
  catalogImageReference,
  catalogPins,
  catalogPrepullList,
  catalogRepositories,
  catalogRepositoryName,
  resolveCatalogImage,
  resolveCatalogImages,
  type MirrorCheck,
  type VerifiedCatalog,
  type ResolveCatalogImageInput,
  type ServedImage,
  type SubstituteApprovalPort,
  type SubstituteApprovalRecord,
} from "@agentx/contracts";
import { digestOfId, pinnedCatalog, sha, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const catalog = verifiedCatalog(pinnedCatalog());
const digest = (id: string): string => digestOfId(id);
const OTHER = sha("a company-built postgres");
const OTHER_TWO = sha("another company-built postgres");

describe("where a catalog image lives", () => {
  it("is rovara-catalog/<env>/<repository>, and nothing else is accepted", () => {
    expect(catalogRepositoryName("staging", "svc/postgres")).toBe("rovara-catalog/staging/svc/postgres");
    for (const bad of ["svc/", "postgres", "svc/Postgres", "svc/a b", "svc/../x", "other/postgres", "svc/postgres/x", ""]) expect(() => catalogRepositoryName("staging", bad), bad).toThrow();
    for (const bad of ["", "Staging", "a/b", "-x", "a".repeat(21)]) expect(() => catalogRepositoryName(bad, "svc/postgres"), bad).toThrow();
  });
  it("lists the released catalog's repositories in SERVICE_CATALOG_REPOSITORIES (the CDK app cannot read the data file)", () => {
    expect([...SERVICE_CATALOG_REPOSITORIES]).toEqual(catalogRepositories(unpinnedCatalog()));
    expect(catalogRepositories(unpinnedCatalog())).toEqual([...new Set(catalogRepositories(unpinnedCatalog()))].sort());
  });
  it("names an image for a pull only by digest: a reference has no tag and a tag cannot be built", () => {
    const reference = catalogImageReference({ registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", repositoryName: "rovara-catalog/staging/svc/postgres", digest: digest("postgres@16") });
    expect(reference).toBe(`111122223333.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/postgres@sha256:${digest("postgres@16")}`);
    expect(reference.replace("@sha256:", "@")).not.toContain(":");
    for (const bad of ["latest", "16", digest("x").slice(0, 63), `sha256:${digest("x")}`, digest("x").toUpperCase()]) {
      expect(() => catalogImageReference({ registry: "registry.example.com", repositoryName: "rovara-catalog/staging/svc/postgres", digest: bad }), bad).toThrow();
    }
    for (const badRegistry of ["https://registry.example.com", "registry.example.com/path", "user@registry.example.com", "reg istry", ""]) {
      expect(() => catalogImageReference({ registry: badRegistry, repositoryName: "rovara-catalog/staging/svc/postgres", digest: digest("x") }), badRegistry).toThrow();
    }
  });
});

describe("the pinned entries", () => {
  it("are the non-retired entries with a digest, and none for an unpinned catalog", () => {
    expect(catalogPins(unpinnedCatalog())).toEqual([]);
    expect(catalogPins(catalog).map((pin) => pin.id)).toContain("postgres@16");
    const retired = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@15")!["status"] = "retired"; });
    expect(catalogPins(retired).map((pin) => pin.id)).not.toContain("postgres@15");
  });
  it("can be filtered by edition", () => {
    const publicOnly = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "mysql@8")!["editions"] = ["public"]; });
    expect(catalogPins(publicOnly, "enterprise").map((pin) => pin.id)).not.toContain("mysql@8");
    expect(catalogPins(publicOnly, "public").map((pin) => pin.id)).toContain("mysql@8");
  });
});

describe("the worker pre-pull list", () => {
  it("is empty for an unpinned catalog", () => {
    expect(catalogPrepullList(unpinnedCatalog())).toEqual({ schemaVersion: 1, catalogRevision: 1, images: [] });
  });
  it("holds EVERY pinned local and emulated entry (not only each family's default) by repository and digest, sorted, and nothing else (the helpers that run from the worker's own image have no image to pull)", () => {
    const list = catalogPrepullList(catalog);
    expect(list.images.map((image) => image.id)).toEqual(["local-aws@r1", "mysql@8", "postgres@15", "postgres@16", "postgres@17", "rabbitmq@3", "redis@7", "valkey@8"]);
    // The test-account proxy is a helper that runs only with `ta`: not pulled ahead.
    expect(list.images.map((image) => image.id)).not.toContain("test-account-proxy@r1");
    expect(list.images.length).toBeLessThanOrEqual(PREPULL_MAX_IMAGES);
    expect(list.images.find((image) => image.id === "postgres@16")).toEqual({ id: "postgres@16", repository: "svc/postgres", digest: digest("postgres@16"), platforms: ["linux/arm64", "linux/amd64"] });
    expect(JSON.stringify(list)).not.toMatch(/latest|:\d+\/|amazonaws/u);
    expect(PrepullListSchema.safeParse(list).success).toBe(true);
    expect(list.catalogRevision).toBe(catalog.revision);
  });
  it("leaves a retired entry (default or not) out", () => {
    const retired = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "mysql@8")!["status"] = "retired"; entries.find((entry) => entry["id"] === "postgres@15")!["status"] = "retired"; });
    expect(catalogPrepullList(retired).images.map((image) => image.id)).not.toContain("mysql@8");
    expect(catalogPrepullList(retired).images.map((image) => image.id)).not.toContain("postgres@15");
  });
  it("is checked on the way in: a tag, a hex that is too short, an unknown key or a list over the cap is refused", () => {
    const good = catalogPrepullList(catalog);
    const first = good.images[0]!;
    for (const change of [{ ...first, digest: "latest" }, { ...first, digest: "a".repeat(63) }, { ...first, extra: 1 }, { ...first, repository: "postgres" }]) {
      expect(PrepullListSchema.safeParse({ ...good, images: [change] }).success, JSON.stringify(change)).toBe(false);
    }
    expect(PrepullListSchema.safeParse({ ...good, images: Array.from({ length: PREPULL_MAX_IMAGES + 1 }, (_, index) => ({ ...first, id: `x@${String(index)}` })) }).success).toBe(false);
    expect(PrepullListSchema.safeParse({ ...good, images: [first, first] }).success).toBe(false);
  });
  it("is the file that ships in the worker image (regenerate it with scripts/catalog-build.ts, which writes it)", () => {
    expect(JSON.parse(readFileSync("packages/worker/service-catalog/prepull.json", "utf8"))).toEqual(catalogPrepullList(unpinnedCatalog()));
  });
});

describe("the Enterprise bundle", () => {
  const source = { registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", env: "staging" };
  it("names a catalog image svc-<name>-<version>, within the bundle's name rule, and refuses a name that would be too long", () => {
    expect(catalogBundleImageName("postgres@16")).toBe("svc-postgres-16");
    expect(catalogBundleImageName("local-aws@r1")).toBe("svc-local-aws-r1");
    expect(catalogBundleImageName("redis@7.2_a")).toBe("svc-redis-7-2-a");
    expect(() => catalogBundleImageName(`${"a".repeat(39)}@${"1".repeat(15)}`)).toThrow();
  });
  it("lists, for the bundle builder, every pinned Enterprise image by digest", () => {
    const images = catalogBundleImages(catalog, source);
    expect(images.length).toBe(catalogPins(catalog, "enterprise").length);
    expect(images.find((image) => image.name === "svc-postgres-16")!.sourceRef).toBe(`${source.registry}/rovara-catalog/staging/svc/postgres@sha256:${digest("postgres@16")}`);
    expect(catalogBundleImages(unpinnedCatalog(), source)).toEqual([]);
  });
  it("accepts a bundle that holds exactly the catalog's digests", () => {
    expect(bundleCatalogProblems({ images: catalogBundleImages(catalog, source) }, catalog)).toEqual([]);
  });
  it("reports a missing image, a different digest and an image the catalog never pinned", () => {
    const images = catalogBundleImages(catalog, source);
    const without = images.filter((image) => image.name !== "svc-mysql-8");
    expect(bundleCatalogProblems({ images: without }, catalog)).toEqual([{ id: "mysql@8", problem: "missing" }]);
    const swapped = images.map((image) => (image.name === "svc-postgres-16" ? { ...image, sourceRef: `${image.sourceRef.slice(0, -64)}${OTHER}` } : image));
    expect(bundleCatalogProblems({ images: swapped }, catalog)).toEqual([{ id: "postgres@16", problem: "digest_mismatch", bundleDigest: OTHER }]);
    const extra = [...images, { name: "svc-mongo-7", sourceRef: `r.example.com/x@sha256:${OTHER}` }];
    expect(bundleCatalogProblems({ images: extra }, catalog)).toEqual([{ id: "svc-mongo-7", problem: "unexpected_image", bundleImage: "svc-mongo-7" }]);
    expect(bundleCatalogProblems({ images: images.map((image) => ({ ...image, sourceRef: "no-digest" })) }, catalog).every((problem) => problem.problem === "digest_mismatch")).toBe(true);
  });
});

// ---- resolveCatalogImage

const APPROVAL = "approval:2026-11-02:pg16-hardened";
const approvalFor = (overrides: Partial<SubstituteApprovalRecord> = {}): SubstituteApprovalRecord => ({ approvalRef: APPROVAL, catalogId: "postgres@16", catalogDigest: digest("postgres@16"), digest: OTHER, ...overrides });
const portOf = (...records: SubstituteApprovalRecord[]): SubstituteApprovalPort => ({ find: async (ref) => records.find((record) => record.approvalRef === ref) });
const substitute = (overrides: Record<string, string> = {}) => ({ digest: OTHER, catalogDigest: digest("postgres@16"), approvalRef: APPROVAL, ...overrides });
// What the install serves for an id is the RESULT of a real digest check, never a bare digest and never a hand-built object: a check is made by the package's own checkers (the registry check hashes the bytes a fake
// registry serves; the bundle check reads a bundle's image list). Every digest the tests use is the SHA-256 of a known text, so a fake registry can serve bytes that really hash to it.
const TEXT_OF_OTHER = "a company-built postgres";
const TEXT_OF_OTHER_TWO = "another company-built postgres";
const CHECKED_IDS = ["postgres@15", "postgres@16", "postgres@17", "mysql@8", "valkey@8", "local-aws@r1", "fake-server@r1", "dns-helper@r1", "mongo@7"];
const BAD_DIGESTS = ["latest", "16", digest("postgres@16").toUpperCase(), digest("postgres@16").slice(1), `sha256:${digest("postgres@16")}`];
const registryServing = (text: string): { manifestBytes: () => Promise<Uint8Array> } => ({ manifestBytes: async () => Buffer.from(text) });
const mirrorChecks = new Map<string, MirrorCheck>();
for (const id of CHECKED_IDS) {
  for (const text of [...CHECKED_IDS.map((other) => `image:${other}`), TEXT_OF_OTHER, TEXT_OF_OTHER_TWO]) {
    mirrorChecks.set(`${id}|${sha(text)}`, await checkMirrorServesDigest(registryServing(text), { id, repositoryName: "corp/svc/x", digest: sha(text) }));
  }
  // A digest that is not 64 lower-case hex: the registry check itself refuses it (a failed check).
  for (const bad of BAD_DIGESTS) mirrorChecks.set(`${id}|${bad}`, await checkMirrorServesDigest(registryServing("x"), { id, repositoryName: "corp/svc/x", digest: bad }));
}
const bundleImages = catalogBundleImages(catalog, { registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", env: "staging" });
const bundleChecks = checkBundleImages({ images: bundleImages }, catalog);
/** What the install serves for an id: the RESULT of a real digest check. */
const served = (source: ServedImage["source"], digestHex: string, id = "postgres@16"): ServedImage => {
  if (source === "signed_bundle") {
    const check = bundleChecks.find((candidate) => candidate.id === id);
    if (check === undefined || !check.ok || check.digest !== digestHex) throw new Error(`the test has no passing bundle check for ${id} ${digestHex.slice(0, 8)}`);
    return { source, check };
  }
  const check = mirrorChecks.get(`${id}|${digestHex}`);
  if (check === undefined) throw new Error(`the test has no registry check for ${id} ${digestHex.slice(0, 8)}`);
  return { source, check };
};
const request = (overrides: Partial<ResolveCatalogImageInput> = {}): ResolveCatalogImageInput => ({
  catalog, catalogId: "postgres@16", edition: "enterprise", served: served("company_registry", digest("postgres@16")), approvals: portOf(), ...overrides,
});
const refusal = async (input: ResolveCatalogImageInput) => {
  const result = await resolveCatalogImage(input);
  return result.ok ? "ok" : result.code;
};

describe("resolving an image to start", () => {
  it("starts the catalog's digest, from Rovara's registry in Public and from the bundle or the company's registry in Enterprise", async () => {
    expect(await resolveCatalogImage(request({ edition: "public", served: served("rovara_registry", digest("postgres@16")) }))).toEqual({
      ok: true, id: "postgres@16", kind: "catalog", repository: "svc/postgres", digest: digest("postgres@16"), source: "rovara_registry",
    });
    for (const source of ["signed_bundle", "company_registry"] as const) {
      expect(await refusal(request({ served: served(source, digest("postgres@16")) }))).toBe("ok");
    }
  });
  it("refuses a source the edition does not use", async () => {
    expect(await refusal(request({ edition: "public", served: served("company_registry", digest("postgres@16")) }))).toBe("source_not_allowed");
    expect(await refusal(request({ edition: "enterprise", served: served("rovara_registry", digest("postgres@16")) }))).toBe("source_not_allowed");
  });
  it("stops an image whose digest differs from the catalog's when there is no approved substitute, in the owner's words", async () => {
    const result = await resolveCatalogImage(request({ served: served("company_registry", OTHER) }));
    expect(result).toEqual({ ok: false, id: "postgres@16", code: "digest_mismatch", message: "postgres image digest does not match the catalog and has no approved substitute" });
    expect(CATALOG_IMAGE_MESSAGES.digest_mismatch("postgres")).toBe("postgres image digest does not match the catalog and has no approved substitute");
  });
  it("refuses a digest that is not 64 lower-case hex, a tag in place of a digest, and an unknown id", async () => {
    for (const bad of ["latest", "16", digest("postgres@16").toUpperCase(), digest("postgres@16").slice(1), `sha256:${digest("postgres@16")}`]) {
      expect(await refusal(request({ served: served("company_registry", bad) })), bad).toBe("not_verified");
    }
    expect(await refusal(request({ catalogId: "mongo@7", served: served("company_registry", digest("postgres@16"), "mongo@7") }))).toBe("unknown_entry");
    expect(await refusal(request({ catalogId: "not an id" }))).toBe("unknown_entry");
  });
  it("takes the RESULT of a real digest check, not a digest: a check that failed, is for another image, or is not a check at all is refused", async () => {
    const failedMirror = await checkMirrorServesDigest(registryServing("other bytes"), { id: "postgres@16", repositoryName: "corp/svc/postgres", digest: digest("postgres@16") });
    expect(failedMirror).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(await refusal(request({ served: { source: "company_registry", check: failedMirror } }))).toBe("not_verified");
    const unreachable = await checkMirrorServesDigest({ manifestBytes: async () => { throw new Error("down"); } }, { id: "postgres@16", repositoryName: "corp/svc/postgres", digest: digest("postgres@16") });
    expect(unreachable).toMatchObject({ ok: false, code: "unreachable" });
    expect(await refusal(request({ served: { source: "company_registry", check: unreachable } }))).toBe("not_verified");
    const withoutPostgres = checkBundleImages({ images: bundleImages.filter((image) => image.name !== "svc-postgres-16") }, catalog).find((check) => check.id === "postgres@16")!;
    expect(withoutPostgres).toMatchObject({ ok: false, code: "missing" });
    expect(await refusal(request({ served: { source: "signed_bundle", check: withoutPostgres } }))).toBe("not_verified");
    // A passed check for ANOTHER image does not cover this one, even when the digest is the right one.
    expect(await refusal(request({ served: served("company_registry", digest("postgres@16"), "mysql@8") }))).toBe("not_verified");
    // The old shape, a bare digest, and a missing check.
    expect(await refusal(request({ served: { source: "company_registry", digest: digest("postgres@16") } as unknown as ServedImage }))).toBe("not_verified");
    expect(await refusal(request({ served: { source: "company_registry" } as unknown as ServedImage }))).toBe("not_verified");
    expect(await refusal(request({ served: undefined as unknown as ServedImage }))).toBe("not_verified");
    // The type says the same: neither a plain catalog nor a bare digest compiles.
    // @ts-expect-error a catalog that did not come from loadSignedCatalog is not accepted
    void request({ catalog: pinnedCatalog() });
    // @ts-expect-error a bare digest is not what the install served: a check result is
    void request({ served: { source: "company_registry", digest: digest("postgres@16") } });
  });
  it("refuses a FORGED check at run time: an object of the right shape that no checker returned, for every source", async () => {
    for (const source of ["rovara_registry", "company_registry", "signed_bundle"] as const) {
      const forged = { id: "postgres@16", ok: true, digest: digest("postgres@16") } as const;
      expect(await refusal(request({ edition: source === "rovara_registry" ? "public" : "enterprise", served: { source, check: forged } as ServedImage })), source).toBe("not_verified");
    }
    // A real check copied field by field, cloned, or round-tripped through JSON is a different object: refused.
    const real = (served("company_registry", digest("postgres@16")) as { check: MirrorCheck }).check;
    for (const copy of [{ ...real }, structuredClone(real), JSON.parse(JSON.stringify(real)) as MirrorCheck, Object.freeze({ ...real })]) {
      expect(await refusal(request({ served: { source: "company_registry", check: copy } })), JSON.stringify(copy)).toBe("not_verified");
    }
    // The genuine one still passes.
    expect(await refusal(request({ served: { source: "company_registry", check: real } }))).toBe("ok");
  });
  it("refuses a RAW or copied catalog at run time: only the object loadSignedCatalog returned is verified", async () => {
    expect(await refusal(request({ catalog: pinnedCatalog() as unknown as VerifiedCatalog }))).toBe("not_verified");
    expect(await refusal(request({ catalog: structuredClone(catalog) }))).toBe("not_verified");
    expect(await refusal(request({ catalog: { ...catalog } }))).toBe("not_verified");
    expect(await refusal(request({ catalog: JSON.parse(JSON.stringify(catalog)) as VerifiedCatalog }))).toBe("not_verified");
    expect(await refusal(request({ catalog: undefined as unknown as VerifiedCatalog }))).toBe("not_verified");
    expect(await refusal(request({ catalog }))).toBe("ok");
  });
  it("refuses a source and a check of different kinds: a bundle needs a bundle check, a registry needs a registry check", async () => {
    const mirror = (served("company_registry", digest("postgres@16")) as { check: MirrorCheck }).check;
    const bundle = bundleChecks.find((check) => check.id === "postgres@16")!;
    expect(bundle.ok).toBe(true);
    expect(await refusal(request({ served: { source: "signed_bundle", check: mirror } as ServedImage }))).toBe("not_verified");
    expect(await refusal(request({ served: { source: "company_registry", check: bundle } as ServedImage }))).toBe("not_verified");
    expect(await refusal(request({ edition: "public", served: { source: "rovara_registry", check: bundle } as ServedImage }))).toBe("not_verified");
    // Each kind passes with its own source.
    expect(await refusal(request({ served: { source: "signed_bundle", check: bundle } }))).toBe("ok");
    expect(await refusal(request({ served: { source: "company_registry", check: mirror } }))).toBe("ok");
  });
  it("freezes what the checkers and the loader return, so a holder cannot change a verified result", () => {
    const mirror = (served("company_registry", digest("postgres@16")) as { check: MirrorCheck }).check;
    expect(Object.isFrozen(mirror)).toBe(true);
    expect(() => { (mirror as { digest: string }).digest = OTHER; }).toThrow();
    for (const check of bundleChecks) expect(Object.isFrozen(check)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
    expect(() => { (catalog.entries[0] as { status: string }).status = "retired"; }).toThrow();
  });
  it("accepts the results of checkCatalogMirror, which are registered and frozen like the single check", async () => {
    const port = { manifestBytes: async (_repositoryName: string, wanted: string) => { const id = CHECKED_IDS.find((candidate) => digest(candidate) === wanted); return id === undefined ? undefined : Buffer.from(`image:${id}`); } };
    const results = await checkCatalogMirror({ catalog, port, repositoryNameFor: (repository) => `corp/${repository}` });
    const postgres = results.find((result) => result.id === "postgres@16")!;
    expect(postgres.ok).toBe(true);
    expect(Object.isFrozen(postgres)).toBe(true);
    expect(await refusal(request({ served: { source: "company_registry", check: postgres } }))).toBe("ok");
    // Its failures are real results too (and refused).
    const failing = await checkCatalogMirror({ catalog, port: { manifestBytes: async () => undefined }, repositoryNameFor: (repository) => repository });
    expect(await refusal(request({ served: { source: "company_registry", check: failing.find((result) => result.id === "postgres@16")! } }))).toBe("not_verified");
    const unnameable = await checkCatalogMirror({ catalog, port, repositoryNameFor: () => { throw new Error("no name"); } });
    expect(await refusal(request({ served: { source: "company_registry", check: unnameable[0]! } }))).toBe("not_verified");
  });
  it("keeps the registrations private: the package exports no way to mark a catalog or a check as verified", () => {
    const names = Object.keys(contracts);
    for (const name of names) expect(name, name).not.toMatch(/^register(VerifiedCatalog|MirrorCheck|BundleCheck)$|^is(VerifiedCatalog|MirrorCheck|BundleCheck)$/u);
    expect(names).toContain("resolveCatalogImage");
  });
  it("takes a bundle check as the proof for a signed bundle, and refuses a bundle that lacks or changes the image", async () => {
    const images = catalogBundleImages(catalog, { registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", env: "staging" });
    const checks = checkBundleImages({ images }, catalog);
    expect(checks.every((check) => check.ok)).toBe(true);
    const postgres = checks.find((check) => check.id === "postgres@16")!;
    expect(await refusal(request({ served: { source: "signed_bundle", check: postgres } }))).toBe("ok");
    const without = checkBundleImages({ images: images.filter((image) => image.name !== "svc-postgres-16") }, catalog).find((check) => check.id === "postgres@16")!;
    expect(without).toMatchObject({ ok: false, code: "missing" });
    expect(await refusal(request({ served: { source: "signed_bundle", check: without } }))).toBe("not_verified");
    const swapped = checkBundleImages({ images: images.map((image) => (image.name === "svc-postgres-16" ? { ...image, sourceRef: `${image.sourceRef.slice(0, -64)}${OTHER}` } : image)) }, catalog).find((check) => check.id === "postgres@16")!;
    expect(swapped).toMatchObject({ ok: false, code: "digest_mismatch" });
    expect(await refusal(request({ served: { source: "signed_bundle", check: swapped } }))).toBe("not_verified");
    // One result per pinned Enterprise image, and none for an unpinned catalog.
    expect(checks).toHaveLength(catalogPins(catalog, "enterprise").length);
    expect(checkBundleImages({ images }, unpinnedCatalog())).toEqual([]);
  });
  it("refuses a retired entry, an unpinned catalog and an edition the entry is not offered in", async () => {
    const retired = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@16")!["status"] = "retired"; });
    expect(await refusal(request({ catalog: verifiedCatalog(retired) }))).toBe("retired");
    expect(await refusal(request({ catalog: verifiedCatalog(unpinnedCatalog()) }))).toBe("not_pinned");
    const publicOnly = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@16")!["editions"] = ["public"]; });
    expect(await refusal(request({ catalog: verifiedCatalog(publicOnly) }))).toBe("edition_not_offered");
  });

  describe("a company-built substitute (DC-TS-1)", () => {
    const good = (): ResolveCatalogImageInput => request({ substitute: substitute(), approvals: portOf(approvalFor()), served: served("company_registry", OTHER) });
    it("starts when the substitute replaces the catalog's digest, the approval is for this id and these two digests, and the registry serves it, and carries the evidence label", async () => {
      expect(await resolveCatalogImage(good())).toEqual({
        ok: true, id: "postgres@16", kind: "substitute", repository: "svc/postgres", digest: OTHER, catalogDigest: digest("postgres@16"), approvalRef: APPROVAL, source: "company_registry",
        label: "company-approved postgres image",
      });
    });
    it("check 1: refuses a substitute that replaces some other digest", async () => {
      expect(await refusal({ ...good(), substitute: substitute({ catalogDigest: OTHER_TWO }), approvals: portOf(approvalFor({ catalogDigest: OTHER_TWO })) })).toBe("substitute_replaces_other_digest");
    });
    it("check 2: an approval that does not exist, or that a store could not find, does not cover it", async () => {
      expect(await refusal({ ...good(), approvals: portOf() })).toBe("substitute_approval_missing");
      expect(await refusal({ ...good(), approvals: { find: async () => { throw new Error("store down"); } } })).toBe("substitute_approval_missing");
      expect(await refusal({ ...good(), approvals: { find: () => { throw new Error("store down"); } } })).toBe("substitute_approval_missing");
    });
    it("check 2: an approval for another catalog id, another catalog digest, another substitute digest, or another reference covers nothing", async () => {
      for (const wrong of [{ catalogId: "postgres@17" }, { catalogId: "mysql@8" }, { catalogDigest: OTHER_TWO }, { digest: OTHER_TWO }, { approvalRef: "approval:2026-11-02:other" }]) {
        // (a store that answers with a record that is not the one asked for, or not for this image)
        expect(await refusal({ ...good(), approvals: { find: async () => approvalFor(wrong) } }), JSON.stringify(wrong)).toBe("substitute_approval_mismatch");
      }
    });
    it("runs only the approved digest: a registry that serves anything else is refused, even the catalog's own digest", async () => {
      expect(await refusal({ ...good(), served: served("company_registry", OTHER_TWO) })).toBe("substitute_not_served");
      expect(await refusal({ ...good(), served: served("company_registry", digest("postgres@16")) })).toBe("substitute_not_served");
    });
    it("is not allowed in Public, or for Rovara's own emulator, fake server or helpers, or when its shape is wrong", async () => {
      expect(await refusal({ ...good(), edition: "public", served: served("rovara_registry", OTHER) })).toBe("substitute_not_allowed");
      for (const id of ["local-aws@r1"]) {
        const sub = { digest: OTHER, catalogDigest: digest(id), approvalRef: APPROVAL };
        expect(await refusal(request({ catalogId: id, substitute: sub, served: served("company_registry", OTHER, id), approvals: portOf({ approvalRef: APPROVAL, catalogId: id, catalogDigest: digest(id), digest: OTHER }) })), id).toBe("substitute_not_allowed");
      }
      // Slice 3: the fake server and the DNS helper run from the worker's own image, so they have no image to resolve at all (a substitute for one is a substitute for nothing).
      for (const id of ["fake-server@r1", "dns-helper@r1"]) {
        const sub = { digest: OTHER, catalogDigest: digest(id), approvalRef: APPROVAL };
        expect(await refusal(request({ catalogId: id, substitute: sub, served: served("company_registry", OTHER, id), approvals: portOf({ approvalRef: APPROVAL, catalogId: id, catalogDigest: digest(id), digest: OTHER }) })), id).toBe("not_pinned");
      }
      expect(await refusal({ ...good(), substitute: substitute({ digest: digest("postgres@16") }) })).toBe("substitute_not_allowed");
      expect(await refusal({ ...good(), substitute: substitute({ approvalRef: "x" }) })).toBe("substitute_not_allowed");
    });
    it("asks the approval store nothing when an earlier check already refused", async () => {
      let asked = 0;
      const counting: SubstituteApprovalPort = { find: async () => { asked += 1; return approvalFor(); } };
      await resolveCatalogImage({ ...good(), substitute: substitute({ catalogDigest: OTHER_TWO }), approvals: counting });
      await resolveCatalogImage({ ...good(), edition: "public", served: served("rovara_registry", OTHER), approvals: counting });
      expect(asked).toBe(0);
    });
  });

  it("stops only the image that mismatches: the others in the same call still start", async () => {
    const results = await resolveCatalogImages([
      request({ catalogId: "postgres@16", served: served("company_registry", OTHER) }),
      request({ catalogId: "mysql@8", served: served("company_registry", digest("mysql@8"), "mysql@8") }),
      request({ catalogId: "valkey@8", approvals: { find: async () => { throw new Error("boom"); } }, served: served("company_registry", digest("valkey@8"), "valkey@8") }),
    ]);
    expect(results.map((result) => (result.ok ? "ok" : result.code))).toEqual(["digest_mismatch", "ok", "ok"]);
  });

  it("has a fixed message for every refusal, and none of them names the upstream project or carries a digest", () => {
    for (const code of CATALOG_IMAGE_REFUSALS) {
      const message = CATALOG_IMAGE_MESSAGES[code]("postgres");
      expect(message, code).toMatch(/^postgres /u);
      expect(message, code).not.toMatch(/[a-f0-9]{16}|sha256/iu);
    }
  });
});

// Test services TS19: what the catalog's pins mean. Where an image lives, the pre-pull list, the Enterprise bundle's image list, and the one function that decides which digest may start (owner Q9, DC-TS-1).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_IMAGE_MESSAGES,
  CATALOG_IMAGE_REFUSALS,
  PREPULL_MAX_IMAGES,
  PrepullListSchema,
  SERVICE_CATALOG_REPOSITORIES,
  bundleCatalogProblems,
  catalogBundleImageName,
  catalogBundleImages,
  catalogImageReference,
  catalogPins,
  catalogPrepullList,
  catalogRepositories,
  catalogRepositoryName,
  resolveCatalogImage,
  resolveCatalogImages,
  type ResolveCatalogImageInput,
  type SubstituteApprovalPort,
  type SubstituteApprovalRecord,
} from "@agentx/contracts";
import { digestOfId, pinnedCatalog, sha, unpinnedCatalog } from "../support/catalog-pinning.js";

const catalog = pinnedCatalog();
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
  it("holds the pinned default of each family and the always-used helper, by repository and digest, sorted, and nothing else", () => {
    const list = catalogPrepullList(catalog);
    expect(list.images.map((image) => image.id)).toEqual(["dns-helper@r1", "fake-server@r1", "local-aws@r1", "mysql@8", "postgres@16", "valkey@8"]);
    expect(list.images.find((image) => image.id === "postgres@16")).toEqual({ id: "postgres@16", repository: "svc/postgres", digest: digest("postgres@16"), platforms: ["linux/arm64", "linux/amd64"] });
    expect(JSON.stringify(list)).not.toMatch(/latest|:\d+\/|amazonaws/u);
    expect(PrepullListSchema.safeParse(list).success).toBe(true);
    expect(list.catalogRevision).toBe(catalog.revision);
  });
  it("leaves a retired default and a not-pinned-yet entry out", () => {
    const retired = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "mysql@8")!["status"] = "retired"; });
    expect(catalogPrepullList(retired).images.map((image) => image.id)).not.toContain("mysql@8");
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
const request = (overrides: Partial<ResolveCatalogImageInput> = {}): ResolveCatalogImageInput => ({
  catalog, catalogId: "postgres@16", edition: "enterprise", served: { source: "company_registry", digest: digest("postgres@16") }, approvals: portOf(), ...overrides,
});
const refusal = async (input: ResolveCatalogImageInput) => {
  const result = await resolveCatalogImage(input);
  return result.ok ? "ok" : result.code;
};

describe("resolving an image to start", () => {
  it("starts the catalog's digest, from Rovara's registry in Public and from the bundle or the company's registry in Enterprise", async () => {
    expect(await resolveCatalogImage(request({ edition: "public", served: { source: "rovara_registry", digest: digest("postgres@16") } }))).toEqual({
      ok: true, id: "postgres@16", kind: "catalog", repository: "svc/postgres", digest: digest("postgres@16"), source: "rovara_registry",
    });
    for (const source of ["signed_bundle", "company_registry"] as const) {
      expect(await refusal(request({ served: { source, digest: digest("postgres@16") } }))).toBe("ok");
    }
  });
  it("refuses a source the edition does not use", async () => {
    expect(await refusal(request({ edition: "public", served: { source: "company_registry", digest: digest("postgres@16") } }))).toBe("source_not_allowed");
    expect(await refusal(request({ edition: "enterprise", served: { source: "rovara_registry", digest: digest("postgres@16") } }))).toBe("source_not_allowed");
  });
  it("stops an image whose digest differs from the catalog's when there is no approved substitute, in the owner's words", async () => {
    const result = await resolveCatalogImage(request({ served: { source: "company_registry", digest: OTHER } }));
    expect(result).toEqual({ ok: false, id: "postgres@16", code: "digest_mismatch", message: "postgres image digest does not match the catalog and has no approved substitute" });
    expect(CATALOG_IMAGE_MESSAGES.digest_mismatch("postgres")).toBe("postgres image digest does not match the catalog and has no approved substitute");
  });
  it("refuses a digest that is not 64 lower-case hex, a tag in place of a digest, and an unknown id", async () => {
    for (const bad of ["latest", "16", digest("postgres@16").toUpperCase(), digest("postgres@16").slice(1), `sha256:${digest("postgres@16")}`]) {
      expect(await refusal(request({ served: { source: "company_registry", digest: bad } })), bad).toBe("unknown_entry");
    }
    expect(await refusal(request({ catalogId: "mongo@7" }))).toBe("unknown_entry");
    expect(await refusal(request({ catalogId: "not an id" }))).toBe("unknown_entry");
  });
  it("refuses a retired entry, an unpinned catalog and an edition the entry is not offered in", async () => {
    const retired = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@16")!["status"] = "retired"; });
    expect(await refusal(request({ catalog: retired }))).toBe("retired");
    expect(await refusal(request({ catalog: unpinnedCatalog() }))).toBe("not_pinned");
    const publicOnly = pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@16")!["editions"] = ["public"]; });
    expect(await refusal(request({ catalog: publicOnly }))).toBe("edition_not_offered");
  });

  describe("a company-built substitute (DC-TS-1)", () => {
    const good = (): ResolveCatalogImageInput => request({ substitute: substitute(), approvals: portOf(approvalFor()), served: { source: "company_registry", digest: OTHER } });
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
      expect(await refusal({ ...good(), served: { source: "company_registry", digest: OTHER_TWO } })).toBe("substitute_not_served");
      expect(await refusal({ ...good(), served: { source: "company_registry", digest: digest("postgres@16") } })).toBe("substitute_not_served");
    });
    it("is not allowed in Public, or for Rovara's own emulator, fake server or helpers, or when its shape is wrong", async () => {
      expect(await refusal({ ...good(), edition: "public", served: { source: "rovara_registry", digest: OTHER } })).toBe("substitute_not_allowed");
      for (const id of ["local-aws@r1", "fake-server@r1", "dns-helper@r1"]) {
        const sub = { digest: OTHER, catalogDigest: digest(id), approvalRef: APPROVAL };
        expect(await refusal(request({ catalogId: id, substitute: sub, served: { source: "company_registry", digest: OTHER }, approvals: portOf({ approvalRef: APPROVAL, catalogId: id, catalogDigest: digest(id), digest: OTHER }) })), id).toBe("substitute_not_allowed");
      }
      expect(await refusal({ ...good(), substitute: substitute({ digest: digest("postgres@16") }) })).toBe("substitute_not_allowed");
      expect(await refusal({ ...good(), substitute: substitute({ approvalRef: "x" }) })).toBe("substitute_not_allowed");
    });
    it("asks the approval store nothing when an earlier check already refused", async () => {
      let asked = 0;
      const counting: SubstituteApprovalPort = { find: async () => { asked += 1; return approvalFor(); } };
      await resolveCatalogImage({ ...good(), substitute: substitute({ catalogDigest: OTHER_TWO }), approvals: counting });
      await resolveCatalogImage({ ...good(), edition: "public", served: { source: "rovara_registry", digest: OTHER }, approvals: counting });
      expect(asked).toBe(0);
    });
  });

  it("stops only the image that mismatches: the others in the same call still start", async () => {
    const results = await resolveCatalogImages([
      request({ catalogId: "postgres@16", served: { source: "company_registry", digest: OTHER } }),
      request({ catalogId: "mysql@8", served: { source: "company_registry", digest: digest("mysql@8") } }),
      request({ catalogId: "valkey@8", approvals: { find: async () => { throw new Error("boom"); } }, served: { source: "company_registry", digest: digest("valkey@8") } }),
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

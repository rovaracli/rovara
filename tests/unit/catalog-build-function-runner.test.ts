// Slice 4, lane C1: catalog-build over the function runner's entries, run against fakes (nothing here starts a process, opens a connection or reads a credential). It is the proof of what the next signing run does with them.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrepullListSchema, ServiceCatalogSchema, catalogPrepullList } from "@rovara-code/contracts";
import { FUNCTION_RUNNER_CATALOG_IDS, FunctionRunnerPrepullListSchema, isFunctionRunnerCatalogId } from "@agentx/cloud-contracts";
import { CatalogBuildError, DEFAULT_FUNCTION_RUNNER_PREPULL_FILE, buildPinnedCatalog, writeCatalogBuild, type CatalogBuildPorts } from "../../scripts/catalog-build.js";
import { sha, testSigner } from "../support/catalog-pinning.js";

const shipped = JSON.parse(readFileSync("environments/service-catalog/catalog.json", "utf8")) as { entries: unknown[] };
const runnerEntries = (JSON.parse(readFileSync("environments/service-catalog/function-runner-entries.json", "utf8")) as { entries: unknown[] }).entries;
const nextCatalog = { ...shipped, revision: 4, entries: [...shipped.entries, ...runnerEntries] };
const sourceDigest = (id: string) => sha(`source:${id}`);
const sources: { schemaVersion: number; sources: Record<string, string> } = { schemaVersion: 1, sources: Object.fromEntries(FUNCTION_RUNNER_CATALOG_IDS.map((id) => [id, `registry.example.com/mirror/${id.slice(0, id.indexOf("@"))}@sha256:${sourceDigest(id)}`])) };
const child = (id: string, platform: string) => sha(`child:${id}:${platform}`);

function ports(change: { platforms?: (id: string) => string[] } = {}): CatalogBuildPorts {
  const signer = testSigner();
  const built: CatalogBuildPorts = {
    async mirror({ id, expectedDigest }) { return { digest: expectedDigest, children: (change.platforms?.(id) ?? ["linux/arm64"]).map((platform) => ({ platform: platform as "linux/arm64", digest: child(id, platform) })) }; },
    async sbom({ id, platform }) { return Buffer.from(JSON.stringify({ spdxVersion: "SPDX-2.3", name: `${id} ${platform}`, packages: [] })); },
    async scan({ digest }) { return { digest, status: "complete" as const, criticalOpen: 0, highOpen: 1, scannedAt: "2026-11-12T10:00:00.000Z" }; },
    async registryServes() { return true; },
    signer: { publicKeyPem: signer.publicKeyPem, sign: async (message) => signer.sign(message) },
  };
  return built;
}
const sourcesFor = (ids: readonly string[]): { schemaVersion: number; sources: Record<string, string | undefined> } => ({ schemaVersion: 1, sources: Object.fromEntries(ids.map((id) => [id, sources.sources[id]])) });
const buildRunner = (p: CatalogBuildPorts, entries: string[] = [...FUNCTION_RUNNER_CATALOG_IDS]) => buildPinnedCatalog({ catalog: nextCatalog, sources: sourcesFor(entries), env: "staging", ports: p, entries });

describe("catalog-build over the runner's entries", () => {
  it("pins them by the source digest (the shipped pins carried over untouched), keeps them OUT of the services pre-pull, and writes them to the runner's own list: arm64 only, digests only", async () => {
    const output = await buildRunner(ports());
    const pinned = ServiceCatalogSchema.parse(JSON.parse(output.catalogBytes.toString("utf8")));
    expect(pinned.revision).toBe(5);
    for (const id of FUNCTION_RUNNER_CATALOG_IDS) {
      const entry = pinned.entries.find((candidate) => candidate.id === id)!;
      expect(entry.image.digest, id).toBe(sourceDigest(id));
      expect(entry.image.platforms, id).toEqual(["linux/arm64"]);
      expect(entry.sbomRef, id).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.scan?.criticalOpen, id).toBe(0);
    }
    const before = ServiceCatalogSchema.parse(shipped);
    for (const entry of before.entries) expect(pinned.entries.find((candidate) => candidate.id === entry.id)!.image.digest, entry.id).toBe(entry.image.digest);
    // The vendored list would hold them; the file the services boot step reads does not.
    expect(catalogPrepullList(pinned).images.map((image) => image.id)).toEqual(expect.arrayContaining([...FUNCTION_RUNNER_CATALOG_IDS]));
    const services = PrepullListSchema.parse(JSON.parse(output.prepullBytes.toString("utf8")));
    expect(services.images.some((image) => isFunctionRunnerCatalogId(image.id))).toBe(false);
    expect(services.images.map((image) => image.id).sort()).toEqual(["local-aws@r1", "postgres@16"]);
    const runner = FunctionRunnerPrepullListSchema.parse(JSON.parse(output.functionRunnerPrepullBytes.toString("utf8")));
    expect(runner.images.map((image) => image.id)).toEqual([...FUNCTION_RUNNER_CATALOG_IDS]);
    expect(runner.catalogRevision).toBe(5);
    for (const image of runner.images) { expect(image.digest).toBe(sourceDigest(image.id)); expect(image.platforms).toEqual(["linux/arm64"]); }
  });

  it("refuses a source image that also holds amd64 (a wrong-architecture image is never mirrored into an arm64-only entry), and one that holds no arm64", async () => {
    const refusals = async (p: CatalogBuildPorts) => { try { await buildRunner(p, ["lambda-python@3.12"]); } catch (error) { if (error instanceof CatalogBuildError) return error.refusals.map(({ id, code }) => ({ id, code })); throw error; } return []; };
    expect(await refusals(ports({ platforms: () => ["linux/arm64", "linux/amd64"] }))).toEqual([{ id: "lambda-python@3.12", code: "platforms_mismatch" }]);
    expect(await refusals(ports({ platforms: () => ["linux/amd64"] }))).toEqual([{ id: "lambda-python@3.12", code: "platforms_mismatch" }]);
  });

  it("refuses a tag or a malformed source for a runner entry (a source is host/path@sha256:<digest>)", async () => {
    for (const bad of ["registry.example.com/mirror/lambda-python:3.12", "registry.example.com/mirror/lambda-python", "public.ecr.aws/lambda/python@sha256:short"]) {
      const sourcesBad = { schemaVersion: 1, sources: { "lambda-python@3.12": bad } };
      await expect(buildPinnedCatalog({ catalog: nextCatalog, sources: sourcesBad, env: "staging", ports: ports(), entries: ["lambda-python@3.12"] }), bad).rejects.toThrow();
    }
  });

  describe("writing", () => {
    const dirs: string[] = [];
    afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
    it("writes the runner list beside the services one when asked, and not otherwise; the default is the file in the worker image's catalog folder", async () => {
      expect(DEFAULT_FUNCTION_RUNNER_PREPULL_FILE).toBe("packages/worker/service-catalog/function-runner-prepull.json");
      const output = await buildRunner(ports());
      const root = await mkdtemp(join(tmpdir(), "catalog-build-runner-"));
      dirs.push(root);
      await writeFile(join(root, "keep"), "x");
      await writeCatalogBuild(output, { catalogDir: join(root, "c"), prepullFile: join(root, "p.json"), evidenceDir: join(root, "e") });
      await expect(readFile(join(root, "r.json"))).rejects.toThrow();
      await writeCatalogBuild(output, { catalogDir: join(root, "c"), prepullFile: join(root, "p.json"), evidenceDir: join(root, "e"), functionRunnerPrepullFile: join(root, "r.json") });
      expect(JSON.parse(await readFile(join(root, "r.json"), "utf8"))).toEqual(JSON.parse(output.functionRunnerPrepullBytes.toString()));
      expect(JSON.parse(await readFile(join(root, "p.json"), "utf8"))).toEqual(JSON.parse(output.prepullBytes.toString()));
    });
  });
});

describe("the shipped runner list", () => {
  it("is the empty list at the shipped catalog's revision (nothing is pinned yet), and the same file the worker image carries", () => {
    const list = FunctionRunnerPrepullListSchema.parse(JSON.parse(readFileSync("packages/worker/service-catalog/function-runner-prepull.json", "utf8")));
    expect(list.images).toEqual([]);
    expect(list.catalogRevision).toBe((shipped as { revision?: number }).revision ?? 3);
  });
});

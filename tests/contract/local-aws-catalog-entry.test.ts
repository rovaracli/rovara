// Test services slice 2 (s2-catalog, task 2): the `local-aws` catalog entry. Since 2026-11-11 (owner decisions 105 and 106) the engine is AWS's first-party AWS Emulator behind Rovara's own front layer, and the memory slot is 512 MiB (it replaced 384, the figure for the
// old native fork). The gates are DECISIONS.md 106: private memory (RssAnon) at most 256 MiB at peak for the front layer and the engine together; the spike measured the engine alone at 171 MiB idle and 214 MiB peak.
import { describe, expect, it } from "vitest";
import { catalogPrepullList } from "@rovara-code/contracts";
import { pinnedCatalog, unpinnedCatalog } from "../support/catalog-pinning.js";

const MEASURED_ENGINE_PRIVATE_PEAK_MIB = 214;
const PRIVATE_PEAK_TARGET_MIB = 256;

const entry = unpinnedCatalog().entries.find((candidate) => candidate.id === "local-aws@r1");

describe("the local-aws catalog entry", () => {
  it("is the emulator: emulated backing, arm64 only, health on /_rovara/health, run as a non-root user with a read-only root", () => {
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ family: "local-aws", backing: "emulated", image: { repository: "svc/local-aws", platforms: ["linux/arm64"] } });
    expect(entry?.health).toEqual({ kind: "http", port: 4566, path: "/_rovara/health", startTimeoutS: 30 });
    expect(entry?.run).toMatchObject({ user: "10001:10001", readOnlyRoot: true, ports: [4566] });
  });
  it("is a default entry, so a worker pre-pulls it as soon as the catalog pins it, and it is in the list of an all-pinned catalog", () => {
    expect(entry?.status).toBe("default");
    expect(catalogPrepullList(pinnedCatalog()).images.map((image) => image.id)).toContain("local-aws@r1");
  });
  it("stays unpinned in the committed file until the catalog run pins it (no digest, no SBOM, no scan)", () => {
    expect(entry?.image.digest).toBeUndefined();
    expect(entry?.sbomRef).toBeUndefined();
    expect(entry?.scan).toBeUndefined();
  });
  it("has a memory limit (512 MiB, decision 106) that holds the private-memory gate, the writable tmpfs and room for test data", () => {
    const limit = entry!.resources.memMiB;
    const tmpfs = entry!.run.tmpfs.reduce((total, mount) => total + mount.sizeMiB, 0);
    // The run may use the gate's whole private budget (256 MiB, front layer and engine together) and a full tmpfs, which cannot be reclaimed, and still have room for in-memory test data (the store is in memory) without being killed.
    expect(limit).toBeGreaterThanOrEqual(PRIVATE_PEAK_TARGET_MIB + tmpfs + 128);
    expect(limit).toBeGreaterThanOrEqual(MEASURED_ENGINE_PRIVATE_PEAK_MIB + tmpfs);
    expect(limit).toBe(512);
    // No swap is given to a helper (the worker sets memory-swap to the limit), so the limit is a hard cap.
    expect(entry!.resources.cpus).toBeGreaterThan(0);
  });
  it("names the engine's licences: Rovara's own front layer, CC0 for AWS Emulator and Apache-2.0 for its vendor/ directory (the notices ship in the image)", () => {
    expect(entry?.licence).toBe("LicenseRef-Rovara AND CC0-1.0 AND Apache-2.0");
  });
  it("keeps the family, the id and the alias, so approved plans and seeds keep working across catalog revisions 3 and 4", () => {
    expect(entry).toMatchObject({ id: "local-aws@r1", family: "local-aws", connect: { defaultAliases: ["aws"] }, reset: { kind: "http_reset" }, emulator: { iamEnforced: false, storage: "memory" } });
  });
});

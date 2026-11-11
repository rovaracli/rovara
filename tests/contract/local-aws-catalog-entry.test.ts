// Test services slice 2 (s2-catalog, task 2): the `local-aws` catalog entry. Its memory limit comes from the emulator's native-image gate on the first arm64 Linux build (owner decision 2026-11-03: the gate counts the run's own,
// private memory; total RSS is information). The numbers are in DECISIONS.md (2026-11-03, "Emulator memory gate") and the fork's perf/RESULTS.md.
import { describe, expect, it } from "vitest";
import { catalogPrepullList } from "@rovara-code/contracts";
import { pinnedCatalog, unpinnedCatalog } from "../support/catalog-pinning.js";

// Measured on the arm64 build, 54-call matrix: private (RssAnon) 11 MiB idle and 39 MiB peak; TOTAL resident 93 MiB idle and 125.6-129.0 MiB peak (the extra is the 126 MB binary's file-backed pages, which are shared and reclaimable).
const MEASURED_TOTAL_PEAK_MIB = 129;
const MEASURED_PRIVATE_PEAK_MIB = 39;
const PRIVATE_PEAK_TARGET_MIB = 128;

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
  it("has a memory limit that holds the measured total peak, the writable tmpfs and room for test data, and is no longer the JVM figure (640 MiB)", () => {
    const limit = entry!.resources.memMiB;
    const tmpfs = entry!.run.tmpfs.reduce((total, mount) => total + mount.sizeMiB, 0);
    // The container's limit counts every page of the process, file-backed ones included (the kernel reclaims those first), plus the tmpfs, which cannot be reclaimed: both fit with room for in-memory test data (the store is in memory).
    expect(limit).toBeGreaterThanOrEqual(MEASURED_TOTAL_PEAK_MIB + tmpfs + 128);
    // And well above the private target: the run may use the gate's whole private budget (128 MiB) and a full tmpfs without being killed.
    expect(limit).toBeGreaterThanOrEqual(PRIVATE_PEAK_TARGET_MIB + tmpfs + MEASURED_PRIVATE_PEAK_MIB);
    // Not the JVM figure: the native binary needs a fraction of it.
    expect(limit).toBeLessThan(640);
    expect(limit).toBe(384);
    // No swap is given to a helper (the worker sets memory-swap to the limit), so the limit is a hard cap.
    expect(entry!.resources.cpus).toBeGreaterThan(0);
  });
});

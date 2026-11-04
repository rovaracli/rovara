// @vitest-environment jsdom
// Test services, slice 1 T4: the Evidence tab's Environment section lists each dependency with the honesty label's words, and nothing for a pack without any.
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { EvidenceViewSchema, type CheckEntry } from "@agentx/contracts";
import { buildEvidencePack, evidenceViewOf } from "../../packages/broker/src/rovara-code/evidence-pack.js";
import { EvidenceTab } from "../../packages/ui/src/screens/session/EvidenceTab.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const DIGEST = "c".repeat(64);
const CHECKS: CheckEntry[] = [{ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 7, exitCode: 0 }];
const raw = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], testServices: { schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 840, resetCount: 1 }], unknownCalls: { domains: [], otherCount: 0 } } });
const taskWith = (dependencies: ReadonlyArray<{ id: string; name: string; backing: "local" }> | undefined) => {
  const built = buildEvidencePack({ candidateDigest: DIGEST, rawText: raw, checks: CHECKS, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map(), ...(dependencies === undefined ? {} : { dependencies }) });
  const view = EvidenceViewSchema.parse(evidenceViewOf(built.pack!, "task-1", () => "available"));
  return { evidence: view } as never;
};

const show = (task: never) => renderUi(h(AppHostProvider, { host: fakeHost().host, children: h(EvidenceTab, { task }) }));

describe("the Evidence tab's dependencies", () => {
  it("lists a dependency with its label and start time", () => {
    show(taskWith([{ id: "postgres", name: "Postgres", backing: "local" }]));
    const list = screen.getByRole("list", { name: "Dependencies" });
    expect(list.textContent).toBe("Postgres: real, started in 840 ms");
  });

  it("says a dependency that did not run is not available, with the fallback", () => {
    // A pinned dependency the record does not list.
    show(taskWith([{ id: "redis", name: "Redis", backing: "local" }]));
    expect(screen.getByRole("list", { name: "Dependencies" }).textContent).toBe("Redis: not available (fallback: did not start)");
  });

  it("shows nothing for a pack without dependencies", () => {
    show(taskWith(undefined));
    expect(screen.queryByRole("list", { name: "Dependencies" })).toBeNull();
  });
});

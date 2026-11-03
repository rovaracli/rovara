// Test services, slice 1 T4 (design test-services.md 2.4, 8.1 and 9.3): the evidence rows of a round's dependencies, built by the BROKER from what it pinned and what the worker reported.
//
// The label is the broker's: it comes from the approved backing (`evidenceDependencyLabelFor`), never from the worker. The worker's usage record only says whether a dependency really ran
// and for how long. A dependency the record does not show started and healthy is NOT shown as running ("not available", fell back: did not start): a missing or broken record never makes a result look better.
// The names the sealed tests asked for that no dependency answers are counted as registrable domain + count in one "Blocked by environment" line, never with a path, a query or a value.
import { evidenceDependencyLabelFor, testServicesUnknownCallCount, type EvidenceDependency, type EvidenceNotTested, type EvidenceRaw } from "@agentx/contracts";
import { inertLine } from "./inert-text.js";

/** A dependency as the broker pinned it for the run (from the approved environment's backing, not from the worker). */
export interface PinnedDependency {
  id: string;
  name: string;
  /** Slice 1 starts real software only. */
  backing: "local";
  /** True when a company-approved substitute image was pinned (not used in slice 1). */
  substituteImage?: boolean;
}

export const BLOCKED_CALLS_ITEM_ID = "blocked-calls";
export const NO_USAGE_RECORD_ITEM: EvidenceNotTested = { kind: "environment", id: "test-services", text: "What the test services did was not reported", reason: "no usage record" };
const BLOCKED_LISTED = 5;

export interface DependencyEvidence { dependencies: EvidenceDependency[]; notTested: EvidenceNotTested[] }

const plain = (text: string, max: number): string => inertLine(text, max);

/** The pack's dependency rows and the not-tested items for a round. Pure. */
/** The worker's record of the round, as the raw evidence file carries it (`EvidenceRaw["testServices"]`). Only the evidence build reads it. */
export type RawUsage = EvidenceRaw["testServices"];

export function dependencyEvidenceOf(pinned: readonly PinnedDependency[], usage: RawUsage): DependencyEvidence {
  const taken = new Set<string>();
  const dependencies = pinned.map((dependency): EvidenceDependency => {
    // A pack's dependency names are unique; two with the same words are told apart by their ids.
    let name = plain(dependency.name, 80);
    if (name === "" || taken.has(name)) name = plain(`${name === "" ? "dependency" : name} (${dependency.id})`, 80);
    taken.add(name);
    const used = usage?.dependencies.find((entry) => entry.id === dependency.id);
    const ran = used !== undefined && used.started && used.healthy && used.failure === undefined;
    if (!ran) return { name, backing: "none", label: "not_available", fellBack: { from: "local", reason: "did_not_start" } };
    return { name, backing: "local", label: evidenceDependencyLabelFor({ backing: "local", ...(dependency.substituteImage === true ? { substituteImage: true } : {}) }), startedMs: used.startMs };
  });
  const notTested: EvidenceNotTested[] = [];
  if (usage === undefined) notTested.push(NO_USAGE_RECORD_ITEM);
  else {
    const total = testServicesUnknownCallCount(usage);
    if (total > 0) {
      const listed = usage.unknownCalls.domains.slice(0, BLOCKED_LISTED).map((entry) => `${entry.domain} (${entry.count})`);
      const others = total - usage.unknownCalls.domains.slice(0, BLOCKED_LISTED).reduce((sum, entry) => sum + entry.count, 0);
      const text = `Blocked by environment: ${total} ${total === 1 ? "call" : "calls"} to names no dependency answers${listed.length === 0 ? "" : `: ${listed.join(", ")}`}${others > 0 && listed.length > 0 ? ` and ${others} more` : ""}`;
      notTested.push({ kind: "environment", id: BLOCKED_CALLS_ITEM_ID, text: text.slice(0, 300), reason: "blocked by environment" });
    }
  }
  return { dependencies, notTested };
}

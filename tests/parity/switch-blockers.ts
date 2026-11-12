// What must be done before the combined switch (decision 130), drawn from the known differences: one line each, in plain words, with its owner and the
// known-difference entries that show it. The parity report's summary page lists these for the owner. A test checks that every entry named here exists, so
// the list cannot point at a difference that is gone (remove the blocker with its entries).
import type { Facet } from "./harness/types.js";

export interface SwitchBlocker {
  id: string;
  /** In plain words, for the owner. */
  what: string;
  /** Which side changes: Code (upstream, then a vendor pin bump), the composition root (S0 follow-up), Cloud, or a vendor re-pin. */
  side: "Code" | "root" | "Cloud" | "re-pin";
  owner: string;
  /** The known-difference entries that show it (scenario and facet). */
  shownBy: readonly { scenario: string; facet: Facet }[];
}

export const SWITCH_BLOCKERS: readonly SwitchBlocker[] = [
  { id: "G1", side: "Code", owner: "public PR #493", what: "A merged pull request writes no audit entry on the shared engine, so merges would vanish from the audit ledger.", shownBy: [{ scenario: "pr-merged", facet: "audit" }] },
  { id: "G2", side: "Code", owner: "public PR #493", what: "A lost worker machine leaves the task running for ever on the shared engine (Cloud blocks it with Retry).", shownBy: [{ scenario: "worker-lost", facet: "transitions" }] },
  { id: "G3", side: "re-pin", owner: "vendor re-pin after mainline sync PR #492 (public #484 is merged)", what: "With Understand off, a plan sent back for changes is never re-planned, and a Full task stops after its first plan.", shownBy: [{ scenario: "plan-changes-requested", facet: "transitions" }, { scenario: "parallel-parts", facet: "transitions" }] },
  { id: "G4", side: "Code", owner: "public PR #493, then root (room by path)", what: "A Full task needs $2 of budget left on Cloud; the shared engine lets it start with $0.50.", shownBy: [{ scenario: "people-money-spend-full-path", facet: "spend" }] },
  { id: "S0-143b", side: "root", owner: "S0 follow-up lane + Code (milestone events)", what: "Slack threads should get key milestones (plan ready, PR opened, done) plus every needs-you notice (decision 143b); the shared engine sends only needs-you notices today.", shownBy: [{ scenario: "*", facet: "messages" }] },
  { id: "S0-143c", side: "root", owner: "S0 follow-up lane", what: "Turning automations off must also stop runs already started, at a safe point (decision 143c).", shownBy: [{ scenario: "features-d-chain-switch-off", facet: "transitions" }] },
  { id: "S0-144", side: "Code", owner: "Code (approval card by risk) + root (A8 step-up list by risk)", what: "Low- and medium-risk plans must be approvable in the Slack thread, high-risk ones in the web app (decision 144); the shared engine posts no approval card to Slack.", shownBy: [{ scenario: "slack-channel", facet: "features" }] },
  { id: "R-SESSIONS", side: "Cloud", owner: "Cloud agent-sessions lane", what: "A Slack-started task on Cloud has no session, so it cannot be messaged and open pages are not told about it; the shared engine gives every task one.", shownBy: [{ scenario: "session-message-mid-run", facet: "features" }, { scenario: "realtime", facet: "features" }] },
  { id: "W0-2", side: "Code", owner: "Code lane (brief: briefs/w0-2-devcontainer-walled-network-upstream.md)", what: "Code's worker lets a dev container join a network of its own; Cloud's worker keeps it on the walled task network. Cloud cannot run on Code's worker until Code has the same wall.", shownBy: [{ scenario: "devcontainer", facet: "features" }] },
  { id: "DIAG", side: "Code", owner: "Code (diagnosis words seam) + root (Cloud's words)", what: "With no model provider, Fix with agent tells a Cloud person to run a laptop command (`rovara up --check`).", shownBy: [{ scenario: "diagnosis", facet: "features" }] },
  { id: "ERASE", side: "root", owner: "root lane (brief: briefs/s0-person-erase-core-root-lane.md)", what: "Removing a person must also erase the evidence of their tasks that ran on the shared engine; the walk is written and tested in the suite, not yet in the product.", shownBy: [{ scenario: "*", facet: "rows" }] },
  { id: "WIRING", side: "root", owner: "S0 follow-up lane", what: "The composition root still owes: Slack into the shared engine (inbound wiring, task work, tenant rows, the Slack channel), the realtime publisher, task-end handlers and the merge people lookup from A6.", shownBy: [{ scenario: "slack-channel", facet: "transitions" }, { scenario: "pr-merged", facet: "rows" }] },
  { id: "ROWS", side: "root", owner: "S0 follow-up lane (D3 data move, limit family, Cloud readers)", what: "Stored records differ: workspace limits are counted on different rows, and the artifact and event keys differ, so Cloud's pages must read the shared engine's keys first.", shownBy: [{ scenario: "*", facet: "rows" }] },
];

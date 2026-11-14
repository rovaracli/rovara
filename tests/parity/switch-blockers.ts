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
  { id: "G2", side: "Code", owner: "public PR #493", what: "A lost worker machine now ends the step INTERRUPTED and blocks it on the shared engine (public 3cb1053f, in the 0.5.17 pin); what is left is the wording and the dispatch rows (Cloud ends it failed, with Retry and its own recovery rows).", shownBy: [{ scenario: "worker-lost", facet: "transitions" }] },
  { id: "G3", side: "root", owner: "S0 settings mapping (S0-Q2): map Cloud's Full path onto a 1.1.0 task, or Code allows parts on 1.0.0", what: "Plans sent back for changes are re-planned now (0.5.17 pin). What is left: with Understand off the shared engine refuses to start a plan with parts (it runs them only on a version 1.1.0 task, which Understand-first starts), so Cloud's Full path with parts needs Understand on or the install's dependencies switch.", shownBy: [{ scenario: "parallel-parts", facet: "transitions" }] },
  { id: "G4", side: "Code", owner: "public PR #493, then root (room by path)", what: "A Full task needs $2 of budget left on Cloud; the shared engine lets it start with $0.50.", shownBy: [{ scenario: "people-money-spend-full-path", facet: "spend" }] },
  { id: "S0-143b", side: "root", owner: "S0 follow-up lane + Code (milestone events)", what: "Slack threads should get key milestones (plan ready, PR opened, done) plus every needs-you notice (decision 143b); the shared engine sends only needs-you notices today.", shownBy: [{ scenario: "*", facet: "messages" }] },
  { id: "S0-144", side: "Code", owner: "Code (approval card by risk) + root (A8 step-up list by risk)", what: "Low- and medium-risk plans must be approvable in the Slack thread, high-risk ones in the web app (decision 144); the shared engine posts no approval card to Slack.", shownBy: [{ scenario: "slack-channel", facet: "features" }] },
  { id: "DIAG", side: "Code", owner: "Code (diagnosis words seam) + root (Cloud's words)", what: "With no model provider, Fix with agent tells a Cloud person to run a laptop command (`rovara up --check`).", shownBy: [{ scenario: "diagnosis", facet: "features" }] },
  { id: "ERASE", side: "root", owner: "root lane (brief: briefs/s0-person-erase-core-root-lane.md)", what: "Removing a person must also erase the evidence of their tasks that ran on the shared engine; the walk is written and tested in the suite, not yet in the product.", shownBy: [{ scenario: "*", facet: "rows" }] },
  { id: "WIRING", side: "Code", owner: "Code (export the service layer: S0-Q1) and Code (taskEnded on merge)", what: "The root now builds its pieces: the realtime publisher with Cloud's page notices, MergePeople from Cloud's members, the task end on close and on merge, Cloud's Slack work, the Slack intake and the CHANNEL_TENANTS backfill. What stays open: the core's own services (merge tracking, session sweep, notices) are inside Code's unexported local composition, so the root cannot yet compose them over its pieces, and the core now calls its task-end seam on merge as well as close (0.5.17 pin).", shownBy: [{ scenario: "pr-merged", facet: "rows" }] },
  { id: "ROWS", side: "Code", owner: "the lessons adoption (X2); the task-end handler wiring is the root's", what: "A merged pull request on the shared engine now writes its task-end record (0.5.17 pin); a core task still has no track-record outcome rows until lessons move. The artifact key, the event keys and the limit family are now read in both shapes by Cloud's readers.", shownBy: [{ scenario: "pr-merged", facet: "rows" }] },
];

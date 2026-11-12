// The 46 parity areas of CLOUD-ON-CODE-CONVERGENCE-PLAN.md section 1, as the parity suite reports them. `switched` names the area group decision 130's
// one combined switch moves (merge tracking, the build step, the task flow); `cloudOnly` areas never run on the core (decision 41), so the suite reports
// them as not covered with that reason instead of comparing.
import type { CoreArea } from "../../packages/broker/src/cloud/app/flags.js";

export interface ParityArea {
  id: number;
  name: string;
  /** The switch group that moves this area onto the core (undefined: it rides along with the flow, or is not switched yet). */
  switched?: CoreArea;
  /** Stays Cloud's own (decision 41): no core path to compare. */
  cloudOnly?: string;
}

export const PARITY_AREAS: readonly ParityArea[] = [
  { id: 1, name: "Task start, stage machine, dispatch, fences, workspace limits", switched: "flow" },
  { id: 2, name: "Understand step (questions)", switched: "flow" },
  { id: 3, name: "Plan step, plan check, plan quality, dry run, grounding", switched: "flow" },
  { id: 4, name: "Structured plans, work breakdown, owner answers", switched: "flow" },
  { id: 5, name: "Decisions and plan approval (risk cards, step-up)", switched: "flow" },
  { id: 6, name: "Coding step, checks, send-backs, autofix", switched: "build" },
  { id: 7, name: "Code and security reviews", switched: "build" },
  { id: 8, name: "Second review (different model)", switched: "build" },
  { id: 9, name: "Design review", switched: "flow" },
  { id: 10, name: "E2E (browser and API checks on the app)", switched: "build" },
  { id: 11, name: "Parallel parts, milestones, task dependencies, complex work", switched: "flow" },
  { id: 12, name: "Merge, merge tracking, branch sync, CI fix", switched: "merge" },
  { id: 13, name: "Proof: PR body, evidence pack, risk, revert detection", switched: "build" },
  { id: 14, name: "Lessons", switched: "flow" },
  { id: 15, name: "Team record", cloudOnly: "team record is Cloud-only (decision 41); it plugs in as an adapter" },
  { id: 16, name: "Chains, triggers, automatic runs", cloudOnly: "held by decision 45.10 (hidden in Cloud)" },
  { id: 17, name: "Custom agents", cloudOnly: "held by decision 45.10 (hidden in Cloud)" },
  { id: 18, name: "Tracker intake and write-back", switched: "flow" },
  { id: 19, name: "Notifications (needs-you, batched; Slack and email)", switched: "flow" },
  { id: 20, name: "Slack and other channels", switched: "flow" },
  { id: 21, name: "Agent sessions (status, stop, retry, tell, Ask, steer, peek)", switched: "flow" },
  { id: 22, name: "Per-task cost (estimate, actual)", switched: "flow" },
  { id: 23, name: "Budgets, money limits, top-ups, payer, task stops", switched: "flow" },
  { id: 24, name: "Model sources, model selection, BYO provider, key proxy", switched: "build" },
  { id: 25, name: "Approvals, identity, SSO, sign-in", switched: "flow" },
  { id: 26, name: "Audit ledger and verifier", switched: "flow" },
  { id: 27, name: "Saved environments", switched: "build" },
  { id: 28, name: "Test environment and test services", switched: "build" },
  { id: 29, name: "Setup agent, env-detect, project setup check", switched: "flow" },
  { id: 30, name: "Devcontainers", switched: "build" },
  { id: 31, name: "How we work / playbook, recipes, spec, standing instructions", switched: "flow" },
  { id: 32, name: "Diagnosis (Fix with agent)", switched: "flow" },
  { id: 33, name: "MCP, monitoring and context connections", switched: "build" },
  { id: 34, name: "MCP tools (editor)", switched: "flow" },
  { id: 35, name: "CLI", cloudOnly: "a surface over routes; Cloud's CLI is not switched" },
  { id: 36, name: "Script tokens and developer API", switched: "flow" },
  { id: 37, name: "Web app pages", cloudOnly: "Cloud-only (decision 41); reads core routes" },
  { id: 38, name: "Admin console and staff tools", cloudOnly: "Cloud-only (decision 41)" },
  { id: 39, name: "Org, members, invites, roles, member removal, erasure", switched: "flow" },
  { id: 40, name: "Realtime push to the web app", switched: "flow" },
  { id: 41, name: "Code host (GitHub App, webhooks, install pages)", switched: "merge" },
  { id: 42, name: "Check runners, external checks", switched: "build" },
  { id: 43, name: "Outbound events", switched: "flow" },
  { id: 44, name: "SWE-bench and eval batches", cloudOnly: "operator tooling, not switched" },
  { id: 45, name: "Devices / Mac local sessions", cloudOnly: "Cloud-only, unfinished, hidden (decision 14)" },
  { id: 46, name: "Deploy, upgrade, install, bundles, release pipeline", cloudOnly: "Cloud-only" },
];

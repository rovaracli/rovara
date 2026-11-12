// Lane A9: Cloud's Linear tracker (`packages/broker/src/plugins/tracker/linear`) under Code's Tracker suite. The install's Linear access (the reply port, the issue read, the hook) is
// in memory here; the adapter's own mapping and checks run as they are.
import type { OrgId } from "@rovara-code/contracts";
import { linearTracker, type LinearIssueRead, type LinearStateType } from "../../../packages/broker/src/plugins/tracker/linear/index.js";
import type { TrackerWorld } from "../../../vendor/rovara-code/tests/support/ports/tracker-conformance.js";
import { HOOK, SECRET } from "../../plugins/linear-fixtures.js";
import { defineCloudAdapter } from "../registry.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const STATE_OF: Record<string, LinearStateType> = { open: "unstarted", in_progress: "started", in_review: "started", done: "completed", cancelled: "canceled" };

export function linearWorld(): TrackerWorld {
  const issues = new Map<string, LinearIssueRead>();
  const replies: Array<{ issueKey: string; text: string }> = [];
  const tracker = linearTracker({
    reply: { reply: async (input) => { replies.push(input); }, ownActorId: async () => "rovara-bot" },
    readIssue: async (_orgId, key) => issues.get(key),
    hook: async () => ({ hook: HOOK, secret: SECRET }),
    installOrg: () => ORG,
  });
  return {
    tracker, scope: { system: "install" },
    addItem: (id, input) => {
      issues.set(id, {
        key: id, title: input?.title ?? `Issue ${id}`, description: input?.body ?? "", stateType: STATE_OF[input?.status ?? "open"] ?? "unstarted",
        ...(input?.assignee === undefined ? {} : { assignee: input.assignee }), labels: input?.labels ?? [], url: `https://linear.app/acme/issue/${id}/x`,
      });
    },
    statusOf: () => undefined,
    commentsOf: (id) => replies.filter((reply) => reply.issueKey === id).map((reply) => reply.text),
  };
}

export const linearTrackerAdapter = defineCloudAdapter({
  port: "tracker",
  name: "Linear",
  harness: {
    makeWorld: linearWorld,
    skip: {
      "maps a signed delivery to the neutral events that can start a task, and nothing from a forged one":
        "Cloud's Linear webhook maps only an issue created with a label (item.labelled); an assignment starts work through the `linear` trigger source, not this port (tests/plugins/linear-tracker.test.ts covers the mapping it has)",
    },
  },
});

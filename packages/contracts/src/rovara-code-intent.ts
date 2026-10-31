// Rovara Code (Plan 6 Task 3): the one request that starts work from any surface. `CodeIntentRequestSchema` is what `startCodeIntent` takes (the broker's own code and
// Plan 9 call it directly); `CodeIntentBodySchema` is the whole of what a person's request may say on `POST /v1/app/projects/{project}/code`. Everything that names
// who pays, where the work came from or what it follows (source, binding, assigner, offer) is trusted input from broker code, so no request body can carry it.
//
// This file imports `agent-run.ts` (and through it `agent.ts`, which uses `node:crypto`), so it is not browser-safe; the web app sends the body without importing it.
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { RunInputSchema } from "./agent-run.js";
import { SessionBindingSchema } from "./browser-ids.js";
import { WorkflowPathSchema } from "./task-workflow.js";

/** Where an intent came from. The first three are a person's own client; the rest are Plan 9's surfaces. `jira`, `github_issue` and `tracker` are a ticket in an outside tracker (meta repo lane F). */
export const CODE_INTENT_SOURCES = ["app", "cli", "mcp", "slack", "linear", "jira", "github_issue", "tracker", "offer"] as const;
export type CodeIntentSource = (typeof CODE_INTENT_SOURCES)[number];

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const RequestIdSchema = z.string().uuid();

/** The kind of outside place each source may bind its session to. */
export const CODE_INTENT_BINDING_OF_SOURCE = { slack: "slack_thread", linear: "linear_issue", jira: "tracker_item", github_issue: "tracker_item", tracker: "tracker_item" } as const;

/** The tracker a ticket intent's source fixes: a Jira intent is for system `jira`, a GitHub Issues intent for `github`; a `tracker` intent is for any other system. */
const FIXED_TRACKER_SYSTEM_OF_SOURCE = { jira: "jira", github_issue: "github" } as const;

export const CodeIntentRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    project: z.string().regex(AGENTX_NAME_PATTERN),
    input: RunInputSchema,
    /** What the person asked for. Absent on a version 2 org means "Understand chooses"; a version 1 org needs it. */
    path: WorkflowPathSchema.optional(),
    source: z.enum(CODE_INTENT_SOURCES),
    /** A Slack thread (source `slack`) or a Linear issue (source `linear`) the session follows. */
    binding: SessionBindingSchema.optional(),
    /** Linear only: who assigned the issue, from Plan 9's own record. A person with no Rovara member, or a bot, is named without a `developerId`. */
    assignedBy: z.object({ developerId: Hex64.optional(), bot: z.boolean() }).strict().optional(),
    /** Offer only: the Home offer the person accepted. */
    offerId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
    /** The answered task this start follows (Task 6's "change anyway"). Trusted input from broker code: no request body can carry it. */
    retryOf: z.string().uuid().optional(),
    /** A hand-off from the Mac (Task 21). Accepted by shape; refused until that task lands. */
    startAt: z.object({ repository: z.string().min(1).max(200), commit: z.string().regex(/^[a-f0-9]{40}$/), summary: z.string().min(1).max(4000) }).strict().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const wanted = Object.hasOwn(CODE_INTENT_BINDING_OF_SOURCE, request.source) ? CODE_INTENT_BINDING_OF_SOURCE[request.source as keyof typeof CODE_INTENT_BINDING_OF_SOURCE] : undefined;
    if (request.binding !== undefined && request.binding.kind !== wanted) context.addIssue({ code: "custom", path: ["binding"], message: "a binding must match the source it came from" });
    if (wanted !== undefined && request.binding === undefined) context.addIssue({ code: "custom", path: ["binding"], message: `a ${request.source} intent names its ${request.source === "slack" ? "thread" : wanted === "tracker_item" ? "ticket" : "issue"}` });
    if (request.binding?.kind === "tracker_item") {
      const fixed = Object.hasOwn(FIXED_TRACKER_SYSTEM_OF_SOURCE, request.source) ? FIXED_TRACKER_SYSTEM_OF_SOURCE[request.source as keyof typeof FIXED_TRACKER_SYSTEM_OF_SOURCE] : undefined;
      const system = request.binding.system;
      // A `tracker` intent is for a team's own tracker: never one of the two that have sources of their own.
      if (fixed !== undefined ? system !== fixed : system === "jira" || system === "github") context.addIssue({ code: "custom", path: ["binding", "system"], message: "a ticket must be from the tracker its source names" });
    }
    if (request.assignedBy !== undefined && request.source !== "linear") context.addIssue({ code: "custom", path: ["assignedBy"], message: "only a Linear intent has an assigner" });
    if (request.retryOf !== undefined && request.source !== "app") context.addIssue({ code: "custom", path: ["retryOf"], message: "only an app intent can follow an answered task" });
    if (request.offerId !== undefined && request.source !== "offer") context.addIssue({ code: "custom", path: ["offerId"], message: "only an offer has an offer id" });
  });
export type CodeIntentRequest = z.infer<typeof CodeIntentRequestSchema>;

/** `POST /v1/app/projects/{project}/code`: the person's request, and nothing that names a source, a payer or a binding. */
export const CodeIntentBodySchema = z.object({ requestId: RequestIdSchema, input: RunInputSchema, path: WorkflowPathSchema.optional() }).strict();
export type CodeIntentBody = z.infer<typeof CodeIntentBodySchema>;

/** What starting work answers. A deployment where agents are not set up has no sessions, so it answers the task alone (only the broker's own Slack start can then be here). */
export interface CodeIntentResult<Task = unknown> { task: Task; sessionId?: string; sessionUrl?: string }

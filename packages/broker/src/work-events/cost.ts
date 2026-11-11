// Work events (U3): the `cost_settled` event of one spend settlement. It rides in the settlement's own transaction (`spend/ledger.ts`), which is conditional on the amount already counted, so a spend counted once
// makes one event, a raced or replayed settle makes none, and the event's id is the ledger line's own (`<key>.<sequence>`).
import { WorkEventSchema, workEventId, type OrgId, type WorkEventInput } from "@agentx/contracts";

const CODE = /^[a-z][a-z0-9_.-]{0,59}$/u;

/**
 * The event for what one settlement added to a task's cost, or undefined when the spend belongs to no task and project (a Slack turn's key) or the amount is nothing. Money is whole micro-dollars
 * (`micros`); `source` is the key's source word when it is a short code, else `other`.
 */
export function costSettledEvent(input: { orgId: OrgId; project: string | undefined; taskId: string | undefined; keyId: string; sequence: number; at: string; deltaUsd: number; source: string | undefined }): WorkEventInput | undefined {
  if (input.project === undefined || input.taskId === undefined || !(input.deltaUsd > 0)) return undefined;
  const event = {
    version: 1, id: workEventId({ kind: "cost_settled", taskId: input.taskId, source: `${input.keyId}.${String(input.sequence)}` }), kind: "cost_settled", at: new Date(input.at).toISOString(),
    orgId: input.orgId, project: input.project, taskId: input.taskId, actor: { kind: "system" },
    micros: Math.round(input.deltaUsd * 1_000_000), currency: "USD", source: typeof input.source === "string" && CODE.test(input.source) ? input.source : "other",
  } as const;
  return WorkEventSchema.safeParse(event).success ? event : undefined;
}

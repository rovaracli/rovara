import { AuditEventInputSchema, type AuditAction, type AuditEventInput } from "@agentx/cloud-contracts";
import { expect } from "vitest";

export function transactionAuditEvent(items: readonly Record<string, unknown>[] | undefined, action: AuditAction): AuditEventInput | undefined {
 return (items ?? []).flatMap(item => {
  const event: unknown = (item.Put as { Item?: { event?: unknown } } | undefined)?.Item?.event;
  return event === undefined ? [] : [AuditEventInputSchema.parse(event)];
 }).find(event => event.action === action);
}
/** Project creation intentionally audits inheritance. Assert that independent
 * fixture event before comparing the later action's audit/rollback evidence. */
export function afterProjectBootstrap(events: AuditEventInput[]): AuditEventInput[] {
 const seeds = events.filter(event => event.action === "spending.policy_seeded" && event.target.kind === "project" && "name" in event.target && event.target.name === "payments");
 if (seeds.length > 0) {
  expect(seeds).toHaveLength(1);
  expect(seeds[0]).toMatchObject({ actor: { kind: "system", id: "rovara" }, facts: { mode: "inherit", source: "bootstrap", revision: 1, outcome: "created" } });
 }
 return events.filter(event => !seeds.includes(event));
}

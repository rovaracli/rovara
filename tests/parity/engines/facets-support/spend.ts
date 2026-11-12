// The spend facet, Cloud side: what Cloud's path did with money, read from its own rows as they are written, in the core engine's words
// (`admitted:<action>` / `refused:<action>:<code>` come from the core's Admission; here the money rows Cloud's path writes).
//
// Cloud's `admitWork` (spend/admission.ts) WRITES NOTHING when it admits (it reads the levels and throws a refusal), so an admission is invisible in the
// table; only what follows is: a model key's reservation, its ledger entry, a held or paused start. The journey harness also wires no model access, so
// Cloud's start skips `admitWork` altogether (aws/developer-tasks/start.ts `if (deps.modelAccess !== undefined)`) and mints no model key. Both are
// recorded as known differences (known-differences/facets.ts), not hidden here.

/** Cloud's money rows, by entity type, and the word each write is. */
export const CLOUD_SPEND_ROWS: Readonly<Record<string, { insert: string; remove?: string }>> = {
  OPEN_MODEL_KEY: { insert: "held:model.call", remove: "released:model.call" },
  LEDGER: { insert: "settled:model.call" },
  SPEND_HELD_START: { insert: "held:task.start" },
  SPEND_HELD_PLAN_START: { insert: "held:task.start" },
  PAUSED_TASK: { insert: "paused:task" },
  MONTH_PAUSED_TASK: { insert: "paused:task" },
};

export function spendWordOf(change: { before?: Record<string, unknown>; after?: Record<string, unknown> }): string | undefined {
  const item = change.after ?? change.before;
  const rule = typeof item?.entityType === "string" ? CLOUD_SPEND_ROWS[item.entityType] : undefined;
  if (rule === undefined) return undefined;
  if (change.before === undefined && change.after !== undefined) return rule.insert;
  if (change.after === undefined) return rule.remove;
  return undefined;
}

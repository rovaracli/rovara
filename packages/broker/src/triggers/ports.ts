// What the trigger code asks of the code that is not built yet (Plan 4 Tasks 19 and 26), and what the rest of the broker asks of the trigger code. Each is an interface with
// a seam in the route dependencies: until the other task lands there is nothing behind it, and the trigger code says so (a schedule is stored as `pending`; a hook that can't
// be read is a problem a trigger reports) rather than guessing.
import type { OrgId, TriggerTarget } from "@rovara-code/contracts";
import type { ChainProblem } from "../chains/validate.js";

/** What the approvers of an autonomous run's write ask of the trigger store: who created a trigger, now. */
export interface TriggerLookup {
  get(orgId: OrgId, triggerId: string): Promise<{ createdBy: string } | undefined>;
}

/** A hook (Task 19): the endpoint a vendor posts events to. Only what a trigger's checks need of it. */
export interface TriggerHook {
  orgId: OrgId;
  hookId: string;
  project: string;
  source: string;
  disabled: boolean;
}

export interface TriggerHookReader {
  get(orgId: OrgId, hookId: string): Promise<TriggerHook | undefined>;
}

/** What names a trigger's schedule at the scheduler (Task 26). */
export interface ScheduledTrigger {
  orgId: OrgId;
  triggerId: string;
  spec: unknown;
}

/** What the scheduler holds for a trigger's schedule: its state, and the org and trigger its own input names (absent when the input is not ours to read). */
export interface ScheduleDescription {
  state: "ENABLED" | "DISABLED";
  orgId?: string;
  triggerId?: string;
}

/** The scheduler (Task 26's `putSchedule` and its state changes). A schedule exists only while its trigger is on; each call is repeatable. */
export interface TriggerScheduler {
  /** Creates or replaces the schedule of the trigger, running. */
  put(trigger: ScheduledTrigger): Promise<void>;
  /** Sets the trigger's schedule `DISABLED` (it stays, so turning the trigger on again needs no new one). */
  disable(trigger: Pick<ScheduledTrigger, "orgId" | "triggerId">): Promise<void>;
  /** Deletes the trigger's schedule (the trigger was deleted). */
  remove(trigger: Pick<ScheduledTrigger, "orgId" | "triggerId">): Promise<void>;
  /** What the scheduler holds under the trigger's id, or undefined when it holds nothing. */
  describe(triggerId: string): Promise<ScheduleDescription | undefined>;
}

/** The triggers the target's change turned off, as every route that changes a target answers them. */
export interface DisabledTrigger {
  triggerId: string;
  problems: ChainProblem[];
}

/**
 * What the agent and chain routes ask of the trigger code (one line each in their routes): whether a target has a trigger that is on (publishing and rolling back then
 * need `manage`), re-checking the target's triggers after a change, and turning them all off when the target is archived. `recheck` answers what it turned off.
 */
export interface TriggerHooks {
  hasEnabledTriggers(orgId: OrgId, target: TriggerTarget): Promise<boolean>;
  recheckTriggersForTarget(orgId: OrgId, target: TriggerTarget): Promise<DisabledTrigger[]>;
  disableTriggersForTarget(orgId: OrgId, target: TriggerTarget): Promise<void>;
  /** Re-checks the triggers of every built-in agent: the company turned a built-in off or on. */
  recheckBuiltinTriggers(orgId: OrgId): Promise<DisabledTrigger[]>;
}

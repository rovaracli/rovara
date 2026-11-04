// Live buttons: which of "Ask about this task" (switch `ak`) and "Fix with agent" (switch `fd`) the session view offers this reader, as `you.live`.
// A key is set only when its switch is on AND the very gate the feature's route uses lets this reader use it on this session. Nothing is offered on a guess; the routes still check again.
// With both off (the default) this reads nothing from the table and returns undefined, so the view is byte-identical to one without the field.
import { BROKER_SETTINGS, liveInteractionFlagOn, type ErrorRef, type SessionView } from "@agentx/contracts";
import { diagnosisSubjectFor } from "../diagnosis/authority.js";
import { DIAGNOSABLE_KINDS } from "../diagnosis/light.js";
import { diagnosisEnabled } from "../diagnosis/switch.js";
import { requireLevelOf, type SessionAccess, type SessionAccessDependencies, type SessionCaller } from "./access.js";

type Live = NonNullable<SessionView["you"]["live"]>;

/** Whether the `ak` switch is on in this environment (exactly "1"). */
export const askEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.liveAsk.variable]);

/**
 * `access` is the reader's access to the session already worked out for the view. Ask uses `submitAsk`'s own check (`requireLevelOf(…, "use")`, on a task session). Fix with agent uses the diagnosis
 * routes' own check (`diagnosisSubjectFor`) for the very error the view shows, so it is offered only when the session shows one.
 */
export async function sessionLiveFlags(
  deps: SessionAccessDependencies,
  caller: SessionCaller, access: SessionAccess, shown: { errorRef?: ErrorRef | undefined; closed?: boolean | undefined }, env: NodeJS.ProcessEnv = process.env,
): Promise<Live | undefined> {
  const askOn = askEnabled(env), fixOn = diagnosisEnabled(env);
  if (!askOn && !fixOn) return undefined;
  const isTask = access.session.subject.kind === "task";
  let ask = false, fix = false;
  // A closed task answers every Ask with the closed-task sentence (`submitAsk`), so it is not offered one.
  if (askOn && isTask && shown.closed !== true) {
    try { requireLevelOf(access, "use", "ask about it"); ask = true; } catch { ask = false; }
  }
  // Only the error kinds the diagnosis route accepts (`DIAGNOSABLE_KINDS`, the route's own list).
  const { errorRef } = shown;
  if (fixOn && isTask && errorRef !== undefined && DIAGNOSABLE_KINDS.has(errorRef.kind)) {
    fix = await diagnosisSubjectFor({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps }, caller, errorRef) !== undefined;
  }
  return ask || fix ? { ...(ask ? { ask: true as const } : {}), ...(fix ? { fix: true as const } : {}) } : undefined;
}

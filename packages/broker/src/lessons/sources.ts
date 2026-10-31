// Learning v2 L2: per-source spike detection (owner decision "Lesson limits", control C10/C14). There are no flat caps: every candidate is collected. Each
// candidate is counted against the sources it came from (a member, a Slack channel, CI), and a source whose daily count reaches ten times its own learned
// baseline (and at least ten that day) is paused alone. Its candidates are still collected, but held out of auto-apply and out of the people's queue until a
// maintainer resumes the source. Other sources, and other people, carry on. Because the unit is the source and not the author, a flood from text that has no
// author (CI output, a ticket feed) is caught too.
import { SPIKE, emitAudit } from "./policy.js";
import type { AlertSink, LessonDeps } from "./ports.js";
import type { LessonStore, ProjectFlags, ScopeKey } from "./store.js";

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/** Counts one candidate against each of its sources, and pauses any source that spiked. Returns the sources paused by this call. */
export async function noteCandidateSources(deps: LessonDeps, store: LessonStore, key: ScopeKey, sources: readonly string[], alerts?: AlertSink): Promise<string[]> {
  const paused: string[] = [];
  const now = deps.now();
  await noteProjectVolume(deps, store, key, alerts);
  for (const source of new Set(sources)) {
    await store.recordSourceEvent(key, { at: now, source });
    const days = await store.sourceDays(key, source, SPIKE.baselineDays + 1, now);
    const today = days[0] ?? 0;
    const baseline = Math.max(mean(days.slice(1)), SPIKE.baselineFloor);
    if (today < Math.max(SPIKE.multiple * baseline, SPIKE.minimum)) continue;
    const flags = await store.flags(key);
    if (flags.pausedSources?.[source] !== undefined) continue;
    await store.setFlags(key, { ...flags, pausedSources: { ...(flags.pausedSources ?? {}), [source]: { at: now, reason: "spike" } } });
    paused.push(source);
    await emitAudit(deps.audit, { action: "lesson.source_paused", workspaceId: key.workspaceId, project: key.project, facts: { source, today, baseline: Math.round(baseline * 10) / 10 } });
    try { await alerts?.alert(key.workspaceId, key.project, "source_spike_paused"); } catch { /* the pause already holds */ }
  }
  return paused;
}

/** The key under which the whole project's candidate volume is counted. */
export const PROJECT_VOLUME_KEY = "*project*";
const DAY = 86_400_000;

/**
 * A project-wide signal: when the day's total candidates reach ten times the project's own baseline (and at least 30), the maintainer is alerted, once a day.
 * Nothing is paused: only a source that spikes on its own is paused (owner decision). This catches a flood spread thinly across many sources.
 */
async function noteProjectVolume(deps: LessonDeps, store: LessonStore, key: ScopeKey, alerts?: AlertSink): Promise<void> {
  const now = deps.now();
  await store.recordSourceEvent(key, { at: now, source: PROJECT_VOLUME_KEY });
  const days = await store.sourceDays(key, PROJECT_VOLUME_KEY, SPIKE.baselineDays + 1, now);
  const today = days[0] ?? 0;
  const baseline = Math.max(mean(days.slice(1)), SPIKE.baselineFloor);
  if (today < Math.max(SPIKE.multiple * baseline, SPIKE.projectMinimum)) return;
  const flags = await store.flags(key);
  if (flags.volumeAlertedAt !== undefined && now - flags.volumeAlertedAt < DAY) return;
  await store.setFlags(key, { ...flags, volumeAlertedAt: now });
  await emitAudit(deps.audit, { action: "lesson.volume_spike", workspaceId: key.workspaceId, project: key.project, facts: { today, baseline: Math.round(baseline * 10) / 10 } });
  try { await alerts?.alert(key.workspaceId, key.project, "project_volume_spike"); } catch { /* the audit record holds */ }
}

/** True when any of a lesson's sources is paused: the lesson is held. */
export const isHeldBySource = (flags: ProjectFlags, sources: readonly string[]): boolean => sources.some((s) => flags.pausedSources?.[s] !== undefined);

/** A maintainer resumes one paused source. */
export async function resumeSource(deps: LessonDeps, store: LessonStore, key: ScopeKey, source: string, actor: string): Promise<boolean> {
  const flags = await store.flags(key);
  if (flags.pausedSources?.[source] === undefined) return false;
  const rest = { ...flags.pausedSources };
  delete rest[source];
  await store.setFlags(key, { ...flags, pausedSources: rest });
  await emitAudit(deps.audit, { action: "lesson.source_resumed", workspaceId: key.workspaceId, project: key.project, actor, facts: { source } });
  return true;
}

// v1.2 learning loop, B5 (RED stub): the METRIC counters (design 4.3 and 6.4).
import type { LearningDeps, LearningScope } from "./store.js";

export interface MetricCounters {
  memberCorrections: number; repeats: number; repeatsOfAcceptedRules: number; suggestions: number; accepted: number; dismissed: number;
  prMemberCorrections: number; prRepeats: number; prRepeatsOfAcceptedRules: number;
}
export interface MetricView {
  month: string; memberCorrections: number; repeats: number; repeatsOfAcceptedRules: number; suggestions: number; accepted: number; dismissed: number; enoughData: boolean; share: number | null;
}
const todo = (): never => { throw new Error("not implemented"); };
export const metricMonth = (_createdAt: string): string => todo();
export const metricSk = (_month: string): string => todo();
export const metricUpdateItem = (_deps: LearningDeps, _scope: LearningScope, _month: string, _deltas: Partial<MetricCounters>): never => todo();
export async function ensureMetricCurrent(_deps: LearningDeps, _scope: LearningScope, _month: string): Promise<void> { todo(); }
export async function readMetric(_deps: LearningDeps, _scope: LearningScope, _month: string, _options: { prCaptureOff: boolean }): Promise<MetricView> { return todo(); }

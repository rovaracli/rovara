// v1.2 learning loop, B5 (RED stub): grouping, dismissed sets and forget (design 4).
import type { LearningSuggestion } from "@agentx/contracts";
import type { LearningDeps, LearningScope } from "./store.js";

export interface GroupingOptions { prCaptureOff?: (deps: LearningDeps, scope: LearningScope) => Promise<boolean>; newId?: () => string }
export interface GroupingResult { judged: number; opened: string[]; joined: string[]; withdrawn: string[]; capped: boolean }
export type ForgetResult = { ok: true } | { ok: false; reason: "missing" | "in_accepted_rule" };
const todo = (): never => { throw new Error("not implemented"); };
export async function prCaptureOff(_deps: LearningDeps, _scope: LearningScope): Promise<boolean> { return todo(); }
export async function groupCorrections(_deps: LearningDeps, _scope: LearningScope, _options: GroupingOptions = {}): Promise<GroupingResult> { return todo(); }
export async function withdrawPrDependentSuggestions(_deps: LearningDeps, _scope: LearningScope): Promise<string[]> { return todo(); }
export async function forgetCorrection(_deps: LearningDeps, _scope: LearningScope, _input: { correctionSk: string; sourceKey?: string }): Promise<ForgetResult> { return todo(); }
export const dismissedSetKey = (_correctionIds: readonly string[]): string => todo();
export async function recordDismissal(_deps: LearningDeps, _scope: LearningScope, _suggestion: Pick<LearningSuggestion, "id" | "correctionIds" | "signature">): Promise<void> { todo(); }

// STUB for the RED run (B2): the real implementation follows in the next commit.
export const CORRECTION_TEXT_MAX = 1000;
export const CORRECTION_MIN_CHARS = 20;
export const PROPOSED_TEXT_MAX = 400;
export type PreparedCorrection = { ok: true; text: string } | { ok: false; reason: "empty" | "too_short" | "generic" };
export const stripCode = (text: string): string => text;
export const cleanCorrectionText = (raw: string): string => raw;
export const isGenericCorrection = (_cleaned: string): boolean => false;
export const prepareCorrection = (raw: string): PreparedCorrection => ({ ok: true, text: raw });
export const proposedRuleText = (text: string): string => text;

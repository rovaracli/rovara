// Design review in "How we work" (DR11): the stage card's rows and the settings editor's rules. Pure: no React, no network.
// The setting shown is the one the project RUNS with (the playbook answer holds it to the company lock); a locked field is read-only and says why. The editor sends the whole setting through the
// existing playbook PUT (`designReview`), and the broker holds it to the lock and the edition again.
import {
  DESIGN_REVIEW_APPROVERS_MAX, DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_CAP_MIN_USD, DESIGN_REVIEW_DEFAULT_SETTING, DESIGN_REVIEW_MODES, DESIGN_REVIEW_TIERS,
  type DesignReviewApprover, type DesignReviewSetting, type DesignReviewTier,
} from "@agentx/contracts/web";
import type { Mark, Row } from "./how-we-work-rows.js";

export type SettingField = "mode" | "tier" | "allowSkip" | "capUsdPerTask" | "highRiskApprover";
const LOCK_NAME: Readonly<Record<SettingField, string>> = {
  mode: "designReview.mode", tier: "designReview.tier", allowSkip: "designReview.allowSkip", capUsdPerTask: "designReview.capUsdPerTask", highRiskApprover: "designReview.highRiskApprover",
};
export const LOCK_REASON = "Your company has locked this setting. A company admin can change it.";
export const MODE_WORDS: Readonly<Record<DesignReviewSetting["mode"], string>> = {
  auto: "Auto: Rovara decides from the request", always: "Always: every code change gets a design review", never: "Never: only when someone asks for design first",
};
export const TIER_LABELS: Readonly<Record<DesignReviewTier, string>> = {
  light: "Light: one reviewer", standard: "Standard: three reviewers and a merge step", thorough: "Thorough: up to five reviewers and a merge step",
};
export const MODE_OPTIONS = DESIGN_REVIEW_MODES.map(value => ({ value, label: MODE_WORDS[value] }));
export const TIER_OPTIONS = DESIGN_REVIEW_TIERS.map(value => ({ value, label: TIER_LABELS[value] }));

/** The fields the company holds fixed, from the playbook answer's `designReviewLocked` (names only). */
export function lockedSet(locked: readonly string[] | undefined): ReadonlySet<SettingField> {
  const found = new Set<SettingField>();
  for (const field of Object.keys(LOCK_NAME) as SettingField[]) if (locked?.includes(LOCK_NAME[field]) === true) found.add(field);
  return found;
}

export type ApproverKind = DesignReviewApprover["kind"];
export const APPROVER_WORDS: Readonly<Record<ApproverKind, string>> = { maintainers: "Project maintainers", people: "Named people", group: "A group" };
/** The kinds the editor offers. A group is for Enterprise only: in the public edition it is not offered at all (the broker refuses it there too). */
export function approverKinds(groupsAvailable: boolean): ApproverKind[] {
  return groupsAvailable ? ["maintainers", "people", "group"] : ["maintainers", "people"];
}

export function approverWords(approver: DesignReviewApprover, nameOf: (id: string) => string | undefined = () => undefined): string {
  switch (approver.kind) {
    case "maintainers": return "project maintainers";
    case "people": return approver.memberIds.map(id => nameOf(id) ?? "a named person").join(", ");
    case "group": return "a group";
  }
}

export interface SettingDraft { mode: DesignReviewSetting["mode"]; tier: DesignReviewTier; allowSkip: boolean; capText: string; approverKind: ApproverKind; memberIds: string[]; groupId: string }
export function draftOf(setting: DesignReviewSetting): SettingDraft {
  const approver = setting.highRiskApprover;
  return {
    mode: setting.mode, tier: setting.tier, allowSkip: setting.allowSkip, capText: String(setting.capUsdPerTask), approverKind: approver.kind,
    memberIds: approver.kind === "people" ? [...approver.memberIds] : [], groupId: approver.kind === "group" ? approver.groupId : "",
  };
}

export type SettingProblems = Partial<Record<"cap" | "people" | "group", string>>;
/** The setting a draft means, or what is wrong with it in plain words. Locked fields keep the value the page was given. */
export function settingOf(draft: SettingDraft, groupsAvailable: boolean): { ok: true; setting: DesignReviewSetting } | { ok: false; problems: SettingProblems } {
  const problems: SettingProblems = {}, cap = Number(draft.capText.trim());
  if (draft.capText.trim() === "" || !Number.isFinite(cap) || cap < DESIGN_REVIEW_CAP_MIN_USD || cap > DESIGN_REVIEW_CAP_MAX_USD) problems.cap = `Use an amount between $${DESIGN_REVIEW_CAP_MIN_USD.toFixed(2)} and $${DESIGN_REVIEW_CAP_MAX_USD.toFixed(2)}.`;
  let approver: DesignReviewApprover = { kind: "maintainers" };
  if (draft.approverKind === "people") {
    if (draft.memberIds.length === 0) problems.people = "Choose at least one person.";
    else if (draft.memberIds.length > DESIGN_REVIEW_APPROVERS_MAX) problems.people = `Choose at most ${String(DESIGN_REVIEW_APPROVERS_MAX)} people.`;
    else approver = { kind: "people", memberIds: [...draft.memberIds] };
  } else if (draft.approverKind === "group") {
    if (!groupsAvailable) problems.group = "Groups are not available in this edition.";
    else if (draft.groupId.trim() === "") problems.group = "Say which group.";
    else approver = { kind: "group", groupId: draft.groupId.trim() };
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return { ok: true, setting: { mode: draft.mode, tier: draft.tier, allowSkip: draft.allowSkip, capUsdPerTask: cap, highRiskApprover: approver } };
}

export const sameSetting = (a: DesignReviewSetting, b: DesignReviewSetting): boolean => JSON.stringify(a) === JSON.stringify(b);

const markOf = (field: SettingField, setting: DesignReviewSetting, locked: ReadonlySet<SettingField>): Mark => {
  if (locked.has(field)) return { source: "company", locked: true, lockedBy: "company" };
  return { source: JSON.stringify(setting[field]) === JSON.stringify(DESIGN_REVIEW_DEFAULT_SETTING[field]) ? "rovara" : "project", locked: false };
};
const FIXED: Mark = { source: "rovara", locked: true, lockedBy: "rovara" };

/**
 * The stage card's six rows (design-review-stage.md 1.2), each value marked with where it comes from. The settings that vary (the tier, the approver) are in the rows they belong to; Mode, skipping and
 * the cost limit are in a seventh "Settings" list the card shows beside them (`settingLines`).
 */
export function designRows(setting: DesignReviewSetting, locked: ReadonlySet<SettingField>, nameOf?: (id: string) => string | undefined): Row[] {
  const who = setting.tier === "light" ? "One reviewer, merged without a model. The planner resolves the findings." : setting.tier === "standard" ? "Three reviewers plus a merge step. The planner resolves the findings." : "Up to five reviewers plus a merge step. The planner resolves the findings.";
  return [
    { id: "who", title: "Who does it", values: [{ text: who, mark: markOf("tier", setting, locked) }] },
    { id: "knows", title: "What it knows", values: [{ text: "Only the design, the approved requirements and the sources the design links: code at a pinned commit, specs and runbooks in the meta repo, and connected items. Never the conversation.", mark: FIXED, block: true }] },
    { id: "may", title: "What it may do", values: [{ text: "Read only. No edits, no shell, no network, no writes to connected sources.", mark: FIXED }] },
    { id: "checked", title: "How it's checked", values: [{ text: "Every finding must cite something. The merge step can't add findings. Rovara's code sets the tier and the approver, never a model's words.", mark: FIXED, block: true }] },
    { id: "evidence", title: "Evidence", values: [{ text: "Which reviewers ran and what each was given, the findings, how each was answered, and the approved design.", mark: FIXED }] },
    { id: "approves", title: "Who approves", values: [{ text: `The person who asked. When the design touches the data model, sign-in, money, personal data or other services: ${approverWords(setting.highRiskApprover, nameOf)}.`, mark: markOf("highRiskApprover", setting, locked) }] },
  ];
}

export interface SettingLine { field: SettingField; label: string; text: string; mark: Mark }
/** Mode, skipping and the cost limit, in words, each with its mark. */
export function settingLines(setting: DesignReviewSetting, locked: ReadonlySet<SettingField>): SettingLine[] {
  return [
    { field: "mode", label: "When it runs", text: MODE_WORDS[setting.mode], mark: markOf("mode", setting, locked) },
    { field: "allowSkip", label: "Skipping", text: setting.allowSkip ? "Allowed. On a high-risk design only the design approver may skip." : "Not allowed.", mark: markOf("allowSkip", setting, locked) },
    { field: "capUsdPerTask", label: "Cost limit per task", text: `$${setting.capUsdPerTask.toFixed(2)}. Above it, a person decides.`, mark: markOf("capUsdPerTask", setting, locked) },
  ];
}

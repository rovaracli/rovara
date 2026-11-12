// The Working agreement panel: every fixed word it shows. The panel writes no reason of its own: where a value comes from is what the broker's answer says.
// "locked": the server says it is locked but not who locked it. "unknown": a source word this version does not know (no claim is made). "none": the read gives a value only, so no origin is shown.
export type Origin = "company-lock" | "company-default" | "project-choice" | "task-choice" | "rovara-default" | "rovara-fixed" | "locked" | "unknown" | "none";
export const ORIGIN_LABEL: Readonly<Record<Origin, string>> = {
 "company-lock": "Company lock",
 "company-default": "Company default",
 "project-choice": "Project choice",
 "task-choice": "Task choice",
 "rovara-default": "Rovara default",
 "rovara-fixed": "Built into Rovara",
 locked: "Locked",
 unknown: "Origin unknown",
 none: "",
};
export const T = {
 TITLE: "Working agreement",
 INTRO: "Every rule that applies here, where it comes from, and whether it is locked. This page only shows the rules: they are changed in How we work below, or in Company settings by an admin.",
 TASK_TITLE: "Working agreement",
 TASK_INTRO: "The rules that apply to this project now. The rules this task started with are not recorded yet, so a rule changed since the task began may differ.",
 LOADING: "Loading the working agreement",
 SECTION_PROJECT: "Rules for the whole project",
 SECTION_MODELS: "AI models by step",
 SECTION_STEPS: "Step by step",
 SECTION_TASK: "This task",
 SECTION_MISSING: "Not shown yet",
 MISSING: "Not available yet",
 FAILED: "Couldn't load this right now.",
 PENDING: "Waiting for a second admin",
 PENDING_OWNER: "Waiting for the owner to approve",
 WHY_LABEL: (title: string) => "Why is " + title + " locked?",
 WHY: "Why?",
 RETRY: "Try again",
 VERSION: (version: number) => "Version " + String(version),
 WHY_COMPANY: "Your company set this, and a project can't change it.",
 WHY_COMPANY_ADMIN: "To change it, open",
 WHY_COMPANY_ASK: "To ask for a change, ask a company admin.",
 WHY_UNKNOWN: "This is locked. Who locked it isn't known.",
 WHY_ROVARA: "Rovara keeps this fixed for safety. No company or project can change it.",
 LINK_HOW: "How we work in Company settings",
 LINK_RULES: "Company rules in Company settings",
 COMPANY_SETTINGS_HOW: "/app/admin/how-we-work",
 COMPANY_SETTINGS_RULES: "/app/admin/company-rules",
 NO_STEP_ROWS: "Nothing else is set for this step.",
} as const;
/** Sources the page cannot read yet because the broker has no read for them. Each is listed as "Not available yet" (and as "needs broker" in the lane report). */
export const NEEDS_BROKER = {
 approvals: "Approval settings: the recent sign-in window, chat merge and comment approvals",
 taskSnapshot: "The rules this task started with",
} as const;
export type MissingKey = keyof typeof NEEDS_BROKER;
export const SOURCE_NAMES = {
 merge: "Merge rules: who reviews, the self-approval exception and the merge method",
 layers: "Project and company How we work rules",
 "design-review": "Design review",
 models: "AI models by step",
 lessons: "Lessons settings",
 learning: "Learning from review comments",
 "known-failing": "Known failing tests",
 "company-rules": "Company rules",
} as const;
export type SourceId = keyof typeof SOURCE_NAMES;

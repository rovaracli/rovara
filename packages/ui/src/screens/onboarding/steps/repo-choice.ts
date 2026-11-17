/** Guided onboarding PR 10 (design section 2): the choices the repository picker makes for the person, kept apart from the screen so they are tested on their own. */
/** Above this many ticked repositories, "separate projects" is preselected: one setup run has to make every repo build, so one broken repo blocks the project. */
export const SEPARATE_ABOVE = 8;
/** The most repositories one create names (Code's cap on a project's repositories). */
export const PICK_MAX = 32;
export type Together = "one" | "separate";
/** What the question shows when the person hasn't answered it: one project, or separate ones above SEPARATE_ABOVE repositories. */
export const preselected = (count: number): Together => (count > SEPARATE_ABOVE ? "separate" : "one");
export const answeredTogether = (answer: Together | undefined, count: number): Together => answer ?? preselected(count);
/** Where a project's checklist is: the onboarding flow's Setup step today. The project checklist (guided onboarding PR 9) changes this one function. */
export const checklistHref = (project: string): string => `/app/onboard?${new URLSearchParams({ project, step: "setup" }).toString()}`;
/** The fixed words for why one repository of a separate-projects create made no project (Code's four reasons). */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  not_available: "This repository isn't available through your company's GitHub connection.",
  name_taken: "A project with this name already exists.",
  unavailable: "GitHub couldn't be reached for this one just now.",
  not_started: "This one wasn't started because the request ran out of time.",
});
export const refusalWords = (reason: string): string => REFUSAL_WORDS[reason] ?? "This one couldn't be created.";
/** Reasons a second try can fix. */
export const retryable = (reason: string): boolean => reason === "unavailable" || reason === "not_started";

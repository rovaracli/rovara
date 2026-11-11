// UX-4b: the four learning modes in the person's words, shared by the mode control and the project setup checklist.
import type { LearningMode } from "@agentx/cloud-contracts/web";

/** The four modes, loosest last, with what each does in a sentence. */
export const MODE_ORDER: readonly LearningMode[] = ["off", "collect", "suggest", "on"];
export const MODE_WORDS: { readonly [mode in LearningMode]: { label: string; means: string } } = {
 off: { label: "Off", means: "Nothing is captured from the sources and no lesson is used." },
 collect: { label: "Collect", means: "Rovara records what the team does and suggests nothing yet." },
 suggest: { label: "Suggest", means: "Rovara suggests lessons; each one waits for a maintainer." },
 on: { label: "On", means: "Lessons that need no approval go live by themselves; the rest wait for a maintainer." },
};

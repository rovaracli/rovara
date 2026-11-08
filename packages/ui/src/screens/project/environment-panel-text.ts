// The fixed words of the project's Environment panel (SH26). Every sentence is from this file; the server sends words, counts and times, never text to show.
// A newer server may send a word this page does not know (the reader maps it to "unknown"): it gets a plain, true sentence.

export const ENV = {
 HEADING: "Saved environment",
 HELP: "Rovara saves this project's proven setup so a new task starts from it instead of installing everything again. If the saved copy has a problem, the task sets up fresh and nothing is blocked.",
 LOADING: "Loading the saved environment", LOAD_FAILED: "Couldn't load the saved environment. Try again.", TRY_AGAIN: "Try again",
 RESET: "Reset", RESET_HELP: "Throw away the saved copy and build a new one from the current code.",
 RESET_QUEUED: "A new saved environment is being built.", RESET_NOTHING: "Nothing to build right now. The project needs an approved test environment and code to build from.",
 RESET_IN_FLIGHT: "A new saved environment is already waiting to be built or being built.", RESET_COOLDOWN: "A reset was asked a few minutes ago. Wait a little before asking again.",
 RESET_FAILED: "Couldn't start the rebuild. Try again.", RESET_REFUSED: "Only a maintainer of this project can reset the saved environment.",
 ONLY_MAINTAINER: "Only a maintainer of this project can reset it.",
 NO_IMAGE: "No saved copy yet.",
 // SV-1l: the project's on/off setting.
 OFF: "Off for this project. Every new task sets up fresh, and no saved copy is built.",
 RESET_OFF: "Turn the saved environment on to build a new saved copy.",
} as const;

/** SV-1l: the words of the on/off setting, the same in the setup checklist and the Saved environment section. */
export const SETTING = {
 LABEL: "Use a saved environment for new tasks",
 AFFECTS: "New tasks in this project only. On: a new task starts from the saved copy of the proven setup, and Rovara keeps that copy up to date. Off: every new task installs everything again, so it starts more slowly, and no new saved copy is built. Nothing is blocked either way: a task that can't use the saved copy sets up fresh.",
 WHO: "A maintainer of this project.",
 WHY_NOT: "You can see this setting but not change it. Ask a maintainer of this project.",
 SAVE: "Save", SAVED_ON: "Saved. New tasks start from the saved copy.", SAVED_OFF: "Saved. New tasks set up fresh.",
 REFUSED: "Only a maintainer of this project can change this setting.",
 STALE: "Someone changed the saved environment meanwhile. It was read again; check it and save again.",
 FAILED: "Couldn't save the setting. Your choice is still here; try again.",
 ON_WORD: "On", OFF_WORD: "Off",
} as const;

const HEALTH: Record<string, string> = {
 never_proved: "Not set up yet. A saved copy is built after the first passing setup check.",
 healthy: "Healthy. New tasks start from the saved copy.",
 needs_repair: "Needs repair. New tasks set up fresh until the next build works.",
};
export const healthText = (health: string): string => HEALTH[health] ?? "The saved environment's state is not known to this version of the app.";

const REASON: Record<string, string> = {
 no_image: "there was no saved copy",
 key_changed: "the setup files changed",
 max_age: "the saved copy was more than a week old",
 stale: "a task could not use the saved copy",
 reset: "a maintainer pressed Reset",
};
export const reasonText = (reason: string): string => REASON[reason] ?? "of a reason this version of the app does not know";

export const imageText = (image: { builtAt: string; ageDays: number; status: string }): string => {
 const age = image.ageDays === 0 ? "today" : image.ageDays === 1 ? "1 day ago" : `${String(image.ageDays)} days ago`;
 return `Saved copy built ${age} (${image.builtAt.slice(0, 10)})${image.status === "stale" ? ". A task could not use it, so a new one is due." : "."}`;
};
export const rebuildText = (rebuild: { state: string; reason: string }): string =>
 `${rebuild.state === "running" ? "Building a new saved copy now" : "A new saved copy is waiting to be built"} because ${reasonText(rebuild.reason)}.`;
export const lastReasonText = (reason: string): string => `The last rebuild was started because ${reasonText(reason)}.`;
export const failureText = (failure: { at: string; reason: string }): string => `The last build failed on ${failure.at.slice(0, 10)} (${failure.reason.replace(/_/gu, " ")}).`;

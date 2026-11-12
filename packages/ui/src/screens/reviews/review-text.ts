// The words of the review screens (lane exp/review-groups), in one place so the project section, the task card and the tests say the same thing.
import { REVIEW_GROUPS_MAX, REVIEW_GROUP_MEMBERS_MAX, REVIEW_GROUP_NAME_MAX } from "@agentx/cloud-contracts/web";

/** What the code host answered when Rovara asked it to list the holder as a requested reviewer. */
const HOST_SYNC_WORD_TABLE: Readonly<Record<string, string>> = { requested: "Asked on GitHub", refused: "GitHub refused", pending: "Waiting to ask GitHub", unavailable: "GitHub unavailable" };
const HOST_SYNC_HINT_TABLE: Readonly<Record<string, string>> = {
 requested: "GitHub lists them as a requested reviewer.",
 refused: "GitHub didn't list them as a reviewer, for example because they have no access or wrote the pull request. The claim still stands.",
 pending: "GitHub hasn't been asked yet.",
 unavailable: "Rovara couldn't reach GitHub, or GitHub has no way to ask.",
};
/** A word this build does not know (a newer server) reads as "GitHub status unknown", never as a success. */
export const hostSyncWords = (sync: string): string => HOST_SYNC_WORD_TABLE[sync] ?? "GitHub status unknown";
export const hostSyncHint = (sync: string): string => HOST_SYNC_HINT_TABLE[sync] ?? "Rovara can't tell whether GitHub was asked.";
export const NO_LONGER_CONTRIBUTOR = "no longer a contributor";
export const GROUPS_LIMITS = `Up to ${String(REVIEW_GROUPS_MAX)} groups, ${String(REVIEW_GROUP_MEMBERS_MAX)} people in each, and names up to ${String(REVIEW_GROUP_NAME_MAX)} characters.`;
export const GROUPS_INTRO = "A review group shares the work of reviewing a project's pull requests. Anyone in a group can claim a review that is waiting.";
export const GROUPS_EMPTY = "This project has no review groups yet.";
export const GROUPS_EMPTY_CAN_MANAGE = "Add a group so people can claim reviews that are waiting.";
export const INELIGIBLE_SAVE_NOTE = "People who are no longer contributors leave their group when you save.";

/** The age badge: the hours the review has waited, in plain words. `ageHours` is absent only when the server could not work it out. */
export function agedWords(ageHours: number | undefined): string {
 if (ageHours === undefined) return "Aged: waiting more than a day";
 return "Aged: waiting " + String(ageHours) + (ageHours === 1 ? " hour" : " hours");
}

// The Review groups editor's draft (lane exp/review-groups): the groups a maintainer is changing before pressing Save. Pure: no React and no requests.
import { REVIEW_GROUPS_MAX, REVIEW_GROUP_MEMBERS_MAX, REVIEW_GROUP_NAME_MAX, type ReviewGroupInput, type ReviewGroupsBody, type ReviewGroupsView } from "@agentx/cloud-contracts/web";

export interface DraftMember { developerId: string; name: string; eligible: boolean }
export interface DraftGroup { key: string; groupId?: string; name: string; members: DraftMember[] }
let counter = 0;
const nextKey = (): string => "draft-" + String(++counter);
export const newDraftGroup = (): DraftGroup => ({ key: nextKey(), name: "", members: [] });
export function draftFromView(view: ReviewGroupsView): DraftGroup[] {
 return view.groups.map(group => ({ key: group.groupId, groupId: group.groupId, name: group.name, members: group.members.map(member => ({ developerId: member.developerId, name: member.name, eligible: member.eligible })) }));
}
const codePoints = (text: string): number => [...text].length;
const folded = (name: string): string => name.trim().toLocaleLowerCase("en-US");
/** Why a group's name can't be saved, or undefined. The server checks the same things and says the same in its own words. */
export function nameProblem(draft: readonly DraftGroup[], index: number): string | undefined {
 const name = draft[index]!.name.trim();
 if (name === "") return "Give the group a name.";
 if (codePoints(name) > REVIEW_GROUP_NAME_MAX) return `Use ${String(REVIEW_GROUP_NAME_MAX)} characters or fewer.`;
 if (/[\p{Cc}\p{Cf}]/u.test(name)) return "This name has a character that can't be shown.";
 if (draft.some((other, at) => at !== index && folded(other.name) === folded(name))) return "Another group has this name.";
 return undefined;
}
export function draftProblems(draft: readonly DraftGroup[]): string[] { return draft.map((_, index) => nameProblem(draft, index)).filter((problem): problem is string => problem !== undefined); }
export const canAddGroup = (draft: readonly DraftGroup[]): boolean => draft.length < REVIEW_GROUPS_MAX;
export const canAddMember = (group: DraftGroup): boolean => group.members.length < REVIEW_GROUP_MEMBERS_MAX;
/**
 * The request body: the whole list as it should be. Someone who is no longer a contributor is left out (the server drops them from their group on any save, and refuses them in a new one).
 */
export function draftBody(draft: readonly DraftGroup[], requestId: string, expectedRevision: number): ReviewGroupsBody {
 const groups: ReviewGroupInput[] = draft.map(group => ({ ...(group.groupId === undefined ? {} : { groupId: group.groupId }), name: group.name.trim(), members: group.members.filter(member => member.eligible).map(member => member.developerId) }));
 return { requestId, expectedRevision, groups };
}
/** Whether the draft differs from what the server holds. */
export function draftChanged(draft: readonly DraftGroup[], view: ReviewGroupsView): boolean {
 return JSON.stringify(draft.map(group => [group.groupId ?? null, group.name.trim(), group.members.map(member => member.developerId)])) !== JSON.stringify(view.groups.map(group => [group.groupId, group.name, group.members.map(member => member.developerId)]));
}
/** The different people named across all groups of the draft (the server allows at most REVIEW_GROUPS_PEOPLE_MAX). */
export const distinctPeople = (draft: readonly DraftGroup[]): Set<string> => new Set(draft.flatMap(group => group.members.map(member => member.developerId)));

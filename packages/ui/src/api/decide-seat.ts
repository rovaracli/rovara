/**
 * Which seat a person decides a coding plan from (approval place, owner decision Q7): the task owner, or a project maintainer (a company owner or admin counts) deciding someone else's plan.
 * The server says it as `decideAs` beside `canDecide` in the task page's access summary. A maintainer may approve, ask for changes or reject (owner decision 99: a rejection is judged like a medium approval), but is never offered a run-limit raise or a run-limit
 * acknowledgement (the server refuses both), and is told the owner will hear about the decision. Absent (an older server) or `"owner"`: nothing changes. A seat word this build does not know is read as the maintainer's, the narrower one.
 */
export interface DecideSeat { as: "owner" | "maintainer"; /** The task owner's name, when the page has it. */ ownerName?: string | undefined }

/** The seat from an access object (`decideAs`, and `ownerName` when the server names the owner); undefined when the server named none. */
export function readDecideSeat(access: unknown): DecideSeat | undefined {
 if (access === null || typeof access !== "object") return undefined;
 const { decideAs, ownerName } = access as { decideAs?: unknown; ownerName?: unknown };
 if (typeof decideAs !== "string" || decideAs === "") return undefined;
 const name = typeof ownerName === "string" && ownerName.trim() !== "" ? ownerName.trim() : undefined;
 return decideAs === "owner" ? { as: "owner" } : { as: "maintainer", ...(name === undefined ? {} : { ownerName: name }) };
}

export const isMaintainerSeat = (seat: DecideSeat | undefined): boolean => seat?.as === "maintainer";

/** The one line a maintainer reads where they decide. */
export function maintainerNote(seat: DecideSeat): string {
 return "You are deciding as a maintainer; " + (seat.ownerName === undefined ? "the task owner" : seat.ownerName) + " will be told.";
}

/** Said in place of a run-limit tick and of Approve, when approving would raise the limit: the server's own sentence for that refusal. */
export const MAINTAINER_RUN_LIMIT_WORDS = "A plan's run limit is the task owner's to decide. Ask the owner to approve this plan.";
/** Said beside a run limit that approving would not raise. */
export const MAINTAINER_LIMIT_KEPT_WORDS = "The task owner decides the run limit.";

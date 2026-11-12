// The developers a sign-in identity answers to by history, for the ban check. One walk, shared by the sign-in (DeveloperSignInStore.formerDevelopersOf) and the Slack requester
// standing (aws/broker/dependency-wiring.ts), so a ban covers an identity the same way on both: a removal with a ban marks the developer the person was, and an identity the person
// unlinked beforehand carries no mark of its own.
import { agentXError } from "@rovara-code/contracts";

/**
 * The most developers one walk follows. Exactly this many distinct developers are allowed; one more refuses (FORBIDDEN, UNTRACEABLE_IDENTITY_MESSAGE). A repeat of a developer already
 * seen is not counted, so a loop ends the walk and never refuses it.
 */
export const FORMER_DEVELOPER_LIMIT = 16;
/** What a sign-in says when the walk is longer than the limit: nobody can say who this person was. */
export const UNTRACEABLE_IDENTITY_MESSAGE = "this sign-in could not be traced to one person; ask an admin";
/** What a sign-in says when the walk could not read the sign-in table: it fails closed, since a removal could not be ruled out. */
export const REMOVAL_CHECK_UNAVAILABLE_MESSAGE = "we could not check whether you were removed from this organization; try again in a moment";

/** One item of the sign-in table by key (`SIGNIN_IDENTITY#<id>` or `DEVELOPER#<id>`, sort key META), or undefined. */
export type SignInItemReader = (key: { pk: string; sk: string }) => Promise<Record<string, unknown> | undefined>;

const META = "META";

/**
 * Every developer the identity was unlinked from (`first`, the link's `unlinkedFrom`), and from each of those: the developer IT was unlinked from, the developer its identity is linked into
 * now (a link that is not its own tombstone), and the developer it was merged into. Nearest first; empty when `first` is undefined. Loops are walked once.
 */
export async function traceFormerDevelopers(first: string | undefined, read: SignInItemReader): Promise<string[]> {
  const seen: string[] = [];
  const queue = first === undefined ? [] : [first];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.includes(next)) continue;
    if (seen.length >= FORMER_DEVELOPER_LIMIT) throw agentXError("FORBIDDEN", UNTRACEABLE_IDENTITY_MESSAGE);
    seen.push(next);
    const [link, developer] = await Promise.all([read({ pk: `SIGNIN_IDENTITY#${next}`, sk: META }), read({ pk: `DEVELOPER#${next}`, sk: META })]);
    const unlinkedFrom = typeof link?.["unlinkedFrom"] === "string" ? link["unlinkedFrom"] : undefined;
    // It was itself separated from another developer, or is linked into one now (a link that is not its tombstone), or was merged into one.
    if (unlinkedFrom !== undefined) queue.push(unlinkedFrom);
    else if (typeof link?.["developerId"] === "string" && link["developerId"] !== next) queue.push(link["developerId"]);
    const merged = developer?.["mergedInto"];
    if (typeof merged === "string" && merged !== "") queue.push(merged);
  }
  return seen;
}

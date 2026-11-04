// What a Slack, Linear or Jira place IS, decided on the server for the source write route (source-row lane, task 7). Pure pieces and one reader over the connected trackers; nothing here writes.
//   Slack: `slack:<team>/<channel>` is parsed, and the channel's live facts (`SlackFacts`, read by the DeveloperIdentity function that holds the bot token) become one of the five `SlackScope` classes.
//   Linear and Jira: a place is accepted only when a connected app of this company lists it (`trackerPlaceCheck`), read live, a page at a time, within a budget. Unknown is never "yes".
import type { OrgId } from "@agentx/contracts";
import type { SlackScope } from "./edition.js";
import type { ConnectedTrackersPort } from "./tracker-directory.js";

/** What Slack says about a channel: its kind, and whether another organisation shares it (Slack Connect). */
export interface SlackFacts { kind: "public" | "private" | "im" | "mpim"; extShared: boolean }

const SCOPE = /^slack:([TE][A-Z0-9]{2,31})\/([CGD][A-Z0-9]{2,31})$/u;
/** `slack:<team>/<channel>` and nothing else (not a whole team, not a longer path). */
export function parseSlackScope(scope: string): { teamId: string; channelId: string } | undefined {
  const match = SCOPE.exec(scope);
  return match === null ? undefined : { teamId: match[1]!, channelId: match[2]! };
}

/** Slack Connect first (a shared channel is never a source, whatever its kind), then the channel's own kind. */
export function classifySlack(facts: SlackFacts): SlackScope {
  if (facts.extShared) return "slack_connect";
  switch (facts.kind) {
    case "public": return "public_channel";
    case "private": return "private_channel";
    case "im": return "dm";
    case "mpim": return "mpim";
  }
}

/** The place of a Linear team, as the webhook tap writes it (the team's id in lower case). */
export const linearScope = (teamId: string): string => `linear:team/${teamId.toLowerCase()}`;
/** The place of a Jira project, as the webhook tap writes it (the project key). */
export const jiraScope = (key: string): string => `jira:project/${key}`;

export type TrackerPlaceCheck = (orgId: OrgId, kind: "linear" | "jira", scope: string) => Promise<"found" | "absent" | undefined>;

/** Most pages and most time one check may spend over a company's apps. */
export const PLACE_PAGES_MAX = 20;
export const PLACE_PAGE_SIZE = 100;
export const PLACE_READ_MS = 8_000;

/**
 * Whether one of the company's connected apps of this kind lists the place. `found` as soon as one does; `absent` only when every app of the kind was read to its end and none lists it (also when the
 * company has no app of that kind); `undefined` when a listing could not be read, was cut short by the page or time budget, or the app cannot list its places: nothing is guessed. A read that throws is
 * `undefined`. The company comes from the caller; the port answers for that company only.
 */
export function trackerPlaceCheck(port: ConnectedTrackersPort, options: { now?: () => number } = {}): TrackerPlaceCheck {
  const now = options.now ?? Date.now;
  return async (orgId, kind, scope) => {
    const started = now();
    let complete = true;
    for (const tracker of await port.list(orgId)) {
      if (tracker.kind !== kind) continue;
      if (tracker.readPlaces === undefined) { complete = false; continue; }
      let after: string | undefined;
      for (let pages = 0; ; pages += 1) {
        if (pages >= PLACE_PAGES_MAX || now() - started >= PLACE_READ_MS) { complete = false; break; }
        let page;
        try { page = await tracker.readPlaces({ ...(after === undefined ? {} : { after }), limit: PLACE_PAGE_SIZE }); } catch { return undefined; }
        if (page.scopes.includes(scope)) return "found";
        if (page.next === undefined) break;
        after = page.next;
      }
    }
    return complete ? "absent" : undefined;
  };
}

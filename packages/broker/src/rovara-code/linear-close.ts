// Rovara Code (Plan 6 Task 20): until Plan 9 closes Linear issues itself, Linear's own GitHub integration closes an issue when a pull request whose title or body says "Fixes <KEY>"
// merges. This says that line for a session bound to a Linear issue, and only that line: the key comes from the session's own Linear binding in the task's org, is checked to be an
// issue key (never free text), and every model-written line is stopped from saying a closing word with a key of its own (`breakLinearCloseWords`), so the pull request names one issue.
import type { OrgId, SessionBinding } from "@agentx/contracts";
import { sessionBindingsOf, type SessionBindingReader } from "./session-bindings.js";

/** A Linear issue key: the team's key (a letter, then letters or digits, ten at most) and the issue's number. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]{0,8}$/u;

/** `text` as an issue key in capitals, or undefined when it is not one (a hostile or malformed value never reaches a description). */
export function normalizeIssueKey(text: string | undefined): string | undefined {
  return text !== undefined && ISSUE_KEY.test(text) ? text.toUpperCase() : undefined;
}

/** The key in an issue's Linear link (`https://linear.app/<workspace>/issue/<KEY>/<slug>`), or undefined for any other host or shape. */
function keyOfLink(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "linear.app") return undefined;
  const parts = url.pathname.split("/").filter((part) => part !== "");
  return parts[1] === "issue" ? normalizeIssueKey(parts[2]) : undefined;
}

/**
 * The key of the Linear issue a binding follows. The issue id is the key where the binder used it; otherwise the key is read from the issue's Linear link. An id and a link that name
 * different issues are no key at all, and a Slack thread has none.
 */
export function linearIssueKeyOf(binding: SessionBinding): string | undefined {
  if (binding.kind !== "linear_issue") return undefined;
  const fromId = normalizeIssueKey(binding.issueId);
  const fromLink = keyOfLink(binding.url);
  if (fromId !== undefined && fromLink !== undefined && fromId !== fromLink) return undefined;
  return fromId ?? fromLink;
}

/** The line Linear's GitHub integration reads. */
export const linearCloseLine = (key: string): string => `Fixes ${key}`;

/**
 * The key of the Linear issue a task's session follows, from the session's binding in the task's own org; undefined without a session, an org or a Linear binding. A binding that
 * cannot be read is logged and read as none: the pull request opens without the line, and the next rewrite of its description adds it.
 */
export async function linearIssueKeyOfTask(
  table: SessionBindingReader & { log?: ((event: string, fields: Record<string, unknown>) => void) | undefined },
  task: { orgId?: OrgId | undefined; sessionId?: string | undefined },
): Promise<string | undefined> {
  if (task.orgId === undefined || task.sessionId === undefined) return undefined;
  try {
    const bindings = await sessionBindingsOf(table, task.orgId, task.sessionId);
    return bindings.map(linearIssueKeyOf).find((key) => key !== undefined);
  } catch (error) {
    (table.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields }))))("linear_close.binding_unreadable", { error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

const CLOSING_WORD = "(?:close[sd]?|closing|fix(?:es|ed)?|fixing|resolve[sd]?|resolving|complete[sd]?|completing)";
const KEY_TEXT = "[A-Za-z][A-Za-z0-9]{0,9}-\\d+";
const CLOSING_KEYS = new RegExp(`\\b(${CLOSING_WORD})([\\s:]*)(${KEY_TEXT}(?:(?:\\s*[,&]\\s*|\\s+and\\s+)${KEY_TEXT})*)`, "giu");

/**
 * A line of model-written or user-written text that cannot close a Linear issue: where a closing word (Linear's "magic words") is followed by an issue key, a joiner (invisible) is put
 * after each key's hyphen, so the text reads the same and Linear's reader finds no key. Other text is returned as it is.
 */
export function breakLinearCloseWords(text: string): string {
  return text.replace(CLOSING_KEYS, (_match, word: string, gap: string, keys: string) => `${word}${gap}${keys.replace(/([A-Za-z0-9])-(?=\d)/gu, "$1-‍")}`);
}

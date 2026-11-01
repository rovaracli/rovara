// P6: the neutral identity of a repository, the part of every key that says "which repository" for a code host event.
//
// Linked-pull-request rows, the head index and the delivery rows all used GitHub's `owner/name` (lower-cased). The key now has a neutral spelling, with the host's kind:
//  - GitHub keeps its old spelling exactly (`owner/name`, lower case), so every row written before this exists under the same key and is read as before (no data migration);
//  - any other kind is `<kind>:<address>`, the address the install registered, normalised (scheme and host in lower case, no query, fragment, trailing slash or `.git`).
// A key is never taken from an event's body: the caller builds it from the address the project registered, or from the neutral event's repository address, and compares.
import type { PluginKind } from "@agentx/contracts";
import { parseGitHubRepository } from "../../github-app.js";

/** The kind GitHub's repositories are filed under. */
const GITHUB = "github";

/** The key part for a repository, or undefined when the address is not one this kind can name. Never throws. */
export function codeHostRepositoryKey(kind: PluginKind, address: string): string | undefined {
  try {
    if (kind === GITHUB) {
      const { owner, name } = parseGitHubRepository(address);
      return `${owner}/${name}`.toLowerCase();
    }
    const url = new URL(address);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return undefined;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    const key = `${kind}:${url.protocol}//${url.host.toLowerCase()}${path}`;
    return /[#\p{Cc}\p{Cf}]/u.test(key) ? undefined : key;
  } catch {
    return undefined;
  }
}

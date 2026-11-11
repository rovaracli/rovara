// Convergence W0-3: the neutral words Rovara Code's code host port uses (items C4 and the mergeable-state list in `plugins/code-host.ts` of the contracts) and the
// words Cloud's GitHub provider, merge tracking and approval rules still keep inside. Pure. Cloud's own rules (`approval.ts`, `merge-tracking.ts`, the feedback autonomy
// check) compare GitHub's words (`User`, `Bot`, `dirty`), and their stored rows hold them, so those rules are not changed: the words are mapped where a host's answer
// crosses the port, in both directions.
import type { HostAccountKind, MergeableState } from "@rovara-code/contracts";

/** A host's own account type word (`User`, `Bot`, anything else) in the port's three: only a `person` can approve. No word is no answer. */
export function accountKindOfHostType(type: string | undefined): HostAccountKind | undefined {
  if (type === undefined) return undefined;
  if (type === "User") return "person";
  if (type === "Bot") return "bot";
  return "other";
}

/** The port's account kind back in the words Cloud's rules compare (`User`, `Bot`; `Organization` stands for every other kind, none of which Cloud's rules ever counted as a person or a bot). */
export function hostTypeOfAccountKind(kind: HostAccountKind | undefined): string | undefined {
  if (kind === undefined) return undefined;
  return kind === "person" ? "User" : kind === "bot" ? "Bot" : "Organization";
}

/**
 * GitHub's `mergeable_state` in the port's words: `dirty` is `conflicted`; `has_hooks` ("mergeable with passing commit status and pre-receive hooks") is `clean`, as Cloud's
 * rules only ever singled out `dirty`, `behind` and `unknown`, so this moves no decision.
 */
export function mergeableStateOfGithub(state: "clean" | "dirty" | "behind" | "blocked" | "unstable" | "has_hooks" | "draft" | "unknown"): MergeableState {
  if (state === "dirty") return "conflicted";
  if (state === "has_hooks") return "clean";
  return state;
}

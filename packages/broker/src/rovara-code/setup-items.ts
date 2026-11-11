// Meta repo lane B (K1, task B3): what each item of a setup proposal means for the project that is looking at it. This module is pure (no table, no network):
//   - what the project has now for an item, so the page can say "You typed X. Rovara suggests Y." and apply can refuse to replace it;
//   - the digest an approval card is bound to;
//   - the registry of appliers: what happens to an item that needs a person's approval card once the card is approved. A repository and a dev container pull request are
//     built in (setup-draft.ts). A source, an intake trigger and a secret are the business of the lane that owns each (context sources, intake): until that lane registers an
//     applier, the item is shown as "can't be set up from here yet" and gets no card, because a card for something nobody can apply would be theatre.
import { createHash } from "node:crypto";
import { canonicalJson, codeRepositoriesOf, formatCommandLine, setupItemHandling, settingOriginOf, type IntakeChannelRef, type ProjectOriginField, type ProjectSettingsBody, type SetupItem, type SetupItemKind, type SetupProposal, type SetupReviewEntry } from "@rovara-code/contracts";
import { type StoredProjectDefinition } from "@agentx/cloud-contracts";

/** What a person is told when an item cannot be applied from here (fixed words, never a model's or a repository's). */
export const SETUP_ITEM_WORDS = {
  otherRepository: "Project settings run setup and test commands in the project's first repository. Commands for another repository can't be saved there yet.",
  noCards: "Approval cards aren't set up in this deployment.",
  noApplier: "Rovara can't set this up from here yet.",
  info: "Nothing in the project settings holds this yet. It is shown so you can see where it came from.",
  notGithub: "Only repositories on github.com can be added from here yet.",
  managedByFile: "The meta repo's config file manages this setting. Change it there.",
  /** UX-4b: with test services on, a task's checks run in the project's test environment with its dependencies; a dev container is not offered beside it. */
  devcontainerWithServices: "Test services are on here, so tasks run in the project's test environment with their dependencies, not in a dev container. Set the test environment up instead.",
} as const;

/** The digest an approval card is bound to: the kind and value as the person saw them. A proposal whose item changed no longer matches a card made for the old one. */
export function itemDigest(item: Pick<SetupItem, "kind" | "proposed">): string {
  return createHash("sha256").update(canonicalJson({ kind: item.kind, value: item.proposed.value })).digest("hex");
}

/** The repository a project's setup and test commands run in: its first code repository (a meta repository that is not also code is never the first). */
export const commandRepositoryOf = (definition: Pick<StoredProjectDefinition, "repositories">): string | undefined => codeRepositoriesOf(definition)[0]?.name;

const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);
const cut = (value: string): string => [...value].slice(0, 600).join("");

/** `owner/name` of a github.com repository URL, lower-cased; undefined for any other host or shape. */
export function githubFullNameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const parts = parsed.pathname.replace(/\.git$/u, "").split("/").filter(Boolean);
    return parts.length === 2 ? parts.join("/") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project setting an item sets, by the name settings origins use; undefined for an item that is not a setting (a secret, and a test environment hint, which is kept with the
 * test environment and not in the project's settings). Every origin field has exactly one kind, so a lane that adds an applier gets its setting's origin read like the built-in ones.
 */
export function settingFieldOf(item: Pick<SetupItem, "kind">): ProjectOriginField | undefined {
  switch (item.kind) {
    case "repository": return "repositories";
    case "setup": return "setup";
    case "tests": return "readiness";
    case "devcontainer": return "devcontainer";
    case "allowed_domain": return "network";
    case "check": return "checks";
    case "knowledge": return "knowledge";
    case "spec_target": return "specTarget";
    case "source": return "sources";
    case "intake": return "intake";
    case "test_environment": return undefined;
    case "secret": return undefined;
  }
}

/**
 * What the project holds now for an item's setting; undefined for an item that is not a setting (nothing to compare). The setting's ORIGIN is read from the project, never
 * guessed from the value:
 *   - set by the meta repo's config file (`file`) and not already the suggestion: `managed_by_file`, changed by changing the file (a save would be refused);
 *   - a different value set by a person (no mark, or `person`): `differs` with `setBy: "person"`, kept unless that item's own tick says to replace it;
 *   - a different value Rovara itself set earlier (`agent`): `differs` with `setBy: "agent"`, which a new proposal may replace.
 */
export function currentOf(definition: StoredProjectDefinition, item: SetupItem): SetupReviewEntry["current"] | undefined {
  const value = item.proposed.value as Record<string, unknown>;
  const field = settingFieldOf(item);
  const origin = field === undefined ? "person" : settingOriginOf(definition, field);
  const held = (state: "empty" | "same" | "differs", yours?: string[]): SetupReviewEntry["current"] => {
    if (state === "same") return { state };
    if (origin === "file") return { state: "managed_by_file", ...(yours === undefined ? {} : { yours }) };
    return state === "empty" ? { state } : { state, ...(yours === undefined ? {} : { yours }), setBy: origin === "agent" ? "agent" : "person" };
  };
  if (item.kind === "setup" || item.kind === "tests") {
    const now = (item.kind === "setup" ? definition.setup : definition.readiness).map((command) => cut(formatCommandLine(command)));
    const wanted = (value["commands"] as string[]).map((line) => cut(line));
    if (now.length === 0) return held("empty");
    return held(same(now, wanted) ? "same" : "differs", now.slice(0, 64));
  }
  if (item.kind === "devcontainer") {
    const now = definition.devcontainer;
    if (now === undefined) return held("empty");
    const line = `${now.repository}:${now.configPath ?? ""}`;
    const wanted = `${String(value["repository"])}:${String(value["configPath"])}`;
    return held(line === wanted ? "same" : "differs", [cut(line)]);
  }
  if (item.kind === "repository") {
    const wanted = githubFullNameOf(String(value["url"]))?.toLowerCase();
    const present = wanted !== undefined && definition.repositories.some((repository) => githubFullNameOf(repository.url)?.toLowerCase() === wanted);
    return held(present ? "same" : "empty");
  }
  return undefined;
}

/** Why an item cannot be applied from here, in fixed words; undefined when it can. `cards`: whether approval cards are set up. `testServices`: whether the install's test services are on (UX-4b). */
export function unavailableReason(definition: StoredProjectDefinition, item: SetupItem, options: { cards: boolean; testServices?: boolean }): string | undefined {
  const handling = setupItemHandling(item.kind, item.proposed.value);
  if (item.kind === "devcontainer" && options.testServices === true) return SETUP_ITEM_WORDS.devcontainerWithServices;
  if (handling === "info") return SETUP_ITEM_WORDS.info;
  if (currentOf(definition, item)?.state === "managed_by_file") return SETUP_ITEM_WORDS.managedByFile;
  if (item.kind === "setup" || item.kind === "tests") {
    return (item.proposed.value as { repo: string }).repo === commandRepositoryOf(definition) ? undefined : SETUP_ITEM_WORDS.otherRepository;
  }
  if (handling === "approval") {
    if (!options.cards) return SETUP_ITEM_WORDS.noCards;
    if (getSetupItemApplier(item.kind) === undefined) return SETUP_ITEM_WORDS.noApplier;
    if (item.kind === "repository" && githubFullNameOf(String((item.proposed.value as { url: string }).url)) === undefined) return SETUP_ITEM_WORDS.notGithub;
  }
  return undefined;
}

// ---- the registry of appliers (items that need an approval card)

/** What an applier is given once its card is approved. `host` is what the person pressing apply may do, as them. */
export interface SetupItemApplyContext {
  project: string;
  /** The draft the item belongs to. */
  taskId: string;
  item: SetupItem;
  proposal: SetupProposal;
  /** The person who approved the card. */
  approvedBy: string;
  /** The approval being used. An applier whose effect cannot be undone derives its own request ids from this, never from `requestId`, so a retry under the same approval cannot do it twice. */
  approvalId: string;
  /** The request id this application is made under: the same every time the same request is repeated. */
  requestId: string;
  /** The project's settings revision now. */
  revision: number;
  host: {
    /** Plan 2's settings save, as the maintainer applying. What it changes is marked as set by the setup agent (`origin: "agent"`), not as typed by a person. */
    updateSettings(body: ProjectSettingsBody): Promise<{ warnings: string[] }>;
    /** `startCodeIntent`, as the maintainer applying. */
    startPullRequest(request: { requestId: string; text: string }): Promise<{ taskId: string; sessionId?: string; sessionUrl?: string }>;
    /** One pull request per draft: claimed before it is started, given back when it could not be. */
    claimPullRequest(requestId: string): Promise<void>;
    releasePullRequestClaim(requestId: string): Promise<void>;
    /** Adds one intake source to the project, as the maintainer applying (wire lane D, MF-2). Idempotent: a source already there is `already_set`. */
    addIntakeSource(ref: IntakeChannelRef): Promise<"added" | "already_set" | "differs">;
    /** Whether the project has a connection of this name now (one of its own connectors). A name that is not one is never used by an applier. */
    connectionExists(name: string): Promise<boolean>;
  };
}

export interface SetupItemApplier {
  /** The words on the approval card: what approving it lets a maintainer do. */
  cardWords(item: SetupItem): string[];
  /**
   * Applies the item after its card was approved, as the maintainer applying it. The consent is given back when this throws, so a later press runs it again under the SAME
   * approval: an applier must be atomic or idempotent per `approvalId` (derive the request ids of what it starts from it), or must not throw after its effect.
   * Throws an `AgentXError` in fixed words when it cannot. Returns the warnings to show, and the pull request it opened, if any. */
  apply(context: SetupItemApplyContext): Promise<{ warnings: string[]; pullRequest?: { taskId: string; sessionId?: string; sessionUrl?: string } }>;
}

const appliers = new Map<SetupItemKind, SetupItemApplier>();

/** Registers (or replaces) what applying an item of this kind does once its card is approved. The lane that owns a kind (context sources, intake) registers it. */
export function registerSetupItemApplier(kind: SetupItemKind, applier: SetupItemApplier): void {
  appliers.set(kind, applier);
}
export const getSetupItemApplier = (kind: SetupItemKind): SetupItemApplier | undefined => appliers.get(kind);
/** Removes an applier; for tests. */
export function unregisterSetupItemApplier(kind: SetupItemKind): void {
  appliers.delete(kind);
}

/** The kinds of item the approval card's subject can name. */
export const SETUP_CARD_KINDS = ["repository", "devcontainer", "source", "intake", "secret"] as const;
export type SetupCardKind = (typeof SETUP_CARD_KINDS)[number];
export const isCardKind = (kind: SetupItemKind): kind is SetupCardKind => (SETUP_CARD_KINDS as readonly string[]).includes(kind);

/** A short, plain description of where an item came from, for a card: repository, path and line only (never a quote). */
export function citationWords(item: SetupItem): string {
  const places = item.proposed.from.slice(0, 4).map((citation) => (citation.path === undefined ? "inferred by Rovara, from no file" : `${citation.repo ?? ""}/${citation.path}${citation.line === undefined ? "" : `:${String(citation.line)}`}`));
  return places.length === 0 ? "No place is named." : `It came from ${places.join(", ")}.`;
}

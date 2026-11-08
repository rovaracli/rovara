// SRL-5a: the hourly check that a repository the record holds GitHub rows from is still there. The `repository deleted` / `transferred` webhook removes such rows, but GitHub may never have sent it
// (the App was not subscribed to the event, or the webhook was off), and a redelivery cannot bring back a delivery GitHub never made. This asks the installation instead. Reasoning and limits:
// .superpowers/sdd/srl5-github-delete-sweep/design.md (section "The repository check").
//
// GitHub answers 404 for a deleted repository AND for one the installation can no longer reach (transferred out, or no longer shared with the App), and nothing a third party can call tells the two
// apart. Both mean the same to Rovara: it can no longer read the repository, so it must stop holding what it copied from it (the tap already treats a transfer out the same way). So "not held" is
// what is decided, and a tombstone cannot be undone, so the check is built not to be fooled (the MCP existence sweep's rules, `sources/existence-sweep.ts`):
//  - an error, a refusal, a timeout, a redirect or an unclear answer is never "not held" (a throw from a port is "unknown" and nothing of that installation is tombstoned);
//  - the installation's repository list must be read COMPLETELY (a list that may have more pages is not believed) and must not be empty (an empty list is what a revoked or suspended installation looks
//    like, and says nothing about this repository: that is the canary);
//  - a repository missing from the list is confirmed by asking for it directly (`GET /repositories/{id}`): only a clear 404 counts;
//  - nothing is tombstoned until the whole installation is read: more than 20 percent of an installation's recorded repositories "not held" is not believed (a narrowed installation looks exactly like
//    that), and fewer than 5 repositories may lose one at most;
//  - a repository already marked failing (its tombstone was done) is not checked again.

export interface RecordedRepository {
  workspaceId: string;
  /** The record's scope: `github:repo/<id>`. */
  scope: string;
  repositoryId: number;
  installationId: number;
}

export interface InstallationRepositoriesPort {
  /** Every repository id the installation reaches; `complete: false` when the list may have more. Throws on anything unclear. */
  repositoryIds(installationId: number, workspaceId: string): Promise<{ ids: readonly number[]; complete: boolean }>;
  /** `exists` on a clear 200, `missing` on a clear 404, a throw on anything else. */
  status(installationId: number, repositoryId: number, workspaceId: string): Promise<"exists" | "missing">;
}

export interface RepositoryCheckDependencies {
  installations: InstallationRepositoriesPort;
  /** Removes what the record holds from the repository (the tap's own tombstone, plus marking the source row failing). Throws when no durable path took it. */
  remove(repository: RecordedRepository): Promise<void>;
  log?: (event: string, fields: Record<string, number>) => void;
}

export interface RepositoryCheckOutcome {
  checked: number;
  removed: number;
  /** Installations skipped for an error, an incomplete or empty list, or a lookup that was not clear. Nothing of theirs was removed. */
  unknown: number;
  /** Installations where too many repositories looked missing at once: nothing removed. */
  refused: number;
  /** Removals no durable path took. */
  failed: number;
}

/** More than this share of an installation's recorded repositories "not held" is a sign of a narrowed installation, not of deletions. */
export const REPOSITORY_MAX_MISSING_SHARE = 0.2;
/** Under this many repositories the share means nothing: such an installation may lose one repository at most per check. */
export const REPOSITORY_MIN_FOR_SHARE = 5;

const tooMany = (missing: number, recorded: number): boolean => recorded >= REPOSITORY_MIN_FOR_SHARE ? missing / recorded > REPOSITORY_MAX_MISSING_SHARE : missing > 1;

export async function checkRecordedRepositories(deps: RepositoryCheckDependencies, repositories: readonly RecordedRepository[]): Promise<RepositoryCheckOutcome> {
  const log = deps.log ?? (() => undefined);
  const outcome: RepositoryCheckOutcome = { checked: 0, removed: 0, unknown: 0, refused: 0, failed: 0 };
  const byInstallation = new Map<number, RecordedRepository[]>();
  for (const repository of repositories) byInstallation.set(repository.installationId, [...(byInstallation.get(repository.installationId) ?? []), repository]);
  for (const [installationId, group] of byInstallation) {
    const workspaceId = group[0]!.workspaceId;
    outcome.checked += group.length;
    let confirmed: RecordedRepository[];
    try {
      const listed = await deps.installations.repositoryIds(installationId, workspaceId);
      if (!listed.complete || listed.ids.length === 0) {
        outcome.unknown += 1;
        log("record.github_repo_check_unclear", { complete: listed.complete ? 1 : 0, listed: listed.ids.length });
        continue;
      }
      const reachable = new Set(listed.ids);
      const notListed = group.filter((repository) => !reachable.has(repository.repositoryId));
      // The brake is applied to what the list shows first (confirming can only lower it), so a narrowed installation costs no per-repository lookups.
      if (tooMany(notListed.length, group.length)) {
        outcome.refused += 1;
        log("record.github_repo_check_refused", { missing: notListed.length, recorded: group.length });
        continue;
      }
      confirmed = [];
      // Missing from the list: only a clear 404 from the repository itself counts. Anything else throws and ends this installation's check.
      for (const repository of notListed) {
        if (await deps.installations.status(installationId, repository.repositoryId, workspaceId) === "missing") confirmed.push(repository);
      }
    } catch {
      outcome.unknown += 1;
      log("record.github_repo_check_unknown", {});
      continue;
    }
    if (confirmed.length === 0) continue;
    for (const repository of confirmed) {
      try {
        await deps.remove(repository);
        outcome.removed += 1;
      } catch {
        outcome.failed += 1;
        log("record.github_repo_check_remove_failed", {});
      }
    }
  }
  return outcome;
}

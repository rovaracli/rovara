// A small in-memory code host for the company rules file sync (G-04): one repository with a default branch, branches that are snapshots of one or two files, pull requests, and the same refusals the GitHub adapter makes (a
// company-rules branch name, a company-rules path, a branch that exists, a file that is not as the caller read it). `push` is a person pushing to the default branch; `merge` and `close` are a person deciding a pull request.
import { createHash } from "node:crypto";
import { COMMIT_CONFLICT_MESSAGE, agentXError, type CodeHost, type ChangeRequestDetails } from "@agentx/contracts";
import { COMPANY_RULES_BRANCH_PATTERN, companyRulesPathProblem } from "../../packages/broker/src/company-rules/path.js";
import type { CompanyRulesRepositories } from "../../packages/broker/src/company-rules/sync.js";

type Files = Record<string, string>;
interface Pull { number: number; source: string; target: string; title: string; body: string; state: "open" | "closed" | "merged" }

export class FakeCompanyRepo {
  id = 4242;
  fullName = "acme/company-meta";
  defaultBranch = "main";
  /** Every host call throws while true (the host is down). */
  down = false;
  /** The calls made, by method name. */
  readonly calls: string[] = [];
  readonly pulls: Pull[] = [];
  private counter = 0;
  private readonly snapshots = new Map<string, Files>();
  private readonly branches = new Map<string, string>();

  constructor(files: Files = {}) { this.branches.set("main", this.snapshot(files)); }

  private snapshot(files: Files): string {
    this.counter += 1;
    const sha = createHash("sha1").update(`snapshot-${String(this.counter)}`).digest("hex");
    this.snapshots.set(sha, { ...files });
    return sha;
  }
  headOf(branch: string): string | undefined { return this.branches.get(branch); }
  filesOn(branch: string): Files { return { ...(this.snapshots.get(this.branches.get(branch) ?? "") ?? {}) }; }
  /** A person pushes a file to the default branch. */
  push(path: string, content: string | null): void {
    const files = this.filesOn("main");
    if (content === null) delete files[path]; else files[path] = content;
    this.branches.set("main", this.snapshot(files));
  }
  /** A person adds a commit to a branch (Rovara's own, say). */
  touch(branch: string): void { this.branches.set(branch, this.snapshot({ ...this.filesOn(branch), "touched.txt": String(this.counter) })); }
  merge(number: number): void {
    const pull = this.pulls.find((entry) => entry.number === number)!;
    this.branches.set(pull.target, this.branches.get(pull.source)!);
    pull.state = "merged";
  }
  close(number: number): void { this.pulls.find((entry) => entry.number === number)!.state = "closed"; }
  openPulls(): Pull[] { return this.pulls.filter((pull) => pull.state === "open"); }

  private gate(name: string): void { this.calls.push(name); if (this.down) throw new Error("host down"); }

  host(): CodeHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the methods of the returned object are the host's: they close over this repository
    const repo = this;
    const unused = (name: string) => async (): Promise<never> => { throw new Error(`${name} is not used by the company rules sync`); };
    const detailsOf = (pull: Pull): ChangeRequestDetails => ({
      ref: { repository: { url: "https://github.com/acme/company-meta.git" }, id: String(pull.number), url: `https://github.com/acme/company-meta/pull/${String(pull.number)}` },
      state: pull.state, sourceBranch: pull.source, targetBranch: pull.target, headRevision: repo.branches.get(pull.source) ?? "0".repeat(40), title: pull.title, body: pull.body, authoredByRovara: true, baseRepositoryId: String(repo.id),
    });
    return {
      kind: "github", capabilities: {} as never, events: {} as never,
      async repositoryIdentity() { repo.gate("repositoryIdentity"); return { id: String(repo.id), fullName: repo.fullName, defaultBranch: repo.defaultBranch }; },
      async baseBranchHead(_r: unknown, branch: string) { repo.gate("baseBranchHead"); const head = repo.branches.get(branch); if (head === undefined) throw new Error("no such branch"); return head; },
      async branchHead(_r: unknown, branch: string) { repo.gate("branchHead"); const head = repo.branches.get(branch); if (head === undefined) throw new Error("no such branch"); return head; },
      async fileAtRevision(_r: unknown, path: string, revision: string, _s: unknown, options?: { maxBytes?: number }) {
        repo.gate("fileAtRevision");
        const text = repo.snapshots.get(revision)?.[path];
        if (text !== undefined && options?.maxBytes !== undefined && Buffer.byteLength(text, "utf8") > options.maxBytes) throw agentXError("CONFIG_INVALID", "file is too large");
        return text;
      },
      async commitFiles(input: { branch: string; baseBranch: string; files: Array<{ path: string; content: string }>; fromBase: boolean; baseRevision?: string; expectedHead?: string; previous?: Array<{ path: string; content: string | null }> }) {
        repo.gate("commitFiles");
        if (!COMPANY_RULES_BRANCH_PATTERN.test(input.branch) || input.branch === input.baseBranch) throw agentXError("CONFIG_INVALID", "branch name is invalid");
        if (input.files.some((file) => companyRulesPathProblem(file.path) !== undefined)) throw agentXError("CONFIG_INVALID", "file path is not one Rovara writes company rules to");
        const existing = repo.branches.get(input.branch);
        if (input.fromBase && existing !== undefined) throw agentXError("CONFIG_INVALID", COMMIT_CONFLICT_MESSAGE);
        if (!input.fromBase && existing !== input.expectedHead) throw agentXError("CONFIG_INVALID", COMMIT_CONFLICT_MESSAGE);
        const base = input.fromBase ? (input.baseRevision ?? repo.branches.get(input.baseBranch)!) : existing!;
        const files = { ...(repo.snapshots.get(base) ?? {}) };
        for (const expected of input.previous ?? []) if ((files[expected.path] ?? null) !== expected.content) throw agentXError("CONFIG_INVALID", COMMIT_CONFLICT_MESSAGE);
        for (const file of input.files) files[file.path] = file.content;
        const revision = repo.snapshot(files);
        repo.branches.set(input.branch, revision);
        return { revision, changed: true };
      },
      async reconcileChangeRequest(input: { sourceBranch: string; targetBranch: string; title: string; body?: string }) {
        repo.gate("reconcileChangeRequest");
        const found = repo.pulls.find((pull) => pull.source === input.sourceBranch && pull.target === input.targetBranch && pull.state === "open");
        if (found !== undefined) return { ref: detailsOf(found).ref, reconciled: true };
        const pull: Pull = { number: repo.pulls.length + 1, source: input.sourceBranch, target: input.targetBranch, title: input.title, body: input.body ?? "", state: "open" };
        repo.pulls.push(pull);
        return { ref: detailsOf(pull).ref, reconciled: false };
      },
      async getChangeRequest(ref: { id: string }) { repo.gate("getChangeRequest"); const pull = repo.pulls.find((entry) => String(entry.number) === ref.id); if (pull === undefined) throw agentXError("NOT_FOUND", "no such pull request"); return detailsOf(pull); },
      async updateChangeRequest(ref: { id: string }, update: { title?: string; body?: string }) {
        repo.gate("updateChangeRequest");
        const pull = repo.pulls.find((entry) => String(entry.number) === ref.id)!;
        if (update.title !== undefined) pull.title = update.title;
        if (update.body !== undefined) pull.body = update.body;
      },
      checkRepository: unused("checkRepository"), standing: unused("standing"), issueGitCredential: unused("issueGitCredential"), tree: unused("tree"), commitParents: unused("commitParents"), listBranches: unused("listBranches"),
      changeRequestStatus: unused("changeRequestStatus"), changedFiles: unused("changedFiles"), feedback: unused("feedback"), reply: unused("reply"),
    } as unknown as CodeHost;
  }

  repositories(): CompanyRulesRepositories {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the port's methods close over this repository
    const repo = this;
    return {
      async connect(_orgId, owner, name) {
        if (`${owner}/${name}`.toLowerCase() !== repo.fullName) throw agentXError("GITHUB_NOT_CONNECTED", `Rovara can't reach ${owner}/${name} through your organization's GitHub connection.`);
        return { repositoryId: repo.id, url: "https://github.com/acme/company-meta.git" };
      },
      target(_orgId, repository) {
        return { name: repository.name, place: `github:repo/${String(repository.repositoryId)}`, repository: { url: repository.url }, scope: { system: "private-install" } as never, host: repo.host() };
      },
    };
  }
}

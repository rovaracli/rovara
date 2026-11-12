// Which files say how a repository is built and run, so they are read first and always fit the read budget: package manifests, CI workflows, Dockerfiles, dev containers, compose files, the Makefile and the README.
// Everything else (source files, other settings) is read with what is left. Pure over the path.

const DEPENDENCY_DIRS = /(?:^|\/)(?:node_modules|dist|build|\.git|venv|\.venv|vendor|tests?|__tests__|fixtures?|examples?|samples?)\//u;
/** A manifest, build file or root-level guide, by file name. */
const IMPORTANT_NAMES = /^(?:package\.json|pyproject\.toml|requirements(?:[-.][\w.-]+)?\.txt|setup\.py|setup\.cfg|Pipfile|tox\.ini|pytest\.ini|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|go\.mod|go\.work|Cargo\.toml|Gemfile|composer\.json|Config|Makefile|makefile|GNUmakefile|justfile|Taskfile\.ya?ml|Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.dockerfile|(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml|devcontainer\.json|\.devcontainer\.json|\.gitlab-ci\.yml|\.travis\.yml|Jenkinsfile|bitbucket-pipelines\.yml|azure-pipelines\.yml|buildspec\.ya?ml|\.env\.example|\.tool-versions|\.nvmrc|\.node-version|\.python-version)$/u;
/** Files that count only where they are: CI workflow folders and the dev container folder. */
const IMPORTANT_FOLDERS = /^(?:\.github\/workflows\/[^/]+\.ya?ml|\.circleci\/config\.yml|\.devcontainer\/[^/]+)$/u;
const README = /^README(?:\.[A-Za-z]+)?$/u;
/** A manifest in a monorepo's package folder counts; one buried deeper (a vendored sample, a nested fixture) does not. */
const MAX_DEPTH = 3;

/** Whether the file is one of the build and run files (see the module comment). */
export function isImportantPath(path: string): boolean {
  if (DEPENDENCY_DIRS.test(path)) return false;
  if (IMPORTANT_FOLDERS.test(path)) return true;
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.length - 1 > MAX_DEPTH) return false;
  if (parts.length === 1 && README.test(name)) return true;
  return IMPORTANT_NAMES.test(name);
}

/** The paths with the important ones first; each group keeps its order (a stable partition), so a result is the same for the same list. */
export function importantFirst(paths: readonly string[]): string[] {
  const important: string[] = [];
  const rest: string[] = [];
  for (const path of paths) (isImportantPath(path) ? important : rest).push(path);
  return [...important, ...rest];
}

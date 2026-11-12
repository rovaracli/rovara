// Whether two commands run the same thing. `npm test`, `npm t`, `npm run test` and `npm run-script test` are one command, and so are `pnpm test` and `pnpm run test`; a proposal that lists both lists one check twice.
// Conservative: only these spellings of "run this package.json script" are folded together. Different scripts (`typecheck` and `typecheck:all`), different arguments and different programs are never the same.
import type { ProjectCommand } from "@rovara-code/contracts";

/** Words pnpm and yarn run as their own commands: `pnpm install` is not the `install` script. Any other first word is a script name (pnpm and yarn run it). */
const PACKAGE_MANAGER_COMMANDS = new Set([
  "add", "audit", "autoremove", "bin", "cache", "config", "create", "dedupe", "dlx", "env", "exec", "fetch", "global", "help", "import", "info", "init", "install", "i", "link", "list", "ls", "login", "logout", "node", "outdated", "owner", "pack",
  "patch", "patch-commit", "plugin", "prune", "publish", "rebuild", "remove", "rm", "root", "run", "run-script", "self-update", "server", "set", "setup", "store", "tag", "team", "unlink", "unplug", "up", "update", "upgrade", "upgrade-interactive", "version", "why", "workspace", "workspaces", "x",
]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_TEST = new Set(["test", "t", "tst"]);

/** The command as one list of words that is the same for every spelling of it: the program's own name, then `run <script>` for a script, then the arguments. A trailing bare `--` is dropped. */
export function commandWords(command: Pick<ProjectCommand, "executable" | "args">): string[] {
  const program = command.executable.split("/").pop() ?? command.executable;
  const args = [...command.args];
  while (args.length > 0 && args.at(-1) === "--") args.pop();
  const [first, ...rest] = args;
  if (first === undefined) return [program];
  if (program === "npm") {
    if (NPM_RUN.has(first) && rest.length > 0) return [program, "run", ...rest];
    if (NPM_TEST.has(first)) return [program, "run", "test", ...rest];
  } else if (program === "pnpm" || program === "yarn") {
    if (first === "run" || first === "run-script") return rest.length > 0 ? [program, "run", ...rest] : [program, ...args];
    if (program === "pnpm" && first === "t") return [program, "run", "test", ...rest];
    if (/^[A-Za-z][\w:.-]*$/u.test(first) && !PACKAGE_MANAGER_COMMANDS.has(first)) return [program, "run", first, ...rest];
  } else if (program === "bun" && first === "run" && rest.length > 0) return [program, "run", ...rest];
  return [program, ...args];
}

/** Whether two commands run the same program with the same arguments, treating the spellings of one package.json script as the same. The directory is not compared. */
export function sameCommandLine(left: Pick<ProjectCommand, "executable" | "args">, right: Pick<ProjectCommand, "executable" | "args">): boolean {
  return JSON.stringify(commandWords(left)) === JSON.stringify(commandWords(right));
}

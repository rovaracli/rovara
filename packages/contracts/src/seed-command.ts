// Seed and migration commands (TS-UX-1): a command that fills or builds a database. Such a command needs a database, and a project's database exists only inside the test environment (the test services start it for a
// run), so it is never a SETUP command: setup runs on a fresh machine with no database, and the command is bound to fail. It belongs to the dependency's seed. This is a reading of the command's words, nothing more:
// it never runs anything, and a person still approves where a command lands.
import type { ProjectCommand } from "./project-node.js";

/** Programs that run a project's own script or tool. Anything else (`git`, `cat`) is never read as a seed. */
const RUNNERS = new Set([
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "node", "ts-node", "tsx", "deno", "python", "python3", "poetry", "pipenv", "uv", "flask", "django-admin", "alembic", "rake", "rails", "bundle", "make", "psql", "pg_restore", "knex", "sequelize", "prisma", "typeorm", "drizzle-kit",
]);
/** A word that names a seed or a migration: delimited by the start, the end or one of `: / _ . -`. `seedling` and `reseed` are not. */
const SEED_WORD = /(?:^|[:/_.-])(?:seed|seeds|seeding|migrate|migrations?|loaddata|db-setup|db-reset)(?![A-Za-z0-9])/u;
const EXTRA_WORDS = new Set(["db:setup", "db:reset", "db:push", "db:schema:load", "db:create"]);

/** Whether a command fills or migrates a database (by the words of its program and arguments), so it must not run in SETUP. */
export function isDatabaseSeedCommand(command: Pick<ProjectCommand, "executable" | "args">): boolean {
  const program = command.executable.split("/").pop() ?? command.executable;
  if (!RUNNERS.has(program)) return false;
  if (program === "psql" || program === "pg_restore") return true;
  const words = command.args.slice(0, 12);
  if (program === "alembic") return words.some((word) => word === "upgrade" || word === "downgrade");
  if (program === "flask" || program === "poetry") return words.some((word) => SEED_WORD.test(word) || word === "upgrade");
  return words.some((word) => EXTRA_WORDS.has(word) || SEED_WORD.test(word));
}

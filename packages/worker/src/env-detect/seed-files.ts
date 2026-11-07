// Seed files (TS-UX-1 item 8): SQL files in a repository that hold test data for its database: a `.sql` file in a `seeds/`, `seed/`, `seeders/` or `db/seeds/` folder, or one named for a seed (`seed.sql`,
// `test-seed.sql`, `users.seed.sql`). Offered as the database dependency's FILE seed, which loads data and runs no code, preferred over a command that fills the database. Only paths are read here, never a file.
import { DEPENDENCY_SKIP_DIRS } from "./dependency-candidates.js";
import type { Detector, Located } from "./types.js";

/** The most seed files one repository offers (the contract's seeds-per-dependency limit is 8, and a command may still sit beside them). */
export const SEED_FILES_MAX = 4;
const SEED_FOLDER = /(?:^|\/)(?:seeds?|seeders|seed-data|seed_data)\/(?:[^/]+\/)?[^/]+\.sql$/u;
const SEED_NAME = /(?:^|\/)(?:[a-z0-9_-]{0,40}[._-])?seeds?(?:[._-][a-z0-9_-]{0,40})?\.sql$/iu;
/** Tests' own fixtures and migrations are not seeds: a migration builds the schema (the project's commands do that), and a test fixture belongs to its test. */
const NOT_SEED = /(?:^|\/)(?:migrations?|tests?|__tests__|spec)\//u;

/** The repository's seed files, in path order, at most `SEED_FILES_MAX`. */
export function seedFilesOf(paths: readonly string[]): Array<Located<string>> {
  return paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path) && !NOT_SEED.test(path) && (SEED_FOLDER.test(path) || SEED_NAME.test(path)))
    .sort().slice(0, SEED_FILES_MAX).map((path) => ({ value: path, source: { path, line: 1 } }));
}

export const detectSeedFiles: Detector = async ({ repo }) => {
  const seedFiles = seedFilesOf(repo.paths);
  return seedFiles.length === 0 ? {} : { seedFiles };
};

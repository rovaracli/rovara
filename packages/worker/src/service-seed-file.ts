// File seeds (TS-UX-1 item 9; SECURITY-SENSITIVE): a dependency's `seeds[].fixturePath` is a repository file of test data, loaded into the run's own DISPOSABLE test database by that database's own client, inside
// the dependency's container. Nothing here runs the project's code.
//
// Rules, each with a test (tests/unit/worker-service-seed-file.test.ts):
//   - THE FILE IS THE REPOSITORY'S. The path (relative, checked by the contract) is resolved to its real path, which must be a regular file under one of the REPOSITORIES' own folders (each resolved too), never under a hidden
//     folder of the workspace (the worker's state, the agent's sessions, the Docker data root); `..` and a symlink that points outside are refused by that, a symlink inside the repository to a file inside it is allowed. It
//     is opened without following a link, and the opened file must be the very file that was resolved (device and inode), so a swap between the check and the open is refused.
//   - SMALL AND PLAIN. At most `SEED_FILE_MAX_BYTES`; `.sql` only; Postgres only (its `psql`). Any other family is refused (`unsupported`), never guessed.
//   - NO NETWORK, NO SECRET. `psql` runs in the helper's own container over its local socket (no host, no port, no password: the image trusts its socket, as the reset hook relies on). The file's bytes go on stdin;
//     nothing of them is an argument, a log line or an error. The database and user names are the helper's own request's, checked against the launcher's plain patterns.
//   - BOUNDED. One transaction (`--single-transaction`, `ON_ERROR_STOP=1`): a bad statement loads nothing. A time limit (`SEED_FILE_TIMEOUT_MS`) and the run's cancellation stop it. Output is read up to a small cap and
//     thrown away.
//   - FIXED WORDS. Every failure is a `SeedFileError` with a fixed reason; the run sees only the seeds' fixed sentence.
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DockerCli } from "./swebench/containers.js";
import { HELPER_CREDENTIAL_PATTERNS } from "./service-helpers.js";

/** The most a seed file may hold. */
export const SEED_FILE_MAX_BYTES = 5 * 1_048_576;
/** The longest one file may take to load. */
export const SEED_FILE_TIMEOUT_MS = 5 * 60_000;
/** The families whose own client loads a file, and the extension each takes. */
const FILE_SEED_FAMILIES: Readonly<Record<string, string>> = { postgres: ".sql" };

export type SeedFileFailure = "outside" | "not_a_file" | "too_large" | "unsupported" | "load_failed" | "timeout";
export class SeedFileError extends Error {
  constructor(readonly reason: SeedFileFailure) {
    super("A test service's seed file did not load");
    this.name = "SeedFileError";
  }
}

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

/**
 * The bytes of a seed file, or a `SeedFileError`: the real path must be a regular file inside a repository folder and outside every hidden folder, with the family's extension and at most `SEED_FILE_MAX_BYTES`, and the file
 * opened (without following a link) must be the one resolved.
 */
export async function readSeedFile(input: { rootPath: string; repositoryPaths: readonly string[]; hiddenPaths: readonly string[]; fixturePath: string; family: string }): Promise<Buffer> {
  const extension = FILE_SEED_FAMILIES[input.family];
  if (extension === undefined) throw new SeedFileError("unsupported");
  if (input.fixturePath.startsWith("/") || input.fixturePath.split(/[\\/]/u).includes("..") || input.fixturePath.includes("\0")) throw new SeedFileError("outside");
  let real: string;
  let repositories: string[];
  let hidden: string[];
  try {
    repositories = (await Promise.all(input.repositoryPaths.map((path) => realpath(path).catch(() => undefined)))).filter((path): path is string => path !== undefined);
    hidden = await Promise.all(input.hiddenPaths.map((path) => realpath(path).catch(() => path)));
    real = await realpath(resolve(input.rootPath, input.fixturePath));
  } catch {
    throw new SeedFileError("not_a_file");
  }
  // Strictly inside a repository folder (never the folder itself), and never inside a hidden one.
  if (!repositories.some((folder) => real.startsWith(`${folder}${sep}`)) || hidden.some((folder) => within(real, folder))) throw new SeedFileError("outside");
  if (!real.toLowerCase().endsWith(extension)) throw new SeedFileError("unsupported");
  let resolvedInfo: { dev: number; ino: number };
  try { resolvedInfo = await stat(real); } catch { throw new SeedFileError("not_a_file"); }
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new SeedFileError("not_a_file"); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== resolvedInfo.dev || info.ino !== resolvedInfo.ino) throw new SeedFileError("not_a_file");
    if (info.size > SEED_FILE_MAX_BYTES) throw new SeedFileError("too_large");
    const bytes = await handle.readFile();
    // The file may have grown since the size was read.
    if (bytes.length > SEED_FILE_MAX_BYTES) throw new SeedFileError("too_large");
    return bytes;
  } catch (error) {
    throw error instanceof SeedFileError ? error : new SeedFileError("not_a_file");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The helper a file loads into: its container, family, and the database and user of its own request. */
export interface SeedFileTarget { container: string; family: string; user: string | undefined; database: string | undefined }

/** The `psql` call for a file on stdin: the helper's local socket (no host, port or password), one transaction, stop at the first error, no startup file. */
export function seedFileLoadArgs(target: SeedFileTarget): string[] {
  if (FILE_SEED_FAMILIES[target.family] === undefined) throw new SeedFileError("unsupported");
  const { user, database } = target;
  if (user === undefined || database === undefined || !HELPER_CREDENTIAL_PATTERNS.user.test(user) || !HELPER_CREDENTIAL_PATTERNS.database.test(database)) throw new SeedFileError("unsupported");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(target.container)) throw new SeedFileError("unsupported");
  return ["exec", "-i", target.container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-U", user, "-d", database, "-f", "-"];
}

/** Loads the bytes into the helper's database with its own client. A non-zero exit (a bad statement: nothing is kept, one transaction), a timeout or a cancel is a `SeedFileError`. */
export async function loadSeedFile(docker: Pick<DockerCli, "execBytes">, target: SeedFileTarget, bytes: Buffer, signal: AbortSignal): Promise<void> {
  const args = seedFileLoadArgs(target);
  if (docker.execBytes === undefined) throw new SeedFileError("unsupported");
  const result = await docker.execBytes(args, { stdin: bytes, signal, timeoutMs: SEED_FILE_TIMEOUT_MS, maxStdoutBytes: 64 * 1_024 }).catch(() => undefined);
  if (result === undefined) throw new SeedFileError("load_failed");
  if (result.timedOut === true) throw new SeedFileError("timeout");
  if (result.aborted === true || result.exitCode !== 0) throw new SeedFileError("load_failed");
}

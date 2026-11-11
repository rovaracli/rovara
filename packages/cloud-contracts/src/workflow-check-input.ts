
const SECRET_FILE_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_.*|.*\.pem|.*\.key)$/u;
/**
 * True when a built-in file check may not read the path: anything in a `.git` folder, a dotenv file, a key or a token
 * file. A check that says "this file holds, or lacks, this text" would leak one bit about it, and a file check has no
 * reason to read them.
 */
export function builtinCheckPathRefused(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => segment === ".git" || segment === ".ssh" || segment === ".aws") || SECRET_FILE_NAME.test(segments.at(-1) ?? "");
}
/** The longest folder a corrected check from PR feedback may run in. */
export const WORKFLOW_FEEDBACK_CHECK_FOLDER_MAX = 120;

// Stdio MCP host redesign (T6): the result an install task reports to the controller (`PUT /result`). The task runs Rovara code only, but what it sends is read as data: every field is
// checked, a field that is not expected refuses the whole result, and the failure sentences are bounded plain text.

/** The failure codes of the install task (broker/mcp-runner/install-main.ts keeps the sentences; a test keeps the two lists equal). */
export const INSTALL_FAILURE_CODES = [
  "invalid_request", "integrity_mismatch", "not_found", "download_failed", "bad_package", "wrong_package", "git_dependency", "unsupported_manifest", "install_scripts",
  "lockfile_policy", "resolve_failed", "install_failed", "no_program", "too_large", "timed_out", "bundle_failed", "upload_failed",
] as const;
export type InstallFailureCode = (typeof INSTALL_FAILURE_CODES)[number];

export interface InstallReportData {
  integrity: string;
  lockfileHash: string;
  bundleHash: string;
  packageCount: number;
  unpackedBytes: number;
  tarBytes: number;
  bin: string;
}

export type InstallOutcome =
  | { ok: true; report: InstallReportData }
  | { ok: false; code: InstallFailureCode; sentence: string; rule?: string; package?: string; computedIntegrity?: string };

const SHA256 = /^[0-9a-f]{64}$/u;
const SHA512 = /^sha512-[A-Za-z0-9+/=]{20,200}$/u;
const PRINTABLE = /^[\x20-\x7e]*$/u;

const isCount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && PRINTABLE.test(value);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** The result, or undefined when it is not exactly a result the install task can send. */
export function parseInstallOutcome(raw: unknown): InstallOutcome | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.ok === true) {
    if (!onlyKeys(value, ["ok", "integrity", "lockfileHash", "bundleHash", "packageCount", "unpackedBytes", "tarBytes", "bin"])) return undefined;
    const { integrity, lockfileHash, bundleHash, packageCount, unpackedBytes, tarBytes, bin } = value;
    if (typeof integrity !== "string" || !SHA512.test(integrity) || typeof lockfileHash !== "string" || !SHA256.test(lockfileHash) || typeof bundleHash !== "string" || !SHA256.test(bundleHash)) return undefined;
    if (!isCount(packageCount, 5_000) || !isCount(unpackedBytes, 2 ** 40) || !isCount(tarBytes, 2 ** 40) || !isText(bin, 512)) return undefined;
    return { ok: true, report: { integrity, lockfileHash, bundleHash, packageCount, unpackedBytes, tarBytes, bin } };
  }
  if (value.ok === false) {
    if (!onlyKeys(value, ["ok", "code", "sentence", "rule", "package", "computedIntegrity"])) return undefined;
    const { code, sentence, rule, package: pkg, computedIntegrity } = value;
    if (typeof code !== "string" || !(INSTALL_FAILURE_CODES as readonly string[]).includes(code) || !isText(sentence, 600)) return undefined;
    if (rule !== undefined && !isText(rule, 60)) return undefined;
    if (pkg !== undefined && !isText(pkg, 300)) return undefined;
    if (computedIntegrity !== undefined && (typeof computedIntegrity !== "string" || !SHA512.test(computedIntegrity))) return undefined;
    return {
      ok: false, code: code as InstallFailureCode, sentence,
      ...(rule === undefined ? {} : { rule }), ...(pkg === undefined ? {} : { package: pkg }), ...(computedIntegrity === undefined ? {} : { computedIntegrity }),
    };
  }
  return undefined;
}

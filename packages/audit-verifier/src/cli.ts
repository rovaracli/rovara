#!/usr/bin/env node
/**
 * rovara-audit-verify <bundle[.gz]> [--extends <older[.gz]>] [--trust <label>=<pem file> ...] [--json] [--print-openssl]
 *
 * Exit 0: every check passed. 1: a check failed. 2: usage or parse error.
 * The limits text printed is this program's own (AUDIT_LIMITS_COPY), never anything from the bundle.
 */
import { X509Certificate } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseBundle, statementHash, BundleParseError, type AuditBundleV1, type EpochStatementV1 } from "./bundle.js";
import { canonicalJson } from "./canonical-json.js";
import { verifyExtends } from "./extends.js";
import { AUDIT_LIMITS_COPY } from "./limits-copy.js";
import { defaultAnchors } from "./trust.js";
import { verifyBundle, type BundleCheck, type BundleReport } from "./verify-bundle.js";

export type CliIo = { stdout: (text: string) => void; stderr: (text: string) => void };

const USAGE =
  "usage: rovara-audit-verify <bundle[.gz]> [--extends <older[.gz]>] [--trust <label>=<pem file> ...] [--json] [--print-openssl]";
// Mirrors AUDIT_EXPORT_MAX_RECORDS (an export holds at most this many records). This package does not
// import Rovara code, so the number is repeated here: 200,000 records at up to 2 KiB each, plus room
// for seals, epochs, timestamps and details.
const EXPORT_MAX_RECORDS = 200_000;
const DEFAULT_MAX_JSON_BYTES = EXPORT_MAX_RECORDS * 2048 + 16 * 1024 * 1024;
const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

class UsageError extends Error {}

type Args = { bundle: string; extendsPath?: string; trust: Array<{ label: string; path: string }>; json: boolean; openssl: boolean };

function parseArgs(argv: readonly string[]): Args {
  let bundle: string | undefined;
  let extendsPath: string | undefined;
  const trust: Args["trust"] = [];
  let json = false;
  let openssl = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const value = (): string => {
      i += 1;
      const next = argv[i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--extends") {
      if (extendsPath !== undefined) throw new UsageError("--extends may be given once");
      extendsPath = value();
    } else if (arg === "--trust") {
      const spec = value();
      const at = spec.indexOf("=");
      const label = at < 0 ? "" : spec.slice(0, at);
      const path = at < 0 ? "" : spec.slice(at + 1);
      if (!LABEL.test(label) || path === "") throw new UsageError("--trust takes <label>=<pem file>");
      trust.push({ label, path });
    } else if (arg === "--json") json = true;
    else if (arg === "--print-openssl") openssl = true;
    else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else if (bundle === undefined) bundle = arg;
    else throw new UsageError("only one bundle may be given");
  }
  if (bundle === undefined) throw new UsageError("a bundle file is required");
  return { bundle, ...(extendsPath === undefined ? {} : { extendsPath }), trust, json, openssl };
}

function readBundle(path: string, maxBytes: number): AuditBundleV1 {
  let bytes: Buffer;
  try {
    // The size is checked before the file is read, for plain and gzip files alike.
    const size = statSync(path).size;
    if (size > maxBytes) throw new UsageError(`${path} is larger than ${maxBytes} bytes, more than an export can be`);
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: maxBytes });
    } catch (error) {
      throw new UsageError(`${path} is not a readable gzip file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UsageError(`${path} is not valid JSON`);
  }
  try {
    return parseBundle(parsed);
  } catch (error) {
    if (error instanceof BundleParseError) throw new UsageError(`${path} is not a version 1 audit bundle: ${error.message}`);
    throw error;
  }
}

function loadAnchors(trust: Args["trust"]): Record<string, X509Certificate[]> {
  const merged = new Map<string, X509Certificate[]>(Object.entries(defaultAnchors()));
  for (const { label, path } of trust) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new UsageError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (blocks.length === 0) throw new UsageError(`${path} holds no PEM certificate`);
    const certificates = blocks.map((block) => {
      try {
        return new X509Certificate(block);
      } catch {
        throw new UsageError(`${path} holds a certificate that cannot be read`);
      }
    });
    merged.set(label, [...(merged.get(label) ?? []), ...certificates]);
  }
  // fromEntries defines own properties even for a label such as "__proto__".
  return Object.fromEntries(merged);
}

/**
 * Replaces control, format (including bidirectional overrides), line and paragraph separator
 * characters, so text from a bundle cannot move the cursor, recolor the terminal or reorder a line.
 */
function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?");
}

function statementJson(statement: EpochStatementV1): string {
  return canonicalJson({
    v: statement.v,
    epochId: statement.epochId,
    closedAt: statement.closedAt,
    prevEpochId: statement.prevEpochId,
    prevStatementHash: statement.prevStatementHash,
    sealsRoot: statement.sealsRoot,
    sealCount: statement.sealCount,
  });
}

/** Commands that check each token with OpenSSL alone. Everything printed is validated text. */
function opensslLines(bundle: AuditBundleV1): string[] {
  const lines = [
    "",
    "Checking the timestamps with OpenSSL (each root file is the authority's root certificate that you trust):",
  ];
  const seen = new Set<string>();
  const emit = (statement: EpochStatementV1, tokens: AuditBundleV1["seals"][number]["timestamps"]): void => {
    const digest = statementHash(statement);
    const statementKey = `${statement.epochId}:${digest}`;
    if (!seen.has(statementKey) && tokens.length > 0) {
      seen.add(statementKey);
      lines.push(
        `# epoch ${statement.epochId}: the statement every authority signs the hash of`,
        `printf '%s' '${statementJson(statement)}' | openssl dgst -sha256   # expect ${digest}`,
      );
    }
    for (const entry of tokens) {
      const file = `${statement.epochId}.${entry.tsa}.tst`;
      lines.push(
        `printf '%s' '${entry.token}' | openssl base64 -d -A > ${file}`,
        `openssl ts -verify -digest ${digest} -in ${file} -token_in -CAfile ${entry.tsa}-root.pem`,
      );
    }
  };
  for (const entry of bundle.seals) {
    emit(entry.epoch, entry.timestamps);
    if (entry.coveredBy !== undefined) {
      const covering = entry.coveredBy.epochs[entry.coveredBy.epochs.length - 1];
      if (covering !== undefined) emit(covering, entry.coveredBy.timestamps);
    }
  }
  return lines;
}

function checkLine(entry: BundleCheck): string {
  return `${entry.ok ? "ok  " : "FAIL"} ${entry.name}: ${clean(entry.detail)}`;
}

export function runCli(argv: readonly string[], io: CliIo, options: { maxJsonBytes?: number } = {}): number {
  try {
    return run(argv, io, options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES);
  } catch (error) {
    io.stderr(`unexpected error: ${clean(error instanceof Error ? error.message : String(error))}\n${USAGE}\n`);
    return 2;
  }
}

function run(argv: readonly string[], io: CliIo, maxBytes: number): number {
  let args: Args;
  let bundle: AuditBundleV1;
  let older: AuditBundleV1 | undefined;
  let anchors: Record<string, X509Certificate[]>;
  try {
    args = parseArgs(argv);
    anchors = loadAnchors(args.trust);
    bundle = readBundle(args.bundle, maxBytes);
    if (args.extendsPath !== undefined) older = readBundle(args.extendsPath, maxBytes);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  const report: BundleReport = verifyBundle(bundle, { anchors });
  const checks: BundleCheck[] = [...report.checks];
  if (older !== undefined) {
    const olderReport = verifyBundle(older, { anchors });
    checks.push({
      name: "olderExport",
      ok: olderReport.ok,
      detail: olderReport.ok
        ? `the older export passes its own checks (sealed through record ${olderReport.sealedThroughSeq})`
        : `the older export fails its own checks: ${olderReport.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`,
    });
    const result = verifyExtends(bundle, older);
    checks.push({ name: "extends", ok: result.ok, detail: result.detail });
  }
  const ok = checks.every((entry) => entry.ok);

  if (args.json) {
    io.stdout(`${JSON.stringify({ ...report, ok, checks, limits: AUDIT_LIMITS_COPY }, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  const out: string[] = checks.map(checkLine);
  if (ok) {
    out.push("", report.sealedThroughSeq === 0 ? "No records in this export are sealed yet." : `Sealed and checked through record ${report.sealedThroughSeq}.`);
    out.push(`${report.unsealedCount} newer records are not sealed yet.`);
    if (report.epochsWithoutTimestamp.length > 0) {
      out.push(`No independent timestamp for: ${report.epochsWithoutTimestamp.join(", ")}.`);
    } else if (report.timestampedThrough !== undefined) {
      out.push(`Independent time: no later than ${report.timestampedThrough}.`);
    }
    for (const mode of report.lockModes) {
      out.push(`Sealed copies are locked in ${mode.toLowerCase()} mode.`);
      if (mode === "GOVERNANCE") out.push("In governance mode, a privileged administrator could remove the sealed copies.");
    }
  } else {
    out.push("", `This export did not pass: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}.`);
  }
  for (const label of report.unverifiedAuthorities) {
    out.push(`Tokens from ${label} were not checked: pass --trust ${label}=<pem file> with that authority's root certificate.`);
  }
  if (args.openssl) out.push(...opensslLines(bundle));
  out.push("", AUDIT_LIMITS_COPY);
  io.stdout(`${out.join("\n")}\n`);
  return ok ? 0 : 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}

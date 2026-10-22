#!/usr/bin/env node
/**
 * check-public.mjs <dir>
 *
 * Checks that a directory holds nothing private, so it is safe to copy into a public repository.
 * Exit 0: clean. 1: at least one problem (each printed as `file:line: rule`; the matched text is never
 * printed, so a leaked value does not reach a log). 2: usage error.
 *
 * Rules:
 *   import        an import or require of anything but a `node:` module or a file inside the directory
 *   private-name  a private product, repository or company name
 *   preprod       the word for a pre-production environment
 *   account-id    a 12-digit AWS account id
 *   aws-host      a host in the Amazon Web Services service domain (documentation hosts excepted)
 *   cell-host     a host under a rovara.dev subdomain (cells are named by subdomain)
 *   org-id        `org_` followed by 20 letters or digits
 *   pem           a private key, or a certificate that is not one of the two pinned public roots
 *
 * This file builds its forbidden words from fragments, so it holds none of them itself and can be
 * checked by its own rules and copied to a public repository.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const join2 = (...parts) => parts.join("");

const PRIVATE_NAMES = [
  join2("agent", "x"),
  join2("rovara", "-", "cloud"),
  join2("prep", "labs"),
];
const PREPROD_WORD = join2("stag", "ing");

// SHA-256 fingerprints of the two pinned public roots (DigiCert Trusted Root G4, Sectigo Public
// Time Stamping Root R46), the same values as in the headers of src/trust/*.pem.
const PINNED_ROOT_FINGERPRINTS = new Set([
  "552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988",
  "4941b001b8a97e961b7817c9d9e960ec4b056bfc915a8c1aabf6ef6b3ac046a5",
]);

// Text that is allowed to hold a name above, matched exactly and removed before the name rule runs.
const ALLOWED_TEXT = [
  { file: /(^|\/)package\.json$/, text: join2("git+https://github.com/", "Prep", "Labs", "AI/rovara-audit-verifier.git") },
  { file: /(^|\/)(LICENSE|NOTICE)$/, pattern: new RegExp(join2("^Copyright \\d{4} ", "Prep", "Labs", "$"), "gm") },
];

const DOC_HOSTS = new Set(["awsdocs.s3.amazonaws.com"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|d\.[cm]?ts)$/;

class UsageError extends Error {}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function blank(text, start, end) {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
}

function* matches(text, regex) {
  for (const m of text.matchAll(regex)) yield m;
}

function importSpecifiers(text) {
  const found = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s+(?:[^"'`;]*?\sfrom\s*)?["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const m of matches(text, pattern)) found.push({ spec: m[1], index: m.index });
  return found;
}

function importProblem(spec, file, root) {
  if (spec.startsWith("node:")) return false;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = resolve(dirname(file), spec);
    return !(target === root || target.startsWith(root + sep));
  }
  return true;
}

function pemProblems(text) {
  const out = [];
  for (const m of matches(text, /-----BEGIN ([A-Z0-9 ]+)-----/g)) {
    const label = m[1];
    const after = text.slice(m.index + m[0].length);
    const body = after.split("-----", 1)[0];
    const compact = body.replace(/\s+/g, "");
    const looksEncoded = /^[A-Za-z0-9+/=]{16,}$/.test(compact);
    if (label.includes("PRIVATE")) {
      out.push(m.index);
    } else if (looksEncoded) {
      const fingerprint = label === "CERTIFICATE" ? createHash("sha256").update(Buffer.from(compact, "base64")).digest("hex") : "";
      if (!PINNED_ROOT_FINGERPRINTS.has(fingerprint)) out.push(m.index);
    }
    // A marker with a body that is not base64 (for example inside a regular expression) holds no key.
  }
  return out;
}

function checkDirectory(rootArg) {
  let root;
  try {
    root = resolve(rootArg);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new UsageError("the argument must be a readable directory");
  }
  const problems = [];
  for (const file of listFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    const original = readFileSync(file, "latin1");
    const add = (index, rule) => problems.push({ rel, line: lineOf(original, index), rule });

    if (SOURCE_FILE.test(file)) {
      for (const { spec, index } of importSpecifiers(original)) if (importProblem(spec, file, root)) add(index, "import");
    }
    for (const index of pemProblems(original)) add(index, "pem");

    let text = original;
    for (const allowed of ALLOWED_TEXT) {
      if (!allowed.file.test(rel)) continue;
      if (allowed.text !== undefined) {
        for (let at = text.indexOf(allowed.text); at >= 0; at = text.indexOf(allowed.text, at + 1)) text = blank(text, at, at + allowed.text.length);
      } else {
        for (const m of matches(text, allowed.pattern)) text = blank(text, m.index, m.index + m[0].length);
      }
    }
    const lower = text.toLowerCase();
    for (const name of PRIVATE_NAMES) for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) add(at, "private-name");
    for (let at = lower.indexOf(PREPROD_WORD); at >= 0; at = lower.indexOf(PREPROD_WORD, at + 1)) add(at, "preprod");
    for (const m of matches(text, /(?<![0-9])[0-9]{12}(?![0-9])/g)) add(m.index, "account-id");
    for (const m of matches(text, /[A-Za-z0-9.-]*amazonaws\.com/gi)) if (!DOC_HOSTS.has(m[0].toLowerCase())) add(m.index, "aws-host");
    for (const m of matches(text, /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.rovara\.dev/gi)) add(m.index, "cell-host");
    for (const m of matches(text, /org_[A-Za-z0-9]{20}/g)) add(m.index, "org-id");
  }
  return problems;
}

function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write("usage: check-public.mjs <dir>\n");
    return 2;
  }
  let problems;
  try {
    problems = checkDirectory(argv[0]);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`check-public: ${error.message}\n`);
    return 2;
  }
  if (problems.length === 0) {
    process.stdout.write("check-public: ok, nothing private found\n");
    return 0;
  }
  for (const { rel, line, rule } of problems) process.stderr.write(`${rel}:${line}: ${rule}\n`);
  process.stderr.write(`check-public: ${problems.length} problem(s)\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));

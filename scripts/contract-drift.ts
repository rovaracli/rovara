// Contract drift between Rovara Code and Rovara Cloud. Run with tsx (the contract files import each other as `.js`):
//
//   npx tsx scripts/contract-drift.ts check                                   # pinned snapshot of Code against this repository's schemas (what the test does)
//   npx tsx scripts/contract-drift.ts check --code-ref origin/code/next --code-repo <a Code clone>   # the same against Code's tip, nothing written
//   npx tsx scripts/contract-drift.ts snapshot --code-ref origin/code/next --code-repo <a Code clone>  # refresh the pinned snapshot
//   npx tsx scripts/contract-drift.ts snapshot-text --code-ref origin/code/next --code-repo <a Code clone>   # refresh only the pinned Code sentences (code-text.json)
//   npx tsx scripts/contract-drift.ts snapshot --code-dir <a Code working tree>                         # refresh from files on disk
//   npx tsx scripts/contract-drift.ts check --no-accepted                     # ignore accepted-drift.json: every drift, as on the day the check was added
//   npx tsx scripts/contract-drift.ts accept --why "<reason>" [--except <text in a key>]   # write every current drift into accepted-drift.json (review the diff)
//
// `check` exits 1 when a value Code can send is refused by Cloud's strict schema and the drift is not in tests/fixtures/code-contract-snapshot/accepted-drift.json.
// `check` ALSO runs the text rules (scripts/contract-drift/text-rules.ts): the sentences and constants Code builds that Cloud parses strictly (the setup repair card's sentence, the wiki build and consent words,
// the member refusals). It fails when Code's current text is not one Cloud's parser takes. The text comes from the pinned tests/fixtures/code-contract-snapshot/code-text.json, or from --code-ref/--code-dir.
// Run it against Code's tip before a Code release is installed: `check --code-ref origin/code/next --code-repo <a Code clone>`. A text drift is fixed in Cloud (accept the new text) and shipped BEFORE Code.
import { driftKey, groupDrifts } from "./contract-drift/compare.js";
import { check, exportCode, extractCloud, readAccepted, readSnapshot, writeAccepted, writeSnapshot, type CodeSource, type Snapshot } from "./contract-drift/run.js";
import { codeTextFrom, readPinnedText, textDrifts, writePinnedText } from "./contract-drift/text-rules.js";
import * as zod from "zod";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function codeSource(): CodeSource | undefined {
  const dir = option("code-dir");
  if (dir !== undefined) return { dir };
  const ref = option("code-ref");
  if (ref === undefined) return undefined;
  const repo = option("code-repo") ?? process.env["ROVARA_CODE_REPO"];
  if (repo === undefined) throw new Error("--code-ref needs --code-repo <a clone of Rovara Code> (or ROVARA_CODE_REPO)");
  return { repo, ref };
}

const command = process.argv[2];
const source = codeSource();

if (command === "snapshot") {
  if (source === undefined) throw new Error("snapshot needs --code-ref <ref> --code-repo <clone>, or --code-dir <checkout>");
  const snapshot = await exportCode(source);
  writeSnapshot(snapshot);
  writePinnedText(codeTextFrom(source));
  process.stdout.write(`Wrote tests/fixtures/code-contract-snapshot/code-contracts.json from Code ${snapshot.source.sha} (${snapshot.source.ref}): ${String(Object.keys(snapshot.schemas).length)} schemas, ${String(snapshot.skippedReaders)} forward readers left out.\n`);
} else if (command === "snapshot-text") {
  if (source === undefined) throw new Error("snapshot-text needs --code-ref <ref> --code-repo <clone>, or --code-dir <checkout>");
  const text = codeTextFrom(source);
  writePinnedText(text);
  process.stdout.write(`Wrote tests/fixtures/code-contract-snapshot/code-text.json from Code ${text.source.sha} (${text.source.ref}): ${String(Object.keys(text.values).length)} sentences, ${String(Object.keys(text.unreadable).length)} unreadable.\n`);
} else if (command === "accept") {
  const why = option("why");
  if (why === undefined) throw new Error("accept needs --why <reason>");
  const except = option("except");
  const cloud = await extractCloud(zod as never);
  const result = check(readSnapshot(), cloud, []);
  const keys = result.report.drifts.map(driftKey).filter((key) => except === undefined || !key.includes(except));
  writeAccepted([{ why, keys: [...new Set(keys)].sort() }]);
  process.stdout.write(`Accepted ${String(keys.length)} drifts.\n`);
} else if (command === "check") {
  const code: Snapshot = source === undefined ? readSnapshot() : await exportCode(source);
  const cloud = await extractCloud(zod as never);
  if (cloud.loadErrors.length > 0) throw new Error(`Cloud files did not load:\n${cloud.loadErrors.join("\n")}`);
  const result = check(code, cloud, process.argv.includes("--no-accepted") ? [] : readAccepted());
  process.stdout.write(`Code ${code.source.sha.slice(0, 9)} (${code.source.ref}) against this repository: ${String(result.report.compared)} schemas compared (the ones Cloud parses with), ${String(result.report.onlyInCode.length)} of those only in Code, ${String(result.report.drifts.length)} drifts (${String(result.report.drifts.length - result.unaccepted.length)} accepted).\n`);
  for (const group of groupDrifts(result.unaccepted)) {
    process.stdout.write(`\nDRIFT ${group.kind}: ${group.example.detail}\n  at ${group.example.schema} ${group.example.path}\n  reaches ${String(group.schemas.length)} schema(s): ${group.schemas.slice(0, 6).join(", ")}${group.schemas.length > 6 ? ", ..." : ""}\n`);
  }
  for (const entry of result.staleAccepted) process.stdout.write(`\nSTALE accepted drift (no longer found, remove it): ${entry.key}\n`);
  const text = source === undefined ? readPinnedText() : codeTextFrom(source);
  const textFailures = textDrifts(text);
  process.stdout.write(`\nCode text ${text.source.sha.slice(0, 9)} (${text.source.ref}): ${String(Object.keys(text.values).length)} sentences read, ${String(textFailures.length)} refused by Cloud's strict parsers.\n`);
  for (const failure of textFailures) process.stdout.write(`\n${failure}\n`);
  process.exitCode = result.unaccepted.length > 0 || result.staleAccepted.length > 0 || textFailures.length > 0 ? 1 : 0;
} else {
  process.stderr.write("usage: tsx scripts/contract-drift.ts check|snapshot|snapshot-text|accept [--code-ref <ref> --code-repo <clone> | --code-dir <checkout>]\n");
  process.exitCode = 2;
}

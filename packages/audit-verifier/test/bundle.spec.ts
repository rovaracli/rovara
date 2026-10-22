import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "./support/vitest-lite.js";
import { statementHash, type AuditBundleV1 } from "../src/bundle.js";
import { merkleRoot } from "../src/merkle.js";
import { sealHash, sealLeafData } from "../src/record.js";
import { runCli } from "../src/cli.js";
import { verifyExtends } from "../src/extends.js";
import { AUDIT_LIMITS_COPY } from "../src/limits-copy.js";
import { verifyBundle, type BundleReport } from "../src/verify-bundle.js";
import { makePki } from "./support/fake-tsa.js";
import {
  TSA_LABEL,
  buildAuditFixture,
  cloneBundle,
  closedAtOf,
  epochIdOf,
  flipHex,
  mintToken,
  rechainFrom,
} from "./support/audit-bundle-fixture.js";

const failed = (report: BundleReport): string[] => report.checks.filter((c) => !c.ok).map((c) => c.name);

describe("verifyBundle: a good export", () => {
  const fixture = buildAuditFixture();
  const report = verifyBundle(fixture.bundle, { anchors: fixture.anchors });

  it("passes every check", () => {
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "chain",
      "sealRanges",
      "batchRoot",
      "headHash",
      "prevSealHash",
      "epochs",
      "inclusion",
      "timestamps",
      "coverage",
      "details",
    ]);
  });

  it("reports what is sealed, what is not, the time and the lock mode", () => {
    expect(report.sealedThroughSeq).toBe(35);
    expect(report.unsealedCount).toBe(5);
    expect(report.timestampedThrough).toBe(new Date(closedAtOf(3).getTime() + 90_000).toISOString());
    expect(report.coveredEpochs).toEqual([]);
    expect(report.epochsWithoutTimestamp).toEqual([]);
    expect(report.lockModes).toEqual(["COMPLIANCE"]);
  });

  it("passes for an export that starts after the first seal", () => {
    const partial = buildAuditFixture({ exportFrom: 13 });
    const result = verifyBundle(partial.bundle, { anchors: partial.anchors });
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(partial.bundle.previous.seq).toBe(12);
    expect(partial.bundle.previousSeal?.toSeq).toBe(12);
  });
});

describe("verifyBundle: each tamper fails its named check", () => {
  const run = (change: (bundle: AuditBundleV1) => void, options = {}): BundleReport => {
    const fixture = buildAuditFixture(options);
    const bundle = cloneBundle(fixture.bundle);
    change(bundle);
    return verifyBundle(bundle, { anchors: fixture.anchors });
  };

  it("edited facts fail only the chain", () => {
    const sealed = run((b) => {
      (b.records[4] as { facts: Record<string, unknown> }).facts.role = "owner";
    });
    expect(failed(sealed)).toEqual(["chain"]);
    expect(sealed.ok).toBe(false);
    expect(failed(run((b) => {
      (b.unsealed[2] as { facts: Record<string, unknown> }).facts.role = "owner";
    }))).toEqual(["chain"]);
  });

  it("a deleted record fails only the chain (the seals it touches are not checked, and say so)", () => {
    const report = run((b) => {
      b.records.splice(4, 1);
    });
    expect(failed(report)).toEqual(["chain"]);
    expect(report.checks.find((c) => c.name === "batchRoot")?.detail).toContain("records missing");
  });

  it("swapped records fail only the chain", () => {
    expect(
      failed(
        run((b) => {
          const first = b.records[4] as AuditBundleV1["records"][number];
          b.records[4] = b.records[5] as AuditBundleV1["records"][number];
          b.records[5] = first;
        }),
      ),
    ).toEqual(["chain"]);
  });

  it("a changed batchRoot fails the batch root, and the seal's place in the signed tree", () => {
    // The seal is also a leaf of the timestamped seals root, so an edited seal cannot stay included.
    expect(
      failed(
        run((b) => {
          const last = b.seals[2] as AuditBundleV1["seals"][number];
          last.seal.batchRoot = flipHex(last.seal.batchRoot);
        }),
      ),
    ).toEqual(["batchRoot", "inclusion"]);
  });

  it("a changed headHash fails the head and the seal's place in the signed tree", () => {
    expect(
      failed(
        run((b) => {
          const last = b.seals[2] as AuditBundleV1["seals"][number];
          last.seal.headHash = flipHex(last.seal.headHash);
        }),
      ),
    ).toEqual(["headHash", "inclusion"]);
  });

  it("a flipped inclusion byte fails only inclusion", () => {
    expect(
      failed(
        run((b) => {
          const entry = b.seals[1] as AuditBundleV1["seals"][number];
          entry.inclusion.path[0] = flipHex(entry.inclusion.path[0] as string);
        }),
      ),
    ).toEqual(["inclusion"]);
  });

  it("a token for another statement fails only the timestamps", () => {
    const fixture = buildAuditFixture();
    const bundle = cloneBundle(fixture.bundle);
    const entry = bundle.seals[1] as AuditBundleV1["seals"][number];
    entry.timestamps = [mintToken(fixture.pki, "ab".repeat(32), closedAtOf(2))];
    const report = verifyBundle(bundle, { anchors: fixture.anchors });
    expect(failed(report)).toEqual(["timestamps"]);
    expect(report.epochsWithoutTimestamp).toEqual([epochIdOf(2)]);
  });

  it("a changed sealCount fails the timestamps (the token signed the statement) and the proof size", () => {
    const report = run((b) => {
      (b.seals[0] as AuditBundleV1["seals"][number]).epoch.sealCount += 1;
    });
    expect(failed(report)).toEqual(["inclusion", "timestamps"]);
    expect(report.epochsWithoutTimestamp).toEqual([epochIdOf(1)]);
  });

  it("an edited detail field fails only the details", () => {
    const report = run((b) => {
      const detail = (b.details ?? [])[0] as { fields: Record<string, unknown> };
      detail.fields.email = "mallory@example.test";
    });
    expect(failed(report)).toEqual(["details"]);
  });

  it("a forged previousSeal fails only the link to it", () => {
    const report = run(
      (b) => {
        (b.previousSeal as { batchRoot: string }).batchRoot = "00".repeat(32);
      },
      { exportFrom: 13 },
    );
    expect(failed(report)).toEqual(["prevSealHash"]);
  });

  it("a rewrite that re-chains every later record passes the chain but not the seals", () => {
    const report = run((b) => rechainFrom(b, 5, (record) => void (record.facts.role = "owner")));
    expect(failed(report)).toEqual(["batchRoot", "headHash"]);
  });

  it("dropping the tail of the sealed range is caught by the seal ranges", () => {
    const report = run((b) => {
      b.records.pop();
      b.unsealed.length = 0;
    });
    expect(failed(report)).toContain("sealRanges");
    expect(report.ok).toBe(false);
  });

  it("a seal that is cut out of the middle breaks the link to the next one", () => {
    const report = run((b) => {
      b.seals.splice(1, 1);
    });
    expect(report.ok).toBe(false);
    expect(failed(report)).toEqual(expect.arrayContaining(["sealRanges", "prevSealHash"]));
  });
});

describe("verifyBundle: statements, not epoch ids, carry the time", () => {
  // Rewrite record 25, re-chain, and re-seal 21-35 under a stamped epoch's id with a fresh one-leaf
  // statement and no token. Keyed by epoch id alone, the forged statement inherited epoch 2's time.
  const forge = () => {
    const fixture = buildAuditFixture();
    const bundle = cloneBundle(fixture.bundle);
    rechainFrom(bundle, 25, (record) => void (record.facts.forged = "yes"));
    const second = bundle.seals[1] as AuditBundleV1["seals"][number];
    const third = bundle.seals[2] as AuditBundleV1["seals"][number];
    const range = [...bundle.records, ...bundle.unsealed].filter((r) => r.seq >= 21 && r.seq <= 35);
    const seal = {
      ...third.seal,
      epochId: second.epoch.epochId,
      batchRoot: merkleRoot(range.map((r) => Uint8Array.from(Buffer.from(r.hash, "hex")))),
      headHash: (range[range.length - 1] as { hash: string }).hash,
      prevSealHash: sealHash(second.seal),
    };
    third.seal = seal;
    third.epoch = { ...second.epoch, sealsRoot: merkleRoot([sealLeafData(seal)]), sealCount: 1 };
    third.inclusion = { index: 0, size: 1, path: [] };
    third.timestamps = [];
    delete third.coveredBy;
    return { fixture, bundle };
  };

  it("does not let a forged statement reuse a stamped epoch's id and time", () => {
    const { fixture, bundle } = forge();
    const report = verifyBundle(bundle, { anchors: fixture.anchors });
    expect(report.ok).toBe(false);
    expect(failed(report)).toEqual(["epochs"]);
    expect(report.epochsWithoutTimestamp).toEqual([epochIdOf(2)]);
  });

  it("fails when epoch ids go backwards across seals", () => {
    const fixture = buildAuditFixture();
    const bundle = cloneBundle(fixture.bundle);
    (bundle.seals[2] as AuditBundleV1["seals"][number]).epoch.epochId = epochIdOf(1);
    expect(failed(verifyBundle(bundle, { anchors: fixture.anchors }))).toContain("epochs");
  });

  it("fails when closedAt goes backwards across seals", () => {
    const fixture = buildAuditFixture();
    const bundle = cloneBundle(fixture.bundle);
    (bundle.seals[2] as AuditBundleV1["seals"][number]).epoch.closedAt = closedAtOf(1).toISOString();
    expect(failed(verifyBundle(bundle, { anchors: fixture.anchors }))).toContain("epochs");
  });

  it("fails when the proof is for a tree of another size or position than the epoch's seal count", () => {
    const fixture = buildAuditFixture();
    const bundle = cloneBundle(fixture.bundle);
    (bundle.seals[0] as AuditBundleV1["seals"][number]).inclusion.size = 3;
    expect(failed(verifyBundle(bundle, { anchors: fixture.anchors }))).toContain("inclusion");
    const outside = cloneBundle(fixture.bundle);
    (outside.seals[0] as AuditBundleV1["seals"][number]).inclusion.index = 2;
    expect(failed(verifyBundle(outside, { anchors: fixture.anchors }))).toContain("inclusion");
  });

  it("reports the authorities whose tokens it could not check", () => {
    const fixture = buildAuditFixture();
    expect(verifyBundle(fixture.bundle, { anchors: {} }).unverifiedAuthorities).toEqual([TSA_LABEL]);
    expect(verifyBundle(fixture.bundle, { anchors: fixture.anchors }).unverifiedAuthorities).toEqual([]);
  });
});

describe("verifyBundle: timestamps", () => {
  it("accepts a token exactly 5 minutes before the last record and refuses one millisecond earlier", () => {
    const base = buildAuditFixture();
    const lastRecordedAt = Date.parse((base.bundle.records[19] as { recordedAt: string }).recordedAt);
    const at = (genTime: number) => {
      const fixture = buildAuditFixture({
        genTimeFor: (epoch, closedAt) => (epoch === 2 ? new Date(genTime) : new Date(closedAt.getTime() + 90_000)),
      });
      return verifyBundle(fixture.bundle, { anchors: fixture.anchors });
    };
    expect(at(lastRecordedAt - 5 * 60_000).ok).toBe(true);
    const early = at(lastRecordedAt - 5 * 60_000 - 1);
    expect(failed(early)).toEqual(["timestamps"]);
    expect(early.checks.find((c) => c.name === "timestamps")?.detail).toContain("5 minutes");
  });

  it("never trusts a certificate that only the bundle supplies", () => {
    const fixture = buildAuditFixture();
    const other = makePki("Elsewhere");
    const report = verifyBundle(fixture.bundle, { anchors: { [TSA_LABEL]: [other.root.x509] } });
    expect(failed(report)).toEqual(["timestamps"]);
  });

  it("reports, without failing, a token whose authority has no trusted root", () => {
    const fixture = buildAuditFixture();
    const report = verifyBundle(fixture.bundle, { anchors: {} });
    expect(report.ok).toBe(true);
    expect(report.epochsWithoutTimestamp).toEqual([epochIdOf(1), epochIdOf(2), epochIdOf(3)]);
    expect(report.timestampedThrough).toBeUndefined();
  });

  it("looks labels up as own properties only", () => {
    const fixture = buildAuditFixture();
    const bundle = cloneBundle(fixture.bundle);
    for (const entry of bundle.seals) for (const stamp of entry.timestamps) stamp.tsa = "__proto__";
    const report = verifyBundle(bundle, { anchors: fixture.anchors });
    expect(report.ok).toBe(true);
    expect(report.epochsWithoutTimestamp).toHaveLength(3);
  });

  it("lists epochs with no token and no cover without failing", () => {
    const fixture = buildAuditFixture({ stamped: [1, 2] });
    const report = verifyBundle(fixture.bundle, { anchors: fixture.anchors });
    expect(report.ok).toBe(true);
    expect(report.epochsWithoutTimestamp).toEqual([epochIdOf(3)]);
    expect(report.timestampedThrough).toBe(new Date(closedAtOf(2).getTime() + 90_000).toISOString());
  });
});

describe("verifyBundle: coverage", () => {
  it("covers epoch 2, which has no token, by epoch 3's", () => {
    const fixture = buildAuditFixture({ stamped: [1, 3] });
    expect((fixture.bundle.seals[1] as AuditBundleV1["seals"][number]).timestamps).toEqual([]);
    const report = verifyBundle(fixture.bundle, { anchors: fixture.anchors });
    expect(report.ok).toBe(true);
    expect(report.coveredEpochs).toEqual([epochIdOf(2)]);
    expect(report.epochsWithoutTimestamp).toEqual([]);
  });

  it("covers through two hops when only the last epoch is stamped", () => {
    const fixture = buildAuditFixture({ stamped: [3] });
    const report = verifyBundle(fixture.bundle, { anchors: fixture.anchors });
    expect(report.ok).toBe(true);
    expect(report.coveredEpochs).toEqual([epochIdOf(1), epochIdOf(2)]);
  });

  it("a broken prevStatementHash in coveredBy fails the coverage", () => {
    const fixture = buildAuditFixture({ stamped: [1, 3] });
    const bundle = cloneBundle(fixture.bundle);
    const covering = (bundle.seals[1] as AuditBundleV1["seals"][number]).coveredBy?.epochs[0];
    (covering as { prevStatementHash: string }).prevStatementHash = "00".repeat(32);
    const report = verifyBundle(bundle, { anchors: fixture.anchors });
    expect(failed(report)).toEqual(["coverage"]);
    expect(report.coveredEpochs).toEqual([]);
    expect(report.epochsWithoutTimestamp).toEqual([epochIdOf(2)]);
  });

  it("a broken second hop fails the coverage", () => {
    const fixture = buildAuditFixture({ stamped: [3] });
    const bundle = cloneBundle(fixture.bundle);
    const hops = (bundle.seals[0] as AuditBundleV1["seals"][number]).coveredBy?.epochs;
    (hops?.[1] as { prevStatementHash: string }).prevStatementHash = statementHash(bundle.seals[2]?.epoch as never);
    expect(failed(verifyBundle(bundle, { anchors: fixture.anchors }))).toEqual(["coverage"]);
  });

  it("a covering token for another statement fails the coverage", () => {
    const fixture = buildAuditFixture({ stamped: [1, 3] });
    const bundle = cloneBundle(fixture.bundle);
    const cover = (bundle.seals[1] as AuditBundleV1["seals"][number]).coveredBy;
    (cover as { timestamps: unknown }).timestamps = [mintToken(fixture.pki, "cd".repeat(32), closedAtOf(3))];
    expect(failed(verifyBundle(bundle, { anchors: fixture.anchors }))).toEqual(["coverage"]);
  });
});

describe("verifyExtends", () => {
  const first = buildAuditFixture({ recordsA: 22, sealsA: [{ epoch: 1, toSeq: 12 }, { epoch: 2, toSeq: 20 }] });
  const second = buildAuditFixture();

  it("accepts an export that keeps the older one's history", () => {
    expect(verifyBundle(first.bundle, { anchors: first.anchors }).sealedThroughSeq).toBe(20);
    expect(verifyExtends(second.bundle, first.bundle)).toMatchObject({ ok: true });
  });

  it("names seq 20 when records 10 to 20 were rewritten and re-sealed", () => {
    const rewritten = buildAuditFixture({ rewrite: { from: 10, to: 20 } });
    // It is a consistent export on its own, which is the point of the check.
    expect(verifyBundle(rewritten.bundle, { anchors: rewritten.anchors }).ok).toBe(true);
    const result = verifyExtends(rewritten.bundle, first.bundle);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("seq 20");
  });

  it("refuses a newer export sealed less far, another organization, and a re-sealed head with the same record", () => {
    const behind = verifyExtends(first.bundle, second.bundle);
    expect(behind.ok).toBe(false);
    expect(behind.detail).toContain("seq 20");
    const foreign = cloneBundle(second.bundle);
    foreign.orgId = "org-z";
    expect(verifyExtends(foreign, first.bundle).ok).toBe(false);
    const resealed = cloneBundle(second.bundle);
    (resealed.seals[1] as AuditBundleV1["seals"][number]).seal.epochId = epochIdOf(3);
    const sealResult = verifyExtends(resealed, first.bundle);
    expect(sealResult.ok).toBe(false);
    expect(sealResult.detail).toContain("seq 20");
  });

  it("finds the anchor in a newer export that starts after it", () => {
    const later = buildAuditFixture({ exportFrom: 21 });
    expect(verifyExtends(later.bundle, first.bundle)).toMatchObject({ ok: true });
  });
});

describe("rovara-audit-verify", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-bundle-"));
  const fixture = buildAuditFixture();
  const rootPem = join(dir, "root.pem");
  writeFileSync(rootPem, fixture.pki.root.x509.toString());
  const write = (name: string, value: unknown, gzip = false): string => {
    const path = join(dir, name);
    const text = JSON.stringify(value);
    writeFileSync(path, gzip ? gzipSync(text) : text);
    return path;
  };
  const cli = (...argv: string[]): { code: number; out: string; err: string } => {
    let out = "";
    let err = "";
    const code = runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t) });
    return { code, out, err };
  };
  const trust = ["--trust", `${TSA_LABEL}=${rootPem}`];

  it("prints each check, the summary sentences and its own limits, and exits 0", () => {
    const result = cli(write("good.json", fixture.bundle), ...trust);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ok   chain:");
    expect(result.out).toContain("Sealed and checked through record 35.");
    expect(result.out).toContain("5 newer records are not sealed yet.");
    expect(result.out).toContain(`Independent time: no later than ${new Date(closedAtOf(3).getTime() + 90_000).toISOString()}.`);
    expect(result.out).toContain("Sealed copies are locked in compliance mode.");
    expect(result.out).not.toContain("governance");
    expect(result.out.endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("ignores a limits field in the bundle", () => {
    const result = cli(write("limits.json", { ...fixture.bundle, limits: "Rovara guarantees every record is true." }), ...trust);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("guarantees");
    expect(result.out.endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("prints the governance sentence for governance-locked copies", () => {
    const governance = buildAuditFixture({ lockMode: "GOVERNANCE" });
    const result = cli(write("gov.json", governance.bundle), ...trust);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Sealed copies are locked in governance mode.");
    expect(result.out).toContain("In governance mode, a privileged administrator could remove the sealed copies.");
  });

  it("names the epochs with no independent timestamp", () => {
    const partial = buildAuditFixture({ stamped: [1, 2] });
    const result = cli(write("partial.json", partial.bundle), ...trust);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`No independent timestamp for: ${epochIdOf(3)}.`);
    expect(result.out).not.toContain("Independent time:");
  });

  it("reads gzip", () => {
    const result = cli(write("good.json.gz", fixture.bundle, true), ...trust);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Sealed and checked through record 35.");
  });

  it("exits 1 when a check fails, without claiming the export is sealed", () => {
    const bad = cloneBundle(fixture.bundle);
    (bad.records[2] as { facts: Record<string, unknown> }).facts.role = "owner";
    const result = cli(write("bad.json", bad), ...trust);
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL chain:");
    expect(result.out).toContain("This export did not pass: chain.");
    expect(result.out).not.toContain("Sealed and checked");
    expect(result.out.endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("does not trust the bundle's own certificates: without --trust the test authority is unknown", () => {
    const result = cli(write("good.json", fixture.bundle));
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAIL timestamps:");
    expect(result.out).toContain("untrusted");
  });

  it("exits 2 for usage and parse errors", () => {
    const good = write("good.json", fixture.bundle);
    expect(cli().code).toBe(2);
    expect(cli(good, "--nope").code).toBe(2);
    expect(cli(good, "--extends").code).toBe(2);
    expect(cli(good, "--trust", "nolabel").code).toBe(2);
    expect(cli(good, "--trust", `x=${join(dir, "missing.pem")}`).code).toBe(2);
    expect(cli(join(dir, "missing.json")).code).toBe(2);
    const notJson = join(dir, "notjson.json");
    writeFileSync(notJson, "{ nope");
    expect(cli(notJson).code).toBe(2);
    expect(cli(write("shape.json", { format: "other", v: 1 })).code).toBe(2);
    expect(cli(write("shape2.json", { ...fixture.bundle, records: "no" })).code).toBe(2);
    const bad = cli(write("shape.json", { format: "other", v: 1 }));
    expect(bad.err).toContain("usage:");
    expect(bad.out).toBe("");
  });

  it("--extends passes for a continued history and fails naming seq 20 for a rewrite", () => {
    const first = buildAuditFixture({ recordsA: 22, sealsA: [{ epoch: 1, toSeq: 12 }, { epoch: 2, toSeq: 20 }] });
    const older = write("older.json", first.bundle);
    const ok = cli(write("newer.json", fixture.bundle), "--extends", older, ...trust);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("ok   extends:");
    const rewritten = buildAuditFixture({ rewrite: { from: 10, to: 20 } });
    const bad = cli(write("rewritten.json", rewritten.bundle), "--extends", older, ...trust);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/FAIL extends: .*seq 20/);
  });

  it("--json prints the report with the built-in limits", () => {
    const result = cli(write("good.json", fixture.bundle), "--json", ...trust);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as { ok: boolean; sealedThroughSeq: number; limits: string };
    expect(parsed).toMatchObject({ ok: true, sealedThroughSeq: 35, limits: AUDIT_LIMITS_COPY });
  });

  it("--print-openssl prints a verify command for each token", () => {
    const result = cli(write("good.json", fixture.bundle), "--print-openssl", ...trust);
    expect(result.out).toContain(`openssl ts -verify -digest ${statementHash(fixture.statements[0] as never)} -in ${epochIdOf(1)}.${TSA_LABEL}.tst -token_in -CAfile ${TSA_LABEL}-root.pem`);
    expect(result.out.match(/openssl ts -verify/g)).toHaveLength(3);
    expect(result.out.endsWith(`${AUDIT_LIMITS_COPY}\n`)).toBe(true);
  });

  it("--extends fails when the forged-id re-seal is checked: the verifier does not print an independent time", () => {
    const forged = cloneBundle(fixture.bundle);
    (forged.seals[2] as AuditBundleV1["seals"][number]).epoch.epochId = epochIdOf(2);
    const result = cli(write("forgedid.json", forged), ...trust);
    expect(result.code).toBe(1);
    expect(result.out).not.toContain("Independent time:");
  });

  it("says how to check tokens from an authority it has no root for", () => {
    const customer = cloneBundle(fixture.bundle);
    for (const entry of customer.seals) for (const stamp of entry.timestamps) stamp.tsa = "acme";
    const result = cli(write("customer.json", customer));
    expect(result.code).toBe(0);
    expect(result.out).toContain("Tokens from acme were not checked: pass --trust acme=<pem file>");
    expect(result.out).toContain("No independent timestamp for:");
  });

  it("does not say records are sealed when none are", () => {
    const none = buildAuditFixture({ recordsA: 5, sealsA: [] });
    const result = cli(write("none.json", none.bundle), ...trust);
    expect(result.code).toBe(0);
    expect(result.out).toContain("No records in this export are sealed yet.");
    expect(result.out).toContain("5 newer records are not sealed yet.");
    expect(result.out).not.toContain("Sealed and checked through record 0");
  });

  it("strips bidirectional and other format characters from bundle text", () => {
    const bad = cloneBundle(fixture.bundle);
    bad.details = [{ seq: 7, subject: "a\u202eb\u200fc\u2066d", salt: "00112233445566778899aabbccddeeff", fields: {} }];
    const result = cli(write("bidi.json", bad), ...trust);
    expect(result.out).toContain("a?b?c?d");
    expect(result.out).not.toMatch(/[\u202a-\u202e\u200e\u200f\u2066-\u2069]/);
  });

  it("refuses a file or a gzip expansion larger than the cap, with exit 2", () => {
    const plain = write("big.json", fixture.bundle);
    const zipped = write("big.json.gz", fixture.bundle, true);
    const cap = statSync(zipped).size + 100;
    expect(statSync(plain).size).toBeGreaterThan(cap);
    const run = (path: string) => {
      let err = "";
      const code = runCli([path, ...trust], { stdout: () => undefined, stderr: (t) => (err += t) }, { maxJsonBytes: cap });
      return { code, err };
    };
    expect(run(plain)).toMatchObject({ code: 2 });
    expect(run(plain).err).toContain("larger than");
    expect(run(zipped)).toMatchObject({ code: 2 });
    expect(run(zipped).err).toContain("gzip");
  });

  it("maps an unexpected failure to exit 2 with a message", () => {
    let err = "";
    const code = runCli([write("good.json", fixture.bundle), ...trust], {
      stdout: () => {
        throw new Error("disk full");
      },
      stderr: (t) => (err += t),
    });
    expect(code).toBe(2);
    expect(err).toContain("unexpected error: disk full");
  });

  it("strips control characters from text taken from a bundle", () => {
    const bad = cloneBundle(fixture.bundle);
    bad.details = [{ seq: 7, subject: "x\u001b[2Jy", salt: "00112233445566778899aabbccddeeff", fields: {} }];
    const result = cli(write("evil.json", bad), ...trust);
    expect(result.code).toBe(1);
    expect(result.out).toContain("x?[2Jy");
    expect(result.out).not.toContain("\u001b");
  });
});

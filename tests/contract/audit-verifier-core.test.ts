import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUDIT_LIMITS_COPY,
  canonicalJson,
  checkChain,
  detailCommit,
  genesisHash,
  inclusionPath,
  leafHash,
  merkleRoot,
  nodeHash,
  recordHash,
  recordLeafData,
  sealHash,
  sealLeafData,
  sha256Hex,
  verifyInclusion,
  type AuditRecordV1,
  type JsonValue,
  type OrgSealV1,
} from "../../packages/audit-verifier/src/index.js";

const PACKAGE_DIR = new URL("../../packages/audit-verifier/", import.meta.url);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const ORG = "org_0001";

describe("canonicalJson (RFC 8785 subset)", () => {
  it("sorts keys, drops whitespace and keeps strings as JSON.stringify writes them", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "é"] })).toBe('{"a":[true,null,"é"],"b":1}');
    expect(canonicalJson("line\n\u0001\"\\")).toBe('"line\\n\\u0001\\"\\\\"');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("sorts keys by UTF-16 code units", () => {
    expect(canonicalJson({ é: 1, a: 2, B: 3 })).toBe('{"B":3,"a":2,"é":1}');
    // U+1F600 is the surrogate pair D83D DE00, so it sorts before U+FF5E (RFC 8785 3.2.3).
    expect(canonicalJson({ "～": 1, "\u{1F600}": 2 })).toBe('{"😀":2,"～":1}');
  });

  it("writes safe integers in plain decimal and -0 as 0", () => {
    expect(canonicalJson([0, -0, -7, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])).toBe(
      "[0,0,-7,9007199254740991,-9007199254740991]",
    );
  });

  it("refuses everything but safe integers with the exact RangeError", () => {
    for (const bad of [1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => canonicalJson(bad)).toThrow(new RangeError("audit json: only safe integers"));
    }
    expect(() => canonicalJson({ nested: [1, { deep: 0.1 }] })).toThrow(RangeError);
  });

  it("throws on undefined and other values JSON cannot hold", () => {
    expect(() => canonicalJson(undefined as unknown as JsonValue)).toThrow();
    expect(() => canonicalJson({ a: undefined } as unknown as JsonValue)).toThrow();
    expect(() => canonicalJson([undefined] as unknown as JsonValue)).toThrow();
    expect(() => canonicalJson(Array(2) as unknown as JsonValue)).toThrow();
    expect(() => canonicalJson(10n as unknown as JsonValue)).toThrow();
    expect(() => canonicalJson(new Date(0) as unknown as JsonValue)).toThrow();
    expect(() => canonicalJson(new Map() as unknown as JsonValue)).toThrow();
  });
});

describe("sha256Hex", () => {
  it("hashes strings as UTF-8 and bytes as given", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("é"))).toBe(sha256Hex("é"));
  });
});

// A fixed record. The pinned hashes below were computed once with
// `openssl dgst -sha256` over the prefixed canonical bytes written out by hand,
// so they do not depend on canonicalJson.
const PINNED_GENESIS = "a2f74e119b231b59000f7aa4bff4dd4e031f3e9cc2446eae8229f4eb65e1adfd";
const PINNED_RECORD_HASH = "4762fb884db7f536d24faa8aa75a2a58760b92816b2628dbe2402bf3a20c8a2d";
const PINNED_SEAL_HASH = "0a956bf4a35a0e4a8517c489be08b40d4eca3fbd71f9734c815c49790fa5af94";

const FIXED_BODY: Omit<AuditRecordV1, "hash"> = {
  v: 1,
  orgId: ORG,
  seq: 1,
  eventId: `aev_${"ab".repeat(20)}`,
  action: "approval.decided",
  actor: { kind: "member", id: "mem_1" },
  target: { kind: "approval", id: "apr_1" },
  occurredAt: "2026-10-20T12:00:00.000Z",
  recordedAt: "2026-10-20T12:00:01.000Z",
  related: ["prj_1"],
  facts: { kind: "write", decision: "approved", class: "standard" },
  proof: { kind: "fresh_sign_in", method: "password", authTime: "2026-10-20T11:59:00.000Z" },
  details: [{ subject: "sub_1", commit: "cd".repeat(32) }],
  prevHash: PINNED_GENESIS,
};

const FIXED_SEAL: OrgSealV1 = {
  v: 1,
  orgId: ORG,
  fromSeq: 1,
  toSeq: 1,
  batchRoot: "ab".repeat(32),
  headHash: "cd".repeat(32),
  prevSealHash: PINNED_GENESIS,
  epochId: "e20261020T1215Z",
};

describe("record and seal hashes", () => {
  it("genesisHash and recordHash and sealHash equal their pinned openssl values", () => {
    expect(genesisHash(ORG)).toBe(PINNED_GENESIS);
    expect(recordHash(FIXED_BODY)).toBe(PINNED_RECORD_HASH);
    expect(sealHash(FIXED_SEAL)).toBe(PINNED_SEAL_HASH);
  });

  it("recordHash ignores an existing hash field", () => {
    expect(recordHash({ ...FIXED_BODY, hash: "ff".repeat(32) })).toBe(PINNED_RECORD_HASH);
  });

  it("writes the optional proof only when present", () => {
    const withoutProof: Omit<AuditRecordV1, "hash"> = { ...FIXED_BODY };
    delete withoutProof.proof;
    expect(recordHash(withoutProof)).not.toBe(PINNED_RECORD_HASH);
    expect(canonicalJson(withoutProof)).not.toContain("proof");
  });

  it("a seal and a record with identical canonical bodies hash differently", () => {
    const body = { ...FIXED_SEAL } as unknown as AuditRecordV1;
    const canonical = canonicalJson(FIXED_SEAL);
    expect(recordHash(body)).toBe(sha256Hex(`rovara-audit-record-v1\n${canonical}`));
    expect(sealHash(FIXED_SEAL)).toBe(sha256Hex(`rovara-audit-seal-v1\n${canonical}`));
    expect(recordHash(body)).not.toBe(sealHash(FIXED_SEAL));
    expect(genesisHash(ORG)).not.toBe(sha256Hex(ORG));
  });
});

describe("detailCommit", () => {
  it("is sha256(salt || utf8(canonical {subject, fields}))", () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    const fields = { name: "Ada", n: 2 };
    const expected = createHash("sha256")
      .update(salt)
      .update('{"fields":{"n":2,"name":"Ada"},"subject":"sub_1"}', "utf8")
      .digest("hex");
    expect(detailCommit(salt, "sub_1", fields)).toBe(expected);
    expect(detailCommit(Uint8Array.from([...salt].reverse()), "sub_1", fields)).not.toBe(expected);
    expect(detailCommit(salt, "sub_2", fields)).not.toBe(expected);
    expect(detailCommit(salt, "sub_1", { ...fields, n: 3 })).not.toBe(expected);
  });
});

function makeChain(count: number, orgId = ORG): AuditRecordV1[] {
  const records: AuditRecordV1[] = [];
  let prevHash = genesisHash(orgId);
  for (let seq = 1; seq <= count; seq++) {
    const body: Omit<AuditRecordV1, "hash"> = {
      ...FIXED_BODY,
      orgId,
      seq,
      eventId: `aev_${seq.toString(16).padStart(40, "0")}`,
      facts: { kind: "write", step: seq },
      prevHash,
    };
    const record = { ...body, hash: recordHash(body) };
    records.push(record);
    prevHash = record.hash;
  }
  return records;
}

describe("checkChain", () => {
  const start = { seq: 0, hash: genesisHash(ORG) };

  it("accepts a valid chain, an empty one, and one continuing a previous record", () => {
    const chain = makeChain(5);
    expect(checkChain(chain, start)).toEqual({ ok: true });
    expect(checkChain([], start)).toEqual({ ok: true });
    expect(checkChain(chain.slice(2), { seq: 2, hash: chain[1]!.hash })).toEqual({ ok: true });
  });

  it("reports an edited record as hash", () => {
    const chain = makeChain(5);
    chain[2] = { ...chain[2]!, facts: { kind: "write", step: 99 } };
    expect(checkChain(chain, start)).toEqual({ ok: false, seq: 3, problem: "hash" });
  });

  it("reports a removed record as gap", () => {
    const chain = makeChain(5);
    chain.splice(2, 1);
    expect(checkChain(chain, start)).toEqual({ ok: false, seq: 4, problem: "gap" });
  });

  it("reports a removed first record and a wrong starting point as gap", () => {
    const chain = makeChain(5);
    expect(checkChain(chain.slice(1), start)).toEqual({ ok: false, seq: 2, problem: "gap" });
  });

  it("reports swapped records as gap", () => {
    const chain = makeChain(5);
    [chain[1], chain[2]] = [chain[2]!, chain[1]!];
    expect(checkChain(chain, start)).toEqual({ ok: false, seq: 3, problem: "gap" });
  });

  it("reports a record of another org as org", () => {
    const chain = makeChain(5);
    const foreign = makeChain(5, "org_0002")[2]!;
    chain[2] = foreign;
    expect(checkChain(chain, start)).toEqual({ ok: false, seq: 3, problem: "org" });
    expect(checkChain(makeChain(3, "org_0002"), { ...start, orgId: ORG })).toEqual({
      ok: false,
      seq: 1,
      problem: "org",
    });
  });

  it("reports a wrong prevHash as link", () => {
    const chain = makeChain(5);
    const body = { ...chain[3]!, prevHash: "00".repeat(32) };
    chain[3] = { ...body, hash: recordHash(body) };
    expect(checkChain(chain, start)).toEqual({ ok: false, seq: 4, problem: "link" });
    expect(checkChain(makeChain(2), { seq: 0, hash: "00".repeat(32) })).toEqual({
      ok: false,
      seq: 1,
      problem: "link",
    });
  });
});

// Leaves and roots from the Certificate Transparency reference implementation
// (merkle_tree_test.cc); the roots for 1 to 8 leaves are the RFC 6962 values RFC 9162 keeps.
const CT_LEAVES = [
  "",
  "00",
  "10",
  "2021",
  "3031",
  "40414243",
  "5051525354555657",
  "606162636465666768696a6b6c6d6e6f",
].map((h) => Buffer.from(h, "hex"));
const CT_EMPTY_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const CT_ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

// RFC 9162 2.1.1, written straight from the definition and sharing no code with the package.
function referenceMth(leaves: readonly Buffer[]): Buffer {
  const sha = (...parts: Buffer[]): Buffer => createHash("sha256").update(Buffer.concat(parts)).digest();
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return sha(Buffer.from([0]), leaves[0]!);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha(Buffer.from([1]), referenceMth(leaves.slice(0, k)), referenceMth(leaves.slice(k)));
}

// RFC 9162 2.1.3.1.
function referencePath(index: number, leaves: readonly Buffer[]): Buffer[] {
  if (leaves.length <= 1) return [];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return index < k
    ? [...referencePath(index, leaves.slice(0, k)), referenceMth(leaves.slice(k))]
    : [...referencePath(index - k, leaves.slice(k)), referenceMth(leaves.slice(0, k))];
}

function leavesOfSize(size: number): Buffer[] {
  return Array.from({ length: size }, (_, i) => Buffer.from(`leaf-${i}`, "utf8"));
}

describe("RFC 9162 Merkle trees", () => {
  it("hashes leaves with 0x00 and nodes with 0x01", () => {
    expect(hex(leafHash(Buffer.alloc(0)))).toBe(CT_ROOTS[0]);
    expect(hex(leafHash(Buffer.from("x")))).toBe(sha256Hex(Buffer.concat([Buffer.from([0]), Buffer.from("x")])));
    const l = leafHash(Buffer.from("l"));
    const r = leafHash(Buffer.from("r"));
    expect(hex(nodeHash(l, r))).toBe(sha256Hex(Buffer.concat([Buffer.from([1]), l, r])));
  });

  it("the empty tree's root is the hash of the empty string", () => {
    expect(merkleRoot([])).toBe(CT_EMPTY_ROOT);
  });

  it.each(CT_ROOTS.map((root, i) => [i + 1, root] as const))(
    "matches the Certificate Transparency root for %i leaves",
    (size, root) => {
      expect(merkleRoot(CT_LEAVES.slice(0, size))).toBe(root);
    },
  );

  it("agrees with the RFC 9162 definition for sizes 1 to 33", () => {
    for (let size = 1; size <= 33; size++) {
      const leaves = leavesOfSize(size);
      expect(merkleRoot(leaves)).toBe(referenceMth(leaves).toString("hex"));
    }
  });

  it("builds the RFC 9162 inclusion path and verifies every leaf of sizes 1 to 33", () => {
    for (let size = 1; size <= 33; size++) {
      const leaves = leavesOfSize(size);
      const root = merkleRoot(leaves);
      for (let index = 0; index < size; index++) {
        const path = inclusionPath(leaves, index);
        expect(path).toEqual(referencePath(index, leaves).map((h) => h.toString("hex")));
        expect(verifyInclusion({ leafData: leaves[index]!, index, size, path, root })).toBe(true);
      }
    }
  });

  it("verifies against the Certificate Transparency leaves", () => {
    for (let size = 1; size <= 8; size++) {
      for (let index = 0; index < size; index++) {
        expect(
          verifyInclusion({
            leafData: CT_LEAVES[index]!,
            index,
            size,
            path: inclusionPath(CT_LEAVES.slice(0, size), index),
            root: CT_ROOTS[size - 1]!,
          }),
        ).toBe(true);
      }
    }
  });

  it("rejects a flipped byte, a wrong index or size, a wrong leaf, root or path", () => {
    const size = 13;
    const leaves = leavesOfSize(size);
    const root = merkleRoot(leaves);
    const index = 5;
    const path = inclusionPath(leaves, index);
    const good = { leafData: leaves[index]!, index, size, path, root };
    expect(verifyInclusion(good)).toBe(true);

    const flip = (hexString: string): string =>
      (parseInt(hexString.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0") + hexString.slice(2);
    for (let i = 0; i < path.length; i++) {
      expect(verifyInclusion({ ...good, path: path.map((p, j) => (j === i ? flip(p) : p)) })).toBe(false);
    }
    expect(verifyInclusion({ ...good, root: flip(root) })).toBe(false);
    const flippedLeaf = Buffer.from(leaves[index]!);
    flippedLeaf[0] = flippedLeaf[0]! ^ 1;
    expect(verifyInclusion({ ...good, leafData: flippedLeaf })).toBe(false);
    expect(verifyInclusion({ ...good, leafData: leaves[index + 1]! })).toBe(false);
    for (const wrongIndex of [0, 4, 6, 12, 13, 14, -1, 1.5]) {
      expect(verifyInclusion({ ...good, index: wrongIndex })).toBe(false);
    }
    // Sizes 9 to 16 give index 5 the same path shape, so they are told apart by the root alone
    // (which commits to the size); every size that changes the shape fails here.
    for (const wrongSize of [0, 1, 5, 6, 7, 8, 17, 100, 2 ** 40, -3, 13.5]) {
      expect(verifyInclusion({ ...good, size: wrongSize })).toBe(false);
    }
    expect(verifyInclusion({ ...good, size: 14, root: merkleRoot(leavesOfSize(14)) })).toBe(false);
    expect(verifyInclusion({ ...good, path: path.slice(1) })).toBe(false);
    expect(verifyInclusion({ ...good, path: [...path, "00".repeat(32)] })).toBe(false);
    expect(verifyInclusion({ ...good, path: path.map(() => "zz") })).toBe(false);
  });

  it("does not let an interior node pass as a leaf (the 0x00 and 0x01 prefixes)", () => {
    const leaves = leavesOfSize(4);
    const root = merkleRoot(leaves);
    const h = leaves.map((l) => leafHash(l));
    // The two-leaf tree whose second leaf is the real right half, and whose first "leaf" is h0 || h1.
    const forgedPath = [hex(nodeHash(h[2]!, h[3]!))];
    expect(
      verifyInclusion({ leafData: Buffer.concat([h[0]!, h[1]!]), index: 0, size: 2, path: forgedPath, root }),
    ).toBe(false);
  });

  it("refuses an index outside the tree", () => {
    expect(() => inclusionPath(leavesOfSize(3), 3)).toThrow(RangeError);
    expect(() => inclusionPath(leavesOfSize(3), -1)).toThrow(RangeError);
    expect(() => inclusionPath([], 0)).toThrow(RangeError);
  });

  it("uses 32-byte record hashes and the canonical seal as the two leaf kinds", () => {
    const chain = makeChain(4);
    const leaves = recordLeafData(chain);
    expect(leaves.map((l) => l.length)).toEqual([32, 32, 32, 32]);
    expect(hex(leaves[1]!)).toBe(chain[1]!.hash);
    expect(sealLeafData(FIXED_SEAL)).toEqual(
      new TextEncoder().encode(canonicalJson(FIXED_SEAL)),
    );
    const root = merkleRoot(leaves);
    expect(verifyInclusion({ leafData: leaves[3]!, index: 3, size: 4, path: inclusionPath(leaves, 3), root })).toBe(true);
  });
});

describe("limits copy", () => {
  it("is the three paragraphs of the plan joined with blank lines", () => {
    const paragraphs = AUDIT_LIMITS_COPY.split("\n\n");
    expect(paragraphs).toEqual([
      "What this ledger proves: the records in this export have not been changed, removed or reordered since Rovara sealed them, and each sealed batch existed no later than the time an independent timestamp service signed.",
      "What it does not prove: that the records are true or complete. Rovara writes them, so an action Rovara never recorded, or recorded wrongly, does not show up as tampering. Records after the last seal are not sealed yet; this export says how many.",
      "It is tamper-evident, not tamper-proof. Someone with enough access could still change Rovara's live copy, but the change would show when checked against the sealed copy, the timestamps and your earlier exports. Keep every export you take.",
    ]);
    expect(AUDIT_LIMITS_COPY).not.toContain("—");
  });
});

describe("zero dependencies", () => {
  it("package.json has no dependencies and the license and bin the plan names", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", PACKAGE_DIR), "utf8")) as Record<string, unknown>;
    expect(pkg.name).toBe("@rovara/audit-verifier");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ "rovara-audit-verify": "./dist/cli.js" });
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) {
      expect(pkg).not.toHaveProperty(key);
    }
  });

  it("ships the repository's Apache license", () => {
    expect(readFileSync(new URL("LICENSE", PACKAGE_DIR), "utf8")).toBe(
      readFileSync(new URL("../../LICENSE-APACHE", PACKAGE_DIR), "utf8"),
    );
  });

  it("every import specifier under src is a node: built-in or relative", () => {
    const srcDir = new URL("src/", PACKAGE_DIR);
    const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `${entry.parentPath}/${entry.name}`);
    expect(files.length).toBeGreaterThanOrEqual(6);
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(specifier)) {
        const target = match[1]!;
        expect(target.startsWith("node:") || target.startsWith("./") || target.startsWith("../"), `${file}: ${target}`).toBe(true);
      }
    }
  });
});

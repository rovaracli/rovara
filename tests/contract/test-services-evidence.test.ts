// Test services, TS5 (design test-services.md, 2.4 and 9.3): the honesty labels, the evidence fields that carry them, and the pull request lines built from them. Pure: nothing is wired.
import { describe, expect, it } from "vitest";
import * as evidence from "@rovara-code/contracts";
import { dependencyLines, dependencyLineIsInert, packDependencyLines, DEPENDENCY_LEVEL_LAST } from "../../packages/broker/src/rovara-code/dependency-lines.js";
import { TEST_ENV_BACKING_KINDS, TEST_ENV_NONE_REASONS } from "@rovara-code/contracts";
import { environmentLine } from "../../packages/broker/src/rovara-code/evidence-lines.js";

type Dep = evidence.EvidenceDependency;
const sha = (letter: string) => letter.repeat(64);
const dep = (overrides: Record<string, unknown> & { name: string; label: Dep["label"]; backing: Dep["backing"] }): Dep => overrides;
const real = (name = "Postgres") => dep({ name, label: "real", backing: "local" });
const emulated = (name: string) => dep({ name, label: "rovara_local_aws", backing: "emulated" });
const account = (name = "payments API") => dep({ name, label: "test_account", backing: "test_account" });
const recorded = (name = "model endpoint", extra: Record<string, unknown> = {}) => dep({ name, label: "recorded_fake", backing: "fake", recordedAt: "2026-11-02T10:00:00.000Z", fixtureRevision: 3, ...extra });
const written = (name = "geo API", extra: Record<string, unknown> = {}) => dep({ name, label: "hand_written_fake", backing: "fake", ...extra });
const notAvailable = (name = "Kafka", extra: Record<string, unknown> = {}) => dep({ name, label: "not_available", backing: "none", ...extra });

const pack = (dependencies: Dep[] | undefined, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, candidateDigest: sha("c"),
  environment: { tier: "sandbox", envRevision: 3, services: [], ...(dependencies === undefined ? {} : { dependencies }), data: "synthetic", accounts: [] },
  checks: [], selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [],
  ...overrides,
});

describe("honesty labels (design 2.4)", () => {
  it("has the fixed words of every row", () => {
    expect(evidence.EVIDENCE_DEPENDENCY_LABELS).toEqual(["real", "real_project_image", "company_approved", "rovara_local_aws", "test_account", "recorded_fake", "hand_written_fake", "faked_by_tests", "not_available"]);
    expect(evidence.EVIDENCE_DEPENDENCY_LABEL_WORDS).toEqual({
      real: "real", real_project_image: "real (your image)", company_approved: "company-approved image", rovara_local_aws: "Rovara local AWS", test_account: "test account",
      recorded_fake: "recorded fake", hand_written_fake: "hand-written fake", faked_by_tests: "faked by your tests", not_available: "not available",
    });
  });
  it("names a company-approved image by its service (owner Q9)", () => {
    expect(evidence.evidenceDependencyLabelWords("company_approved", "Postgres")).toBe("company-approved Postgres image");
    expect(evidence.evidenceDependencyLabelWords("real", "Postgres")).toBe("real");
    expect(evidence.evidenceDependencyLabelWords("recorded_fake", "x", 3)).toBe("recorded fake (+3 made-up answers)");
    expect(evidence.evidenceDependencyLabelWords("hand_written_fake", "x", 1)).toBe("hand-written fake (+1 made-up answers)");
    expect(evidence.evidenceDependencyLabelWords("recorded_fake", "x", 0)).toBe("recorded fake");
    // Only a fake can have made-up answers.
    expect(evidence.evidenceDependencyLabelWords("real", "x", 4)).toBe("real");
  });
  it("computes the label from the pinned backing, never from a worker's words", () => {
    const labelFor = evidence.evidenceDependencyLabelFor;
    expect(labelFor({ backing: "local" })).toBe("real");
    expect(labelFor({ backing: "local", substituteImage: true })).toBe("company_approved");
    expect(labelFor({ backing: "project_image" })).toBe("real_project_image");
    expect(labelFor({ backing: "emulated" })).toBe("rovara_local_aws");
    expect(labelFor({ backing: "test_account" })).toBe("test_account");
    expect(labelFor({ backing: "fake", recorded: true })).toBe("recorded_fake");
    expect(labelFor({ backing: "fake", recorded: false })).toBe("hand_written_fake");
    expect(labelFor({ backing: "none", fakedByTests: true })).toBe("faked_by_tests");
    expect(labelFor({ backing: "none", fakedByTests: false })).toBe("not_available");
  });
  it("keeps the browser-safe backing kinds equal to the contract's", () => {
    expect([...evidence.EVIDENCE_BACKING_KINDS]).toEqual([...TEST_ENV_BACKING_KINDS]);
    expect(TEST_ENV_NONE_REASONS).toContain("faked_by_tests");
  });
  it("has a label for every backing, and only one that fits it", () => {
    for (const backing of evidence.EVIDENCE_BACKING_KINDS) expect(Object.values(evidence.EVIDENCE_DEPENDENCY_LABEL_BACKING)).toContain(backing);
  });
  it("words a fallback", () => {
    expect(evidence.EVIDENCE_FALLBACK_REASON_WORDS).toEqual({ test_account_unreachable: "test account unreachable", test_account_expired: "test account expired", test_account_busy: "test account busy", did_not_start: "did not start" });
  });
});

describe("EvidenceDependency in the pack", () => {
  it("accepts one of every label", () => {
    const all = [
      real(), dep({ name: "Redis", label: "company_approved", backing: "local", imageDigest: sha("1") }), dep({ name: "scorer image", label: "real_project_image", backing: "project_image" }),
      emulated("S3"), account(), recorded(), written(), dep({ name: "retry logic", label: "faked_by_tests", backing: "none" }), notAvailable("Kafka", { testsNotRun: 12 }),
    ];
    const parsed = evidence.EvidencePackSchema.safeParse(pack(all));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
  it("still parses an old pack with no dependencies, and an old services entry", () => {
    const old = { ...pack(undefined), environment: { tier: "sandbox", envRevision: 3, services: [{ name: "partner-scorer", mode: "mocked", fixtureRevision: 2 }], data: "synthetic", accounts: [] } };
    expect(evidence.EvidencePackSchema.safeParse(old).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack([])).success).toBe(true);
  });
  it("is strict, one plain line, and bounded", () => {
    for (const bad of [dep({ ...real(), extra: 1 }), real("two\nlines"), real("flip\u202egnp"), real("")]) expect(evidence.EvidencePackSchema.safeParse(pack([bad])).success).toBe(false);
    const many = Array.from({ length: 25 }, (_, index) => real(`db-${index}`));
    expect(evidence.EvidencePackSchema.safeParse(pack(many)).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack(many.slice(0, 24))).success).toBe(true);
  });
  it("needs unique names", () => {
    expect(evidence.EvidencePackSchema.safeParse(pack([real("Postgres"), emulated("Postgres")])).success).toBe(false);
  });
  it("keeps the label and the backing in step (a company-approved image is never plain real)", () => {
    for (const bad of [
      dep({ name: "a", label: "real", backing: "emulated" }),
      dep({ name: "a", label: "rovara_local_aws", backing: "local" }),
      dep({ name: "a", label: "test_account", backing: "fake" }),
      dep({ name: "a", label: "not_available", backing: "fake" }),
      dep({ name: "a", label: "faked_by_tests", backing: "local" }),
      dep({ name: "a", label: "real_project_image", backing: "local" }),
      dep({ name: "a", label: "recorded_fake", backing: "local", recordedAt: "2026-11-02T10:00:00.000Z" }),
    ]) expect(evidence.EvidencePackSchema.safeParse(pack([bad])).success, JSON.stringify(bad)).toBe(false);
  });
  it("needs the facts its words quote", () => {
    // A company-approved image states the digest it ran; a recorded fake states when it was recorded.
    expect(evidence.EvidencePackSchema.safeParse(pack([dep({ name: "a", label: "company_approved", backing: "local" })])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([dep({ name: "a", label: "recorded_fake", backing: "fake" })])).success).toBe(false);
    // A hand-written fake was never recorded.
    expect(evidence.EvidencePackSchema.safeParse(pack([written("a", { recordedAt: "2026-11-02T10:00:00.000Z" })])).success).toBe(false);
  });
  it("allows each optional fact only where it means something", () => {
    expect(evidence.EvidencePackSchema.safeParse(pack([dep({ name: "a", label: "real", backing: "local", madeUpAnswers: 2 })])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([dep({ name: "a", label: "real", backing: "local", fixtureRevision: 2 })])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([dep({ name: "a", label: "real", backing: "local", testsNotRun: 2 })])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([written("a", { madeUpAnswers: 2 })])).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack([notAvailable("a", { testsNotRun: 2 })])).success).toBe(true);
  });
  it("lets only a fake or nothing be a fallback, from something that is not nothing", () => {
    const from = (fellBack: unknown, base: Dep) => ({ ...base, fellBack }) as Dep;
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "test_account", reason: "test_account_unreachable" }, recorded())])).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "test_account", reason: "test_account_unreachable" }, notAvailable("Kafka"))])).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "test_account", reason: "test_account_unreachable" }, real())])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "test_account", reason: "test_account_unreachable" }, account())])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "none", reason: "did_not_start" }, recorded())])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "fake", reason: "did_not_start" }, recorded())])).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack([from({ from: "test_account", reason: "free words" }, recorded())])).success).toBe(false);
  });
  it("a fallback is never the tests' own fake, and a test account reason comes from a test account (M2)", () => {
    const fake = (label: Dep["label"], backing: Dep["backing"], extra: Record<string, unknown> = {}) => dep({ name: "a", label, backing, ...extra });
    const fell = (from: string, reason: string) => ({ from, reason });
    const ok = (entry: Dep) => evidence.EvidencePackSchema.safeParse(pack([entry])).success;
    expect(ok(fake("faked_by_tests", "none", { fellBack: fell("test_account", "test_account_unreachable") }))).toBe(false);
    expect(ok(fake("faked_by_tests", "none", { fellBack: fell("local", "did_not_start") }))).toBe(false);
    expect(ok(fake("hand_written_fake", "fake", { fellBack: fell("local", "did_not_start") }))).toBe(true);
    expect(ok(fake("not_available", "none", { fellBack: fell("emulated", "did_not_start") }))).toBe(true);
    for (const reason of ["test_account_unreachable", "test_account_expired", "test_account_busy"]) {
      expect(ok(fake("hand_written_fake", "fake", { fellBack: fell("local", reason) })), reason).toBe(false);
      expect(ok(fake("hand_written_fake", "fake", { fellBack: fell("emulated", reason) })), reason).toBe(false);
      expect(ok(fake("hand_written_fake", "fake", { fellBack: fell("test_account", reason) })), reason).toBe(true);
    }
  });
  it("keeps usage within the requests made", () => {
    expect(evidence.EvidencePackSchema.safeParse(pack([recorded("a", { usage: { requests: 10, unmatched: 2, faults: 1 } })])).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack([recorded("a", { usage: { requests: 1, unmatched: 2, faults: 0 } })])).success).toBe(false);
  });
  it("is browser-safe: the view schema carries the same fields", () => {
    const view = { ...pack([real(), emulated("S3")]) };
    expect(evidence.EvidenceViewSchema.safeParse(view).success).toBe(true);
  });
});

describe("the pull request lines (design 9.3)", () => {
  it("builds the example of 9.3", () => {
    const out = dependencyLines([real("Postgres"), emulated("S3"), emulated("DynamoDB"), account("payments API"), recorded('model endpoint "scorer"')], 0);
    expect(out.lines[0]).toBe('Integration tests ran against: Postgres (real), S3 and DynamoDB (Rovara local AWS), payments API (test account), model endpoint "scorer" (recorded fake, rev 3).');
  });
  it("groups the same description, three or more with 'and' at the end", () => {
    expect(dependencyLines([emulated("S3"), emulated("DynamoDB"), emulated("SQS")], 0).lines[0]).toBe("Integration tests ran against: S3, DynamoDB and SQS (Rovara local AWS).");
    expect(dependencyLines([real("Postgres")], 0).lines[0]).toBe("Integration tests ran against: Postgres (real).");
  });
  it("says nothing when there are no dependencies, so today's pull request is unchanged", () => {
    expect(dependencyLines(undefined, 0)).toEqual({ lines: [], notTested: [] });
    expect(dependencyLines([], 0)).toEqual({ lines: [], notTested: [] });
    expect(packDependencyLines(pack(undefined) as unknown as evidence.EvidencePack, 0)).toEqual({ lines: [], notTested: [] });
  });

  describe("each row of 2.4", () => {
    it("real: no 'not tested' line", () => {
      expect(dependencyLines([real()], 0)).toEqual({ lines: ["Integration tests ran against: Postgres (real)."], notTested: [] });
    });
    it("real (your image): no 'not tested' line", () => {
      const out = dependencyLines([dep({ name: "scorer", label: "real_project_image", backing: "project_image" })], 0);
      expect(out.lines).toEqual(["Integration tests ran against: scorer (real, your image)."]);
      expect(out.notTested).toEqual([]);
    });
    it("company-approved <service> image, with its short digest", () => {
      const out = dependencyLines([dep({ name: "Postgres", label: "company_approved", backing: "local", imageDigest: `abcdef012345${"0".repeat(52)}` })], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: Postgres (company-approved Postgres image).");
      expect(out.notTested).toEqual(["- Postgres: ran the company's own build of the image (digest abcdef012345), not Rovara's catalog image"]);
    });
    it("Rovara local AWS", () => {
      expect(dependencyLines([emulated("S3")], 0).notTested).toEqual(["- S3 behaviour against real AWS (emulated)", "- AWS permissions (IAM) were not checked: Rovara local AWS does not enforce IAM"]);
      // The permissions line is said once however many dependencies run on local AWS.
      expect(dependencyLines([emulated("S3"), emulated("SQS")], 0).notTested.filter((line) => line.includes("permissions"))).toHaveLength(1);
      expect(dependencyLines([real("Postgres")], 0).notTested).toEqual([]);
    });
    it("test account: no 'not tested' line, a note", () => {
      const out = dependencyLines([account("payments API")], 0);
      expect(out.notTested).toEqual([]);
      expect(out.lines).toEqual(["Integration tests ran against: payments API (test account).", "Note: used your payments API test account."]);
      expect(dependencyLines([account("payments API"), account("CRM")], 0).lines[1]).toBe("Note: used your payments API and CRM test accounts.");
    });
    it("recorded fake", () => {
      const out = dependencyLines([recorded("geo API", { fixtureRevision: undefined })], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: geo API (recorded fake).");
      expect(out.notTested).toEqual(["- geo API: answers were recorded on 2026-11-02; real behaviour may have changed"]);
    });
    it("hand-written fake", () => {
      const out = dependencyLines([written("geo API")], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: geo API (hand-written fake).");
      expect(out.notTested).toEqual(["- geo API: answers were written by hand, not recorded"]);
    });
    it("a fake that made up answers: recorded fake (+N made-up answers)", () => {
      const out = dependencyLines([recorded("geo API", { fixtureRevision: undefined, madeUpAnswers: 4 })], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: geo API (recorded fake, +4 made-up answers).");
      expect(out.notTested).toContain("- geo API: 4 requests had no recording and got a made-up answer");
      expect(out.notTested).toContain("- geo API: answers were recorded on 2026-11-02; real behaviour may have changed");
      expect(dependencyLines([written("geo API", { madeUpAnswers: 1 })], 0).notTested).toContain("- geo API: 1 request had no recording and got a made-up answer");
    });
    it("faked by your tests: no 'not tested' line", () => {
      const out = dependencyLines([dep({ name: "S3 client", label: "faked_by_tests", backing: "none" })], 0);
      expect(out).toEqual({ lines: ["Integration tests ran against: S3 client (faked by your tests)."], notTested: [] });
    });
    it("not available: the tests that were not run", () => {
      const out = dependencyLines([notAvailable("Kafka", { testsNotRun: 12 })], 0);
      expect(out.lines).toEqual([]);
      expect(out.notTested).toEqual(["- 12 tests not run: they need Kafka"]);
      expect(dependencyLines([notAvailable("Kafka", { testsNotRun: 1 })], 0).notTested).toEqual(["- 1 test not run: it needs Kafka"]);
      expect(dependencyLines([notAvailable("Kafka")], 0).notTested).toEqual(["- Kafka: not available"]);
    });
    it("a fallback shows the label of what ran, and why", () => {
      const out = dependencyLines([recorded("payments API", { fixtureRevision: undefined, fellBack: { from: "test_account", reason: "test_account_unreachable" } })], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: payments API (recorded fake, fallback: test account unreachable).");
      // The fallback's own line is still there.
      expect(out.notTested).toEqual(["- payments API: answers were recorded on 2026-11-02; real behaviour may have changed"]);
      expect(dependencyLines([notAvailable("Kafka", { testsNotRun: 2, fellBack: { from: "test_account", reason: "test_account_expired" } })], 0).notTested).toEqual(["- 2 tests not run: they need Kafka (fallback: test account expired)"]);
    });
    it("a fallback is not grouped with a plain one", () => {
      const out = dependencyLines([recorded("a", { fixtureRevision: undefined }), recorded("b", { fixtureRevision: undefined, fellBack: { from: "emulated", reason: "did_not_start" } })], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: a (recorded fake), b (recorded fake, fallback: did not start).");
    });
  });

  describe("never dropped at any shrink level", () => {
    const everything = (): Dep[] => [
      real("Postgres"), dep({ name: "Redis", label: "company_approved", backing: "local", imageDigest: sha("a") }), dep({ name: "scorer", label: "real_project_image", backing: "project_image" }),
      emulated("S3"), emulated("DynamoDB"), account("payments API"), recorded("geo API", { madeUpAnswers: 3 }), written("tax API"),
      dep({ name: "client mock", label: "faked_by_tests", backing: "none" }), notAvailable("Kafka", { testsNotRun: 12, fellBack: { from: "test_account", reason: "test_account_busy" } }),
    ];
    it("keeps the same lines at every level, only in fewer words", () => {
      const base = dependencyLines(everything(), 0);
      expect(base.lines.length).toBe(2);
      expect(base.notTested.length).toBe(8);
      for (let level = 0; level <= DEPENDENCY_LEVEL_LAST + 3; level += 1) {
        const out = dependencyLines(everything(), level);
        expect(out.lines.length, `lines at ${level}`).toBe(base.lines.length);
        expect(out.notTested.length, `notTested at ${level}`).toBe(base.notTested.length);
        const text = [...out.lines, ...out.notTested].join("\n");
        // Every dependency is named, and every label is there.
        for (const name of ["Postgres", "Redis", "scorer", "S3", "DynamoDB", "payments API", "geo API", "tax API", "client mock", "Kafka"]) expect(text, `${name} at ${level}`).toContain(name.slice(0, 16));
        expect(out.lines[0], `labels at ${level}`).toMatch(/real/);
        for (const word of ["Rovara local AWS", "test account", "recorded fake", "hand-written fake", "faked by your tests", "company-approved"]) expect(out.lines.join("\n"), `${word} at ${level}`).toContain(word);
        expect(out.notTested.some((item) => item.includes("12 tests") && item.includes("Kafka")), `not run at ${level}`).toBe(true);
        for (const line of [...out.lines, ...out.notTested]) expect(line.length).toBeLessThanOrEqual(600);
      }
    });
    it("is shorter at higher levels, never longer", () => {
      const total = (level: number) => { const out = dependencyLines(everything(), level); return [...out.lines, ...out.notTested].join("").length; };
      expect(total(3)).toBeLessThan(total(0));
      expect(total(4)).toBeLessThanOrEqual(total(3));
    });
    it("a level outside 0..last is clamped, never throws", () => {
      expect(dependencyLines(everything(), -5)).toEqual(dependencyLines(everything(), 0));
      expect(dependencyLines(everything(), 99)).toEqual(dependencyLines(everything(), DEPENDENCY_LEVEL_LAST));
    });
    it("lists all 24 dependencies even when they would not fit", () => {
      const many = Array.from({ length: 24 }, (_, index) => emulated(`service-${String(index).padStart(2, "0")}-with-a-long-name`));
      const out = dependencyLines(many, 0);
      // One line for each, and the one line that says AWS permissions were not checked.
      expect(out.notTested.length).toBe(25);
      expect(out.lines[0]).toContain("service-23");
    });
  });

  describe("the shorter words of levels 3 and 4", () => {
    const long = (word: string) => `${word}-with-a-very-long-name-indeed`;
    it("uses the short prefix, cuts names and drops revisions, but not the label", () => {
      const deps = [emulated(long("s3")), recorded(long("geo"), { fixtureRevision: 7 })];
      const full = dependencyLines(deps, 2);
      expect(full.lines[0]).toMatch(/^Integration tests ran against:/u);
      expect(full.lines[0]).toContain("rev 7");
      expect(full.lines[0]).toContain(long("s3"));
      const three = dependencyLines(deps, 3);
      expect(three.lines[0]).toMatch(/^Ran against: /u);
      expect(three.lines[0]).not.toContain("rev 7");
      expect(three.lines[0]).not.toContain(long("s3"));
      expect(three.lines[0]).toContain("s3-with-a-very-long-nam…");
      expect(three.lines[0]).toContain("Rovara local AWS");
      const four = dependencyLines(deps, 4);
      expect(four.lines[0]).toContain("s3-with-a-very-…");
      expect(four.lines[0]).not.toContain("s3-with-a-very-long-nam…");
    });
    it("says each row in a short sentence", () => {
      const out = dependencyLines([
        emulated("S3"), recorded("geo", { fixtureRevision: undefined, madeUpAnswers: 2 }), written("tax"), dep({ name: "Redis", label: "company_approved", backing: "local", imageDigest: sha("a") }), notAvailable("Kafka", { testsNotRun: 12 }),
      ], 3);
      expect(out.notTested).toEqual([
        "- S3: emulated, not real AWS", "- geo: recorded 2026-11-02", "- geo: 2 made-up answers", "- tax: written by hand", "- Redis: company's own image (digest aaaaaaaaaaaa)", "- 12 tests not run: need Kafka", "- AWS permissions not checked (no IAM)",
      ]);
      expect(dependencyLines([notAvailable("Kafka", { testsNotRun: 1 })], 3).notTested).toEqual(["- 1 test not run: need Kafka"]);
    });
  });

  describe("inert text", () => {
    const hostile = [
      "@everyone", "![x](https://evil.example/a.png)", "[click](https://evil.example)", "<!-- hidden", "Fixes ENG-123", "GH-12 and #34", "https://evil.example/x", "&#x40;user", "<script>x</script>", "a|b",
    ];
    it("never lets a repository's words mention, link, hide, close or cross-reference", () => {
      for (const name of hostile) {
        const out = dependencyLines([dep({ name, label: "rovara_local_aws", backing: "emulated" }), dep({ name: `${name} two`, label: "not_available", backing: "none", testsNotRun: 1 }), dep({ name: `${name} three`, label: "company_approved", backing: "local", imageDigest: sha("a") })], 0);
        const text = [...out.lines, ...out.notTested].join("\n");
        expect(text, name).not.toMatch(/@(?!\u200d)/u);
        expect(text, name).not.toMatch(/!\[|\]\(|<!--|<script|<\/|:\/\/(?!\u200d)/u);
        expect(text, name).not.toMatch(/\b(Fixes|Closes|Resolves) ENG-\d/iu);
        expect(text, name).not.toMatch(/#(?=\d)/u);
        expect(text, name).not.toMatch(/&#x40;|&commat;/u);
        for (const line of [...out.lines, ...out.notTested]) expect(line.replaceAll(String.fromCharCode(0x200d), ""), name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      }
    });
    it("a link cannot be made by two names that are harmless apart (H1)", () => {
      const out = dependencyLines([emulated("[click"), emulated("here](//evil.com)")], 0);
      const text = [...out.lines, ...out.notTested].join("\n");
      expect(text).not.toContain("](");
      expect(out.lines[0]).toBe("Integration tests ran against: \\[click and here\\]\\(//evil.com\\) (Rovara local AWS).");
      for (const line of [...out.lines, ...out.notTested]) expect(dependencyLineIsInert(line), line).toBe(true);
    });
    it("strike-through, code spans, emphasis, tags and quotes are written out as plain characters (H1)", () => {
      // What each name must come out as: its characters written out with a backslash in front, by the name's own cleaning (the whole-line check is only the second defence).
      const written: Record<string, string> = {
        "~~gone": "\\~\\~gone", "gone~~": "gone\\~\\~", "`code": "\\`code", "code`": "code\\`", "*bold": "\\*bold", "_it_": "\\_it\\_", "<b>x</b>": "x",
        "> quote": "\\> quote", "back\\slash": "back\\\\slash", "a|b": "a\\|b", "![img": "!\\[img", "(paren": "\\(paren", "x)": "x\\)",
      };
      for (const name of Object.keys(written)) {
        const out = dependencyLines([emulated(name), emulated("other"), dep({ name: `${name} two`, label: "not_available", backing: "none", testsNotRun: 2 })], 3);
        expect([...out.lines, ...out.notTested].join("\n"), name).toContain(written[name]);
        for (const line of [...out.lines, ...out.notTested]) {
          expect(dependencyLineIsInert(line), `${name}: ${line}`).toBe(true);
          expect(line.replace(/\\./gu, ""), name).not.toMatch(/[`*_~[\]<]/u);
        }
      }
      const out = dependencyLines([emulated("~~a"), emulated("b~~")], 0);
      expect(out.lines[0]).toContain("\\~\\~a and b\\~\\~");
    });
    it("checks the whole line, not only the names", () => {
      expect(dependencyLineIsInert("Integration tests ran against: Postgres (real).")).toBe(true);
      expect(dependencyLineIsInert("- 12 tests not run: they need Kafka")).toBe(true);
      for (const bad of ["a [b](c)", "a ](c", "![x", "~~x~~", "`x`", "*x*", "_x_", "<b>", "@user", "https://x", "see #12", "www.evil.com", "Fixes ENG-12", "tab\there", "GH-12", "[x"]) expect(dependencyLineIsInert(bad), bad).toBe(false);
      expect(dependencyLineIsInert("a \\[x\\] \\_y\\_ \\\\")).toBe(true);
      expect(dependencyLineIsInert("a \\\\[x")).toBe(false);
    });
    it("a name that would start a heading, a list or a rule starts nothing in a bullet", () => {
      const cases: Array<[string, string]> = [["# heading", "\\# heading"], ["- item", "\\- item"], ["+ item", "\\+ item"], ["1. item", "1\\. item"], ["--- rule", "\\--- rule"], ["12) item", "12\\) item"], ["## two", "\\## two"]];
      for (const [name, escaped] of cases) {
        const out = dependencyLines([emulated(name), dep({ name, label: "not_available", backing: "none" }), dep({ name: `x ${name}`, label: "hand_written_fake", backing: "fake" })], 0);
        expect(out.notTested[0], name).toBe(`- ${escaped} behaviour against real AWS (emulated)`);
        expect(out.notTested[1], name).toBe(`- ${escaped}: not available`);
        // In the middle of a line it starts nothing, and is left as it is.
        expect(out.lines[0], name).toContain(`x ${name.replace(")", "\\)")}`);
        for (const line of [...out.lines, ...out.notTested]) expect(dependencyLineIsInert(line), `${name}: ${line}`).toBe(true);
      }
      // A whole name of the form is kept as words at every level.
      for (let level = 0; level <= 4; level += 1) expect(dependencyLines([emulated("# h")], level).notTested[0]).toMatch(/^- \\# h/u);
    });
    it("flags a bullet that starts a heading, a list or a rule, and keeps the bullets it writes itself", () => {
      for (const bad of ["- # x", "- - x", "- + x", "- 1. x", "- 2) x", "- --- x"]) expect(dependencyLineIsInert(bad), bad).toBe(false);
      for (const good of ["- \\# x", "- \\- x", "- 12 tests not run: they need Kafka", "- 1 test not run: it needs Kafka", "- S3 behaviour against real AWS (emulated)", "Integration tests ran against: # x (real)."]) expect(dependencyLineIsInert(good), good).toBe(true);
    });
    it("keeps a service's name exactly as it is in the company-approved words (L5)", () => {
      const out = dependencyLines([dep({ name: "Post (gres", label: "company_approved", backing: "local", imageDigest: sha("a") })], 0);
      expect(out.lines[0]).toBe("Integration tests ran against: Post \\(gres (company-approved Post \\(gres image).");
    });
    it("redacts a key-shaped name", () => {
      const key = ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP";
      const out = dependencyLines([dep({ name: `bucket ${key}`, label: "rovara_local_aws", backing: "emulated" })], 0);
      expect(JSON.stringify(out)).not.toContain(key);
    });
    it("is one line each, however the name was written", () => {
      const out = dependencyLines([dep({ name: "a\nb\r\nc\u202e d", label: "rovara_local_aws", backing: "emulated" }), dep({ name: "   ", label: "real", backing: "local" })], 0);
      for (const line of [...out.lines, ...out.notTested]) expect(line).not.toMatch(/[\r\n\u202e]/u);
      expect(out.lines[0]).toContain("a dependency");
    });
    it("cuts a very long name", () => {
      const out = dependencyLines([emulated("x".repeat(500))], 0);
      expect(out.lines[0]!.length).toBeLessThan(200);
    });
    it("never prints a field it was not meant to: an unknown digest shape or date is shown as nothing", () => {
      const out = dependencyLines([dep({ name: "Postgres", label: "company_approved", backing: "local", imageDigest: "@user<!--" }), recorded("geo", { recordedAt: "@user<!-- not a date" })], 0);
      const text = [...out.lines, ...out.notTested].join("\n");
      expect(text).not.toContain("@user");
      expect(text).not.toContain("<!--");
    });
  });

  it("is taken from the pack only", () => {
    const out = packDependencyLines(pack([real(), emulated("S3")]) as unknown as evidence.EvidencePack, 0);
    expect(out.lines[0]).toBe("Integration tests ran against: Postgres (real), S3 (Rovara local AWS).");
  });
  it("leaves the existing Environment line as it was", () => {
    const withDeps = pack([real()]) as unknown as evidence.EvidencePack;
    const without = pack(undefined) as unknown as evidence.EvidencePack;
    expect(environmentLine(withDeps, 0)).toBe(environmentLine(without, 0));
  });
});

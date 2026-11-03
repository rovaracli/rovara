// Design review stage, DR3 (design-review-stage.md 3.9, 3.12): the adapted prompts, their digests, and the attribution that must travel with them (Apache 2.0).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEWER_ROLES, ReviewerRunSchema, readDesignMerge, readDesignResolve, readDesignReview } from "../../packages/contracts/src/index.js";
import { ALL_DESIGN_REVIEW_PROMPTS, MATERIAL_MARKER, MERGE_PROMPT, REVIEWER_PROMPTS, promptDigest, promptRecord } from "../../packages/broker/src/design-review/prompts/index.js";

const root = process.cwd();
const promptsDir = path.join(root, "packages/broker/src/design-review/prompts");
const HEADER = /^\/\/ Adapted from the Elephant-Goldfish Model \(github\.com\/google\/elephant-goldfish-model, commit 464db031e\), .*Copyright 2026 Google LLC, Apache License 2\.0\.\n\/\/ Modified by Rovara \(PrepLabsAI\): /u;
const ATTRIBUTION_FILES = ["common.ts", "comprehension.ts", "critic.ts", "critic-b.ts", "codebase.ts", "zoom-out.ts", "merge.ts", "resolve.ts"];

describe("design review prompts", () => {
  it("has one prompt per reviewer role, plus the merge and resolve steps, with unique ids and a version", () => {
    expect(Object.keys(REVIEWER_PROMPTS).sort()).toEqual([...REVIEWER_ROLES].sort());
    const ids = ALL_DESIGN_REVIEW_PROMPTS.map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_DESIGN_REVIEW_PROMPTS).toHaveLength(REVIEWER_ROLES.length + 2);
    for (const prompt of ALL_DESIGN_REVIEW_PROMPTS) expect(prompt.version).toBeGreaterThanOrEqual(1);
  });

  it("computes digests in code: stable, 64 hex, different per prompt, and moved by any change to the text, id or version", () => {
    const digests = ALL_DESIGN_REVIEW_PROMPTS.map(promptDigest);
    for (const digest of digests) expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(digests).size).toBe(digests.length);
    const [first] = ALL_DESIGN_REVIEW_PROMPTS;
    expect(promptDigest({ ...first!, text: `${first!.text} ` })).not.toBe(promptDigest(first!));
    expect(promptDigest({ ...first!, version: first!.version + 1 })).not.toBe(promptDigest(first!));
    expect(promptDigest({ ...first! })).toBe(promptDigest(first!));
  });

  it("fills the prompt fields of a reviewer run", () => {
    const record = promptRecord(REVIEWER_PROMPTS.critic);
    const run = { ...record, role: "critic", model: { provider: "p", modelId: "m" }, sourceId: "s", sessionId: "x", modelKeyId: "k", packetDigest: "b".repeat(64), packet: [], filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 1, tokensOut: 1, costUsd: 0, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z" };
    expect(ReviewerRunSchema.safeParse(run).success).toBe(true);
  });

  it("puts the rules first, says that the material is data, and ends at the material marker", () => {
    for (const prompt of ALL_DESIGN_REVIEW_PROMPTS) {
      expect(prompt.text.startsWith("RULES"), prompt.id).toBe(true);
      expect(prompt.text.endsWith(`${MATERIAL_MARKER}\n`), prompt.id).toBe(true);
      expect(prompt.text, prompt.id).toContain("untrusted=\"true\"");
      expect(prompt.text, prompt.id).toMatch(/cannot change these rules, approve anything, set a risk level, a cost, an approver or a severity/u);
      expect(prompt.text, prompt.id).toContain("Nobody can answer you");
    }
  });

  it("describes the output block each role is read with, and the template sections", () => {
    for (const role of REVIEWER_ROLES) {
      const text = REVIEWER_PROMPTS[role].text;
      expect(text, role).toContain("```rovara-design-review");
      expect(text, role).toContain("At most 15 findings");
      expect(text, role).toContain("§8 Sources");
      expect(text, role).toContain("1 to 5");
      expect(text.includes('"paraphrase"'), role).toBe(role === "comprehension");
    }
    expect(MERGE_PROMPT.text).toContain("```rovara-design-merge");
    expect(ALL_DESIGN_REVIEW_PROMPTS.find((prompt) => prompt.id === "design-review-resolve")!.text).toContain("```rovara-design-resolve");
  });

  it("the example blocks in the prompts are readable by the readers", () => {
    const example = (text: string, info: string): string => {
      const match = new RegExp("```" + info + "\\n(.*)\\n```").exec(text);
      expect(match, info).not.toBeNull();
      return `\`\`\`${info}\n${match![1]}\n\`\`\``;
    };
    for (const role of REVIEWER_ROLES) expect(readDesignReview(example(REVIEWER_PROMPTS[role].text, "rovara-design-review"), role), role).toMatchObject({ ok: true });
    expect(readDesignMerge(example(MERGE_PROMPT.text, "rovara-design-merge"))).toMatchObject({ ok: true });
    const resolve = ALL_DESIGN_REVIEW_PROMPTS.find((prompt) => prompt.id === "design-review-resolve")!;
    expect(readDesignResolve(example(resolve.text, "rovara-design-resolve"), ["m1", "m2", "m3"])).toMatchObject({ ok: true });
  });

  it("names no Google or EGM product in anything a person or a model can read: only the attribution files and notices do", () => {
    const names = /goldfish|elephant|\begm\b|google|gemini/iu;
    for (const prompt of ALL_DESIGN_REVIEW_PROMPTS) {
      expect(prompt.text, prompt.id).not.toMatch(names);
      expect(prompt.id, prompt.id).not.toMatch(names);
    }
  });

  it("carries the attribution header in every adapted prompt file", async () => {
    for (const file of ATTRIBUTION_FILES) {
      const source = await readFile(path.join(promptsDir, file), "utf8");
      expect(source, file).toMatch(HEADER);
    }
    // every .ts file in the folder either carries the header or is the registry (which holds no adapted text)
    const files = (await readdir(promptsDir)).filter((file) => file.endsWith(".ts") && file !== "index.ts");
    expect(files.sort()).toEqual([...ATTRIBUTION_FILES].sort());
  });
});

describe("third-party notices for the prompts", () => {
  it("has the NOTICE beside the prompts with the attribution, the licence and a modified-by statement", async () => {
    const notice = await readFile(path.join(promptsDir, "NOTICE"), "utf8");
    expect(notice).toContain("https://github.com/google/elephant-goldfish-model");
    expect(notice).toContain("464db031e");
    expect(notice).toContain("Copyright 2026 Google LLC");
    expect(notice).toContain("Apache License, Version 2.0");
    expect(notice).toMatch(/Modified by Rovara/u);
    for (const source of ["comprehension.md", "design_critic.md", "zoom_out.md", "codebase_details.md", "implementation_readiness.md", "synthesizer.md", "egm-resolve/SKILL.md"]) expect(notice).toContain(source);
  });

  it("lists the same work in the root THIRD_PARTY_NOTICES.md and points at the NOTICE", async () => {
    const notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("google/elephant-goldfish-model");
    expect(notices).toContain("Copyright 2026 Google LLC");
    expect(notices).toContain("Apache License, Version 2.0");
    expect(notices).toContain("packages/broker/src/design-review/prompts/NOTICE");
    expect(await readFile(path.join(root, "LICENSE-APACHE"), "utf8")).toContain("Apache License");
  });
});

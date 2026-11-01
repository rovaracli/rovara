// Proof and evidence (wire-proof fix round 2): the places the evidence erase is wired are plain code in `broker.ts` (module level) and in two route-dependency blocks of `handler.ts`, which no unit
// test can call. An optional field is also silent when it is missing, so this inventory reads the source and fails when any of them stops reaching the evidence erase: the person erase, both route blocks,
// the company close, the project archive and the scheduled resume. (The behaviour behind each is tested in tests/unit/proof-evidence-erase.test.ts.)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const BROKER = read("packages/broker/src/aws/broker.ts");
const HANDLER = read("packages/broker/src/aws/broker/handler.ts");
const ORGANIZATION = read("packages/broker/src/aws/developer-routes/organization.ts");
const ARCHIVE = read("packages/broker/src/aws/developer-routes/project-archive-setup.ts");
const code = (text: string): string => text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

describe("the evidence erase is reached from every erase path", () => {
  it("broker.ts: the person erase runs the evidence step after the learning walk, over the broker's own store", () => {
    const source = code(BROKER);
    expect(source).toMatch(/const personEvidenceErase = createEvidenceErase\(\{ s3, artifactBucketName: requiredEnvironment\("ARTIFACT_BUCKET_NAME"\)/u);
    expect(source).toMatch(/eraseLearning: learningEraseHook\([^\n]*personErasureStep\(teamRecord, personEvidenceErase\)\)/u);
  });

  it("handler.ts: both route-dependency blocks (the review page's and the developer API's) carry evidenceErase", () => {
    const source = code(HANDLER);
    const review = source.slice(source.indexOf("return await routeDeveloperRequest({"), source.indexOf("}, request, url) as { statusCode"));
    const main = source.slice(source.indexOf("const routeDependencies: DeveloperRouteDependencies = {"), source.indexOf("const answer = await routeDeveloperRequest(routeDependencies"));
    expect(review.length).toBeGreaterThan(500);
    expect(main.length).toBeGreaterThan(500);
    expect(review).toContain("evidenceErase: evidenceEraseOf(dependencies)");
    expect(main).toContain("evidenceErase: evidenceEraseOf(dependencies)");
  });

  it("the company close and the project archive run it, and the scheduled run resumes it", () => {
    expect(code(ORGANIZATION)).toMatch(/const clearLearning = deps\.closeOrgHooks\?\.clearLearning \?\? clearOrgData\(deps\);/u);
    expect(code(ORGANIZATION)).toContain("await deps.evidenceErase?.workspace(orgId);");
    expect(code(ARCHIVE)).toContain("await deps.evidenceErase?.project(orgId, project);");
    const source = code(HANDLER);
    const job = source.slice(source.indexOf('name: "resume-learning-walks"'), source.indexOf("if (jobs.length === 0)"));
    expect(job).toContain("await resumeEvidence(dependencies,");
  });
});

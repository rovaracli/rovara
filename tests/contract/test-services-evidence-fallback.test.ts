// Test services TS5 (H1): the second check over a finished line. With the per-name cleaning switched off (the module's `inertLine` is replaced by one that cleans nothing), a name that would mention someone is still
// caught when the line is checked as a whole, and the dependencies are numbered instead of named. The labels and facts stay.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../packages/broker/src/rovara-code/inert-text.js", () => ({ inertLine: (text: string) => text }));

const { dependencyLines, dependencyLineIsInert } = await import("../../packages/broker/src/rovara-code/dependency-lines.js");
type Dep = Parameters<typeof dependencyLines>[0] extends readonly (infer D)[] | undefined ? D : never;
const dep = (value: Record<string, unknown>) => value as Dep;

describe("the whole-line check", () => {
  it("numbers the dependencies when a line could still mention someone or open a tag", () => {
    const out = dependencyLines([
      dep({ name: "@everyone", label: "rovara_local_aws", backing: "emulated" }),
      dep({ name: "<!-- hidden", label: "not_available", backing: "none", testsNotRun: 3 }),
    ], 0);
    const all = [...out.lines, ...out.notTested];
    expect(all.join("\n")).not.toContain("everyone");
    expect(all.join("\n")).not.toContain("hidden");
    expect(out.lines).toEqual(["Integration tests ran against: dependency 1 (Rovara local AWS)."]);
    expect(out.notTested).toEqual(["- dependency 1 behaviour against real AWS (emulated)", "- 3 tests not run: they need dependency 2"]);
    for (const line of all) expect(dependencyLineIsInert(line)).toBe(true);
  });
  it("keeps the names when every line is fine", () => {
    expect(dependencyLines([dep({ name: "S3", label: "rovara_local_aws", backing: "emulated" })], 0).lines[0]).toBe("Integration tests ran against: S3 (Rovara local AWS).");
  });
});

// Test services, slice 1 T3 (design test-services.md 9.1, "exact words"): the Dependencies section of the approve card, in plain sentences. One line per dependency: what it is, what backs it, why Rovara thinks the project
// needs it, and whether a second person must approve it. Built by the broker from the stored proposal, never from the asker's words; text that came from a repository (a path) goes through `shownLine` and the redactor.
import { redactText, type TestEnvDependency } from "@agentx/contracts";
import { shownLine } from "../org/shown-line.js";

const LINE_MAX = 300;

/** How a backing is described to a person. Fixed words. */
export function backingWords(backing: TestEnvDependency["backing"]): string {
  switch (backing.kind) {
    case "local": return backing.substituteImage === undefined ? "runs the real software from Rovara's image list" : "runs your company's own build of the image (a second person approves this)";
    case "project_image": return "runs your own image (a second person approves this)";
    case "emulated": return "runs Rovara local AWS";
    case "test_account": return "uses your test account in sealed checks (a second person approves this)";
    case "fake": return backing.unmatched === "schema_synth" ? "answers from a fake that makes up answers for requests it has no recording for (a second person approves this)" : "answers from a fake";
    case "none": return backing.reason === "faked_by_tests" ? "is faked by your own tests, so Rovara starts nothing" : "has nothing behind it, so tests that need it do not run";
  }
}

/** The card's Dependencies section: `Postgres: runs the real software from Rovara's image list. Found in docker-compose.yml, line 4.` */
export function dependencyCardLines(dependencies: readonly TestEnvDependency[]): string[] {
  return dependencies.map((dependency) => {
    const first = dependency.found[0];
    const source = first === undefined ? "" : typeof first === "string" ? (first === "model" ? " Found by Rovara's reading of the code." : first === "person" ? " Added by a person." : "") : "path" in first ? ` Found in ${first.path}, line ${String(first.line)}.` : "";
    return shownLine(redactText(`${dependency.name}: ${backingWords(dependency.backing)}.${source}`), LINE_MAX);
  });
}

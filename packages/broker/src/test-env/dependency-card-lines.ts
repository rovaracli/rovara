// Test services, slice 1 T3 (design test-services.md 9.1, "exact words"): the Dependencies section of the approve card, in plain sentences. One line per dependency: what it is, what backs it, why Rovara thinks the project
// needs it, and whether a second person must approve it. Built by the broker from the stored proposal, never from the asker's words; text that came from a repository (a path) goes through `shownLine` and the redactor.
import { formatCommandLine, redactText, type TestEnvDependency } from "@agentx/contracts";
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

const SETS_LISTED = 8;

/**
 * The card's Dependencies section: `Postgres: runs the real software from Rovara's image list. Found in docker-compose.yml, line 4.` and, for what the approver must see beyond that (design 9.1, "Test data:"), one line
 * each for the seed commands and files (a command runs with the dependency's network access, so it is shown in full), the init files the dependency starts with, and the variable names it sets. Every line is redacted and
 * made one plain line.
 */
export function dependencyCardLines(dependencies: readonly TestEnvDependency[]): string[] {
  return dependencies.flatMap((dependency) => {
    const first = dependency.found[0];
    const source = first === undefined ? "" : typeof first === "string" ? (first === "model" ? " Found by Rovara's reading of the code." : first === "person" ? " Added by a person." : "") : "path" in first ? ` Found in ${first.path}, line ${String(first.line)}.` : "";
    const line = (text: string) => shownLine(redactText(text), LINE_MAX);
    const lines = [line(`${dependency.name}: ${backingWords(dependency.backing)}.${source}`)];
    const seeds = dependency.seeds.map((seed) => ("command" in seed ? `runs ${seed.command.cwd}: ${formatCommandLine(seed.command)}` : `loads ${seed.fixturePath}`));
    if (seeds.length > 0) lines.push(line(`${dependency.name} test data: ${seeds.join("; ")}.`));
    const initFiles = dependency.backing.kind === "local" ? (dependency.backing.config.initFiles ?? []) : [];
    if (initFiles.length > 0) lines.push(line(`${dependency.name} starts with: ${initFiles.join(", ")}.`));
    const names = dependency.connect.env.map((entry) => entry.name);
    if (names.length > 0) lines.push(line(`${dependency.name} sets: ${names.slice(0, SETS_LISTED).join(", ")}${names.length > SETS_LISTED ? ` and ${String(names.length - SETS_LISTED)} more` : ""}.`));
    return lines;
  });
}

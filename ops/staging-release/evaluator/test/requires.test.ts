/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// The release-notes `requires:` marker (owner decision DEC 254zzz441): present means MANUAL, absent changes nothing, a malformed marker is MANUAL (fail closed).
import { describe, it } from "vitest";
import { auto, cloudInput, codeInput } from "./fixtures-index.ts";
import { attack, manual } from "./helpers.ts";

const NOTES = "docs/release-notes/0.5.49.md";
const withNotes = (text: string | null, extraPaths: string[] = []) => (i: Record<string, any>): void => {
  i.changedPaths.push(NOTES, ...extraPaths);
  i.releaseNotes = [{ path: NOTES, text }];
};

describe("requires: marker", () => {
  it("absent: release notes without a marker are AUTO", () => { const i = codeInput(); withNotes("# 0.5.49\n\nRoutine release. This requires a restart of nothing.\n")(i); auto(i); });
  it("absent: no release-notes file at all is AUTO (the routine fixtures)", () => { auto(codeInput()); auto(cloudInput()); });
  it("a marker line forces MANUAL, with its text in the reason", () => {
    const i = codeInput();
    withNotes("# 0.5.49\n\nrequires: backfill feedback usage (dry run, then owner OK)\n")(i);
    const d = manual(i, "requires-marker", "K");
    if (!d.reasons.some((r) => r.message.includes("backfill feedback usage"))) throw new Error("reason must carry the marker text");
  });
  it("a cross-repo order marker forces MANUAL on the cloud pipeline too", () => { const i = cloudInput(); withNotes("requires: Code 0.5.49 installed first\n")(i); manual(i, "requires-marker", "K"); });
  it("a marker on the last line without a newline", () => { const i = codeInput(); withNotes("a\nb\nrequires: migration")(i); manual(i, "requires-marker", "K"); });
  it("a marker in a file with CRLF line endings", () => { const i = codeInput(); withNotes("a\r\nrequires: migration\r\nb\r\n")(i); manual(i, "requires-marker", "K"); });
  it("a marker inside a code fence still counts", () => { const i = codeInput(); withNotes("```\nrequires: x\n```\n")(i); manual(i, "requires-marker", "K"); });
  it("two markers give two reasons", () => { const i = codeInput(); withNotes("requires: a\nrequires: b\n")(i); const d = manual(i, "requires-marker", "K"); if (d.reasons.filter((r) => r.code === "requires-marker").length !== 2) throw new Error("two reasons expected"); });
  for (const bad of ["Requires: x", "REQUIRES: x", "requires : x", "requires:x", "requires:", "requires:   ", "requires -", "requires - x", "require: x", "requires= x", "- requires: x", "* requires: x", "> requires: x", "  requires: x", "\trequires: x", "## requires: x", "`requires: x`", "_requires: x", "+ requires: x", "requires:\tx"]) {
    it(`a malformed marker (${JSON.stringify(bad)}) is MANUAL`, () => { const i = codeInput(); withNotes(`ok\n${bad}\nok\n`)(i); manual(i, undefined, "K"); });
  }
  it("a changed release-notes file whose text was not supplied is MANUAL", () => attack(codeInput, (i) => { i.changedPaths.push(NOTES); }, "notes-missing", "K"));
  it("text supplied for a file that did not change is MANUAL", () => attack(codeInput, (i) => { i.releaseNotes = [{ path: NOTES, text: "x" }]; }, "notes-unexpected", "K"));
  it("a deleted release-notes file (text null) has no marker", () => { const i = codeInput(); withNotes(null)(i); auto(i); });
  it("a marker in a file outside the release-notes folder is not read (only release notes declare steps)", () => { const i = codeInput(); i.changedPaths.push("docs/other.md"); auto(i); });
  it("the releaseNotes input is required", () => attack(codeInput, (i) => { delete i.releaseNotes; }, "input-missing"));
  it("a note with an unknown field fails closed", () => attack(codeInput, (i) => { i.releaseNotes = [{ path: NOTES, text: "", extra: 1 }]; i.changedPaths.push(NOTES); }, "unknown-field"));
  it("a non-string text fails closed", () => attack(codeInput, (i) => { i.releaseNotes = [{ path: NOTES, text: 5 }]; i.changedPaths.push(NOTES); }, "input-invalid"));
  it("the folder match ignores case, so a differently cased folder is still read", () => { const i = codeInput(); i.changedPaths.push("DOCS/Release-Notes/x.md"); i.releaseNotes = [{ path: "DOCS/Release-Notes/x.md", text: "requires: y" }]; manual(i, "requires-marker", "K"); });
});

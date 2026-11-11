// Approval place (U4): `packages/contracts/src/approval-place.ts` is a copy of Code's file that waits for the vendor pin to move (see its header). This test keeps the copy honest: the body below the note is byte for byte what
// the header's sha256 says, so nobody edits the copy here instead of in Code, and the note is not quietly dropped.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "packages/contracts/src/approval-place.ts";
const NOTE_LINES = 4;

describe("the approval-place copy", () => {
  const text = readFileSync(FILE, "utf8");
  const lines = text.split("\n");
  const note = lines.slice(0, NOTE_LINES).join("\n");
  const body = lines.slice(NOTE_LINES).join("\n");

  it("says it is a copy owed upstream and names how to retire it", () => {
    expect(note).toContain("UPSTREAM OWED");
    expect(note).toContain("fix/code-approval-place-policy");
    expect(note).toContain("DELETE this copy");
  });

  it("is byte for byte the Code file the note records", () => {
    const recorded = /sha256 ([0-9a-f]{64})/u.exec(note)?.[1];
    expect(recorded, "the note records the Code file's sha256").toBeDefined();
    expect(createHash("sha256").update(body).digest("hex")).toBe(recorded);
  });

  it("is self-contained, so it can be retired by deleting it: it imports nothing of Cloud's", () => {
    const imports = [...body.matchAll(/^import .* from "([^"]+)";/gmu)].map((match) => match[1]);
    expect(imports).toEqual(["zod"]);
  });
});

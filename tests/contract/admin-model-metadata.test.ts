import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BEDROCK_NOT_TESTED_NOTE } from "../../packages/contracts/src/model-sources.js";
it("keeps the browser Bedrock warning identical to the source contract", () => {
 const source = readFileSync("packages/ui/src/screens/admin/models/ModelsScreen.tsx", "utf8");
 const literal = source.match(/const BEDROCK_NOT_TESTED_NOTE = ("[^\n]+?");/);
 expect(literal).not.toBeNull();expect(JSON.parse(literal![1]!)).toBe(BEDROCK_NOT_TESTED_NOTE);
});

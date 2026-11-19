import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseTaskMoneyV1 as serverParse } from "../../packages/cloud-server/src/task-money.js";
import { parseTaskMoneyV1 as parse } from "../../packages/contracts/src/task-money.js";

it("pins the server parser to the shared parser for every accepted and rejected input", () => {
 // Byte identity pins all branches, including inputs beyond the fixtures below.
 expect(readFileSync(new URL("../../packages/cloud-server/src/task-money.ts", import.meta.url), "utf8")).toBe(readFileSync(new URL("../../packages/contracts/src/task-money.ts", import.meta.url), "utf8"));
 const { examples } = JSON.parse(readFileSync("contracts/shared/task-money.v1.json", "utf8")) as { examples: Record<string, unknown>[] };
 for (const sample of [...examples, null, {}, ...examples.flatMap(example => [{ ...example, revision: -1 }, { ...example, source: {} }, { ...example, finality: "final" }, { ...example, spentMicros: { state: "available", value: 160 } }])]) expect(serverParse(sample)).toEqual(parse(sample));
});

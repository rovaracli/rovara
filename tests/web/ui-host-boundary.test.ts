// The lint of all of packages/ui/src takes about 14 s alone; on a loaded CI shard it passed 60 s (0.5.11 CI run), so the ceiling is generous and only a hang can reach it.
import { ESLint } from "eslint";
import { expect, it } from "vitest";
it("keeps UI I/O behind AppHost and catches a bare contracts import", async () => {
 const eslint = new ESLint();const results = await eslint.lintFiles(["packages/ui/src"]);expect(results.flatMap(result => result.messages.filter(message => message.severity === 2).map(message => `${result.filePath}:${message.ruleId}:${message.message}`))).toEqual([]);
 for (const barrel of ["@agentx/cloud-contracts", "@rovara-code/contracts"]) {
  const fixture = await eslint.lintText(`import { AgentIdSchema } from "${barrel}"; void AgentIdSchema;`, { filePath: "packages/ui/src/Probe.tsx" });expect(fixture.flatMap(result => result.messages).some(message => message.ruleId === "no-restricted-imports"), barrel).toBe(true);
 }
}, 300_000);

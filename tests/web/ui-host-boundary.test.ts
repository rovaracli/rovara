import { ESLint } from "eslint";
import { expect, it } from "vitest";
it("keeps UI I/O behind AppHost and catches a bare contracts import", async () => {
 const eslint = new ESLint();const results = await eslint.lintFiles(["packages/ui/src"]);expect(results.flatMap(result => result.messages.filter(message => message.severity === 2).map(message => `${result.filePath}:${message.ruleId}:${message.message}`))).toEqual([]);
 const fixture = await eslint.lintText('import { AgentIdSchema } from "@agentx/contracts"; void AgentIdSchema;', { filePath: "packages/ui/src/Probe.tsx" });expect(fixture.flatMap(result => result.messages).some(message => message.ruleId === "no-restricted-imports")).toBe(true);
}, 60_000);

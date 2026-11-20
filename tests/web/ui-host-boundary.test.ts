import { ESLint } from "eslint";
import { expect, it } from "vitest";

// This one lint pass covers every UI source file and takes about 22 s locally;
// give it room to finish when the shared CI worker is under load.
it("keeps UI I/O behind AppHost and catches a bare contracts import", async () => {
  const eslint = new ESLint();
  const [results, contractsProbe, ioProbe] = await Promise.all([
    eslint.lintFiles(["packages/ui/src"]),
    eslint.lintText(
      'import { AgentIdSchema } from "@agentx/contracts"; void AgentIdSchema;',
      { filePath: "packages/ui/src/Probe.tsx" },
    ),
    eslint.lintText('void fetch("/probe");', {
      filePath: "packages/ui/src/Probe.tsx",
    }),
  ]);

  expect(
    results.flatMap((result) =>
      result.messages
        .filter((message) => message.severity === 2)
        .map(
          (message) =>
            `${result.filePath}:${message.ruleId}:${message.message}`,
        ),
    ),
  ).toEqual([]);
  expect(
    contractsProbe.flatMap((result) => result.messages).some(
      (message) => message.ruleId === "no-restricted-imports",
    ),
  ).toBe(true);
  expect(
    ioProbe.flatMap((result) => result.messages).some(
      (message) => message.ruleId === "no-restricted-globals",
    ),
  ).toBe(true);
}, 120_000);

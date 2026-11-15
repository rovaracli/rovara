// Prints contract v0 (packages/contracts/src/code-contract-v0.ts) as markdown tables: `npm run contract:table > table.md`, or pass a file to write.
import { writeFileSync } from "node:fs";
import { APP_ROUTES, CODE_ROUTES, contractCounts } from "../packages/contracts/src/code-contract-v0.js";

const yes = (value: boolean) => (value ? "yes" : "no");
const cell = (text: string) => text.replace(/\|/gu, "\\|");
const lines: string[] = [];
const counts = contractCounts();

lines.push("### Counts", "");
lines.push(`- Cloud to Code routes: ${String(counts.codeRoutes)}. Needed by a must-pass screen: ${String(counts.codeNeeded)}. Of those: served on the deployed API of code/next ${String(counts.neededServed)}, not served ${String(counts.neededMissing)} (${String(counts.neededMainlineOnly)} of those are on mainline and arrive with the second sync, ${String(counts.neededArrivesWithE2)} exist only in the laptop core and arrive with E2, the core on AWS).`);
lines.push(`- Web app routes: ${String(counts.appRoutes)}. On a must-pass screen: ${String(counts.appMustPass)}. Answered by cloud/next's cloud-server today: ${String(counts.appCloudServerToday)}. Same path already in code/next's laptop core: ${String(counts.appCodeCoreLocal)}.`, "");

lines.push("### Layer 1: Cloud to Code (typed in `CodeRouteTypes`)", "");
lines.push("| Id | Method | Path | What | Scope | Screens | On code/next deployed API | On mainline | Evidence | Arrives with | Cloud calls today |", "|---|---|---|---|---|---|---|---|---|---|---|");
for (const route of CODE_ROUTES) {
  lines.push(`| \`${route.id}\` | ${route.method} | \`${route.path}\` | ${cell(route.summary)} | ${route.scope} | ${route.screens.join(", ")} | ${route.awsApi} | ${yes(route.mainline)} | ${route.evidence === "none" ? "none" : `\`${route.evidence}\``} | ${route.arrivesWith === undefined ? "" : cell(route.arrivesWith)} | ${yes(route.cloudCallsToday)} |`);
}

lines.push("", "### Layer 2: web app to Cloud (`/v1/app/*`)", "");
lines.push("| Method | Path | Owner | Screen | Backed by Code route(s) | App module (integ/0519) | Cloud answers today | Laptop core has path |", "|---|---|---|---|---|---|---|---|");
for (const route of APP_ROUTES) {
  lines.push(`| ${route.method} | \`${route.path}\` | ${route.owner} | ${route.screen} | ${route.codeRoutes.map((id) => `\`${id}\``).join(", ") || "none (Cloud's own tables)"} | ${route.source} | ${yes(route.cloudServerToday)} | ${yes(route.codeCoreLocal)} |`);
}

const text = `${lines.join("\n")}\n`;
if (process.argv[2] === undefined) process.stdout.write(text);
else writeFileSync(process.argv[2], text);

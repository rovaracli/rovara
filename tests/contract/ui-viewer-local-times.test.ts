import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { expect, it } from "vitest";

// Calendar buckets are server-defined periods, not instants to shift with the viewer.
const exceptions = new Set([
 "screens/project/ProjectScreen.tsx:month",
 "screens/admin/people-limits/PeopleLimitsScreen.tsx:monthName",
 "screens/admin/spending/SpendingSummary.tsx:monthName",
 "screens/admin/spending/SpendingSummary.tsx:dayName",
]);
// Exact non-display expressions only: never exempt an entire screen or formatter.
const isoExceptions = new Map([
 ["screens/setup/wiki/NightlyUpkeep.tsx:SpendLine", "newDate().toISOString().slice(0,7)"], // Compare the server's UTC accounting month.
 ["screens/agents/AgentProfileScreen.tsx:[month]", "newDate().toISOString().slice(0,7)"], // UTC month sent to the spending API.
 ["screens/admin/audit/AuditScreen.tsx:utc", "date.toISOString().slice(0,value.length)"], // Validate the explicitly UTC range input, not a display.
]);
// Exact owner + consuming expression, with a reason for every non-display conversion.
// Relative-time consumers accept ISO input, then format it locally themselves.
const isoCallExceptions = new Map([
 ["api/admin-report.ts:monthStart:(now:Date):string=>newDate(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString()", "UTC accounting boundary serialized for report queries"],
 ["api/admin-report.ts:rangeBounds:from:newDate(start).toISOString()", "Report query lower bound"],
 ["api/admin-report.ts:rangeBounds:from:newDate(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString()", "Report query lower bound"],
 ["api/admin-report.ts:rangeBounds:to:newDate(start-1).toISOString()", "Report query upper bound"],
 ["api/admin-report.ts:rangeBounds:from:newDate(now.getTime()-90*DAY).toISOString()", "Report query lower bound"],
 ["api/task-action.ts:pendingNow:startedAt:newDate(p.startedAt).toISOString()", "Pending-action recovery record"],
 ["api/task-action.ts:runTaskAction:startedAt:newDate(request.startedAt).toISOString()", "Pending-action recovery record"],
 ["api/task-action.ts:useTaskAction:startedAt:newDate(saved.request.startedAt).toISOString()", "Pending-action recovery record"],
 ["screens/company-money-ai-read/action-host.ts:entry:startedAt:newDate().toISOString()", "Pending-action lock record (stored in localStorage, never displayed)"],
 ["screens/admin/MembersScreen.tsx:action:checkedAt:newDate().toISOString()", "Role receipt instant, formatted by its consumer"],
 ["screens/agents/AgentProfileScreen.tsx:[month]:newDate().toISOString().slice", "UTC spending API month, sliced by the separately guarded expression"],
 ["screens/inbox/InboxPreviewScreen.tsx:updated:updatedWords(newDate(tasks.dataUpdatedAt).toISOString(),now)", "Input to updatedWords relative-time formatter"],
 ["screens/project/LearnedSection.tsx:LearnedLesson:at={newDate(lesson.became.at).toISOString()}", "Input to RelativeTime, not its displayed output"],
 ["screens/project/LearnedSection.tsx:RetireRequests:at={newDate(request.at).toISOString()}", "Input to RelativeTime, not its displayed output"],
 ["screens/session/Composer.tsx:change:setDraftAt(newDate().toISOString())", "Stored draft creation instant"],
 ["screens/session/MergeSection.tsx:press:startedAt:newDate().toISOString()", "Persisted merge request recovery record"],
 ["screens/session/MergeSection.tsx:answer:acceptedAt:newDate().toISOString()", "Persisted accepted merge receipt"],
 ["screens/session/MergeSection.tsx:readAt:readiness.dataUpdatedAt>0?newDate(readiness.dataUpdatedAt).toISOString():undefined", "Input to local Clock and relative-time consumers"],
 ["screens/session/PeoplePanel.tsx:PeoplePanel:clockTime(newDate(staleSince).toISOString())", "Input to viewer-local clockTime"],
 ["screens/session/PrFeedbackCard.tsx:when:clockTime(newDate(request.startedAt).toISOString())", "Input to viewer-local clockTime (the time the person pressed the button)"],
 ["screens/session/talk-lifecycle.ts:actionHost:startedAt:newDate(request.startedAt).toISOString()", "Pending talk request recovery record"],
 ["screens/session/talk-lifecycle.ts:lock:startedAt:newDate().toISOString()", "Pending talk request recovery record"],
 ["screens/work/WorkPreviewScreen.tsx:updated:updatedWords(newDate(tasks.dataUpdatedAt).toISOString(),now)", "Input to updatedWords relative-time formatter"],
 ["screens/work/queue-action-host.ts:entry:startedAt:newDate().toISOString()", "Serialized queue action recovery record"],
 ["screens/admin/audit/AuditScreen.tsx:utc:date.toISOString().slice", "Explicit UTC input validation and API query serialization"],
 ["screens/admin/audit/AuditScreen.tsx:utc:returndate.toISOString();", "Explicit UTC input validation and API query serialization"],
 ["screens/admin/projects/SlackBindEditor.tsx:reviewedAt:reviewedAt=newDate().toISOString()", "Reviewed bind request timestamp"],
 ["screens/admin/projects/SlackDecisionEditor.tsx:request:reviewedAt:newDate().toISOString()", "Reviewed decision request timestamp"],
 ["screens/admin/projects/SlackLinksEditor.tsx:request:reviewedAt:newDate().toISOString()", "Reviewed unbind request timestamp"],
 ["screens/setup/wiki/NightlyUpkeep.tsx:SpendLine:newDate().toISOString().slice", "UTC accounting month, sliced by the separately guarded expression"],
]);
function isIsoSlice(node: ts.Node): node is ts.CallExpression {
 if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !["slice", "substring", "substr"].includes(node.expression.name.text)) return false;
 const receiver = node.expression.expression, start = node.arguments[0], end = node.arguments[1];
 const isoString = ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.name.text === "toISOString";
 const instantName = ts.isIdentifier(receiver) ? receiver.text === "iso" : ts.isPropertyAccessExpression(receiver) && /^(at|.*At)$/.test(receiver.name.text);
 return isoString || (start !== undefined && ts.isNumericLiteral(start) && (start.text === "11" || (start.text === "0" && end !== undefined && ts.isNumericLiteral(end) && end.text === "10" && instantName)));
}
function violations(root: string): string[] {
 const hits: string[] = [];
 for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
  const path = resolve(entry.parentPath, entry.name), name = relative(root, path);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
   const fixedZone = ts.isPropertyAssignment(node) && node.name.getText(source) === "timeZone";
   let owner: ts.Node | undefined = node.parent;
   while (owner !== undefined && !ts.isVariableDeclaration(owner)) owner = owner.parent;
   const calendarBucket = owner !== undefined && ts.isVariableDeclaration(owner) && exceptions.has(`${name}:${owner.name.getText(source)}`) && ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer) && node.initializer.text === "UTC";
   const suffix = (ts.isStringLiteralLike(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) && / UTC\b/.test(node.text);
   // Audit range inputs deliberately take UTC, while record and read times are local.
   const auditInput = name === "screens/admin/audit/AuditScreen.tsx" && ts.isStringLiteral(node) && node.text === "Enter valid UTC dates and times.";
   let isoOwner: ts.Node | undefined = node.parent;
   while (isoOwner !== undefined && !ts.isVariableDeclaration(isoOwner) && !ts.isFunctionDeclaration(isoOwner)) isoOwner = isoOwner.parent;
   const isoOwnerName = isoOwner !== undefined && (ts.isVariableDeclaration(isoOwner) || ts.isFunctionDeclaration(isoOwner)) ? isoOwner.name?.getText(source) : undefined;
   const isoSlice = isIsoSlice(node) && isoExceptions.get(`${name}:${isoOwnerName}`) !== node.getText(source).replace(/\s+/gu, "");
   const isoCall = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toISOString" && !isoCallExceptions.has(`${name}:${isoOwnerName}:${(ts.isJsxExpression(node.parent) ? node.parent.parent : node.parent).getText(source).replace(/\s+/gu, "")}`);
   if ((fixedZone && !calendarBucket) || (suffix && !auditInput) || isoSlice || isoCall) hits.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
   ts.forEachChild(node, visit);
  }
  visit(source);
 }
 return [...new Set(hits)];
}
it("keeps UI timestamps viewer-local except documented UTC calendar buckets and audit inputs", () => {
 expect(violations(resolve("packages/ui/src"))).toEqual([]);
});

it("does not exempt a new timestamp merely because its file also formats a UTC billing bucket", () => {
 const root = mkdtempSync(join(tmpdir(), "viewer-local-guard-"));
 try {
  mkdirSync(join(root, "screens/admin/spending"), { recursive: true });
  writeFileSync(join(root, "screens/admin/spending/SpendingSummary.tsx"), 'const monthName = () => ({ timeZone: "UTC" });\nconst checkedAt = () => ({ timeZone: "UTC" });\n');
  writeFileSync(join(root, "timestamp.tsx"), 'const clock = { timeZone: "America/New_York" };\nconst text = " UTC";\nconst view = <span>Checked UTC.</span>;\n');
  expect(violations(root).sort()).toEqual(["screens/admin/spending/SpendingSummary.tsx:2", "timestamp.tsx:1", "timestamp.tsx:2", "timestamp.tsx:3"]);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

// These regressions used to show UTC without saying so, even with no fixed timeZone option.
it("rejects ISO slicing for display, including whitespace, substring and date prefixes", () => {
 const root = mkdtempSync(join(tmpdir(), "viewer-local-iso-guard-"));
 try {
  writeFileSync(join(root, "timestamp.tsx"), [
   'const time = (iso: string) => iso.slice(11, 19);',
   'const history = event.at .slice( 11, 16 );',
   'const stamp = iso.substring(11, 19);',
   'const old = iso.substr(11, 8);',
   'const date = new Date().toISOString().slice(0, 10);',
   'const dateWords = (at: number) => new Date(at).toISOString().substring(0, 10);',
   'const day = iso.slice(0, 10);',
   'const failure = event.at.slice(0, 10);',
   'const recorded = service.recordedAt.substring(0, 10);',
   'const built = image.builtAt.slice(0, 10);',
   'const harmless = items.slice(0, 10);',
   'const sha = commit.slice(0, 7);',
   'const local = new Date(iso).toLocaleString();',
  ].join("\n"));
  expect(violations(root)).toEqual(Array.from({ length: 10 }, (_, index) => `timestamp.tsx:${index + 1}`));
 } finally { rmSync(root, { recursive: true, force: true }); }
});

it("allows only the named accounting and audit-parser expressions, keeping other displays guarded", () => {
 const root = mkdtempSync(join(tmpdir(), "viewer-local-exceptions-"));
 try {
  const cases = [
   ["screens/setup/wiki/NightlyUpkeep.tsx", 'function SpendLine() { if (spend.month !== new Date().toISOString().slice(0, 7)) return null; }', 'const display = new Date().toISOString().slice(0, 7);'],
   ["screens/agents/AgentProfileScreen.tsx", 'function Spend() { const [month] = useState(() => new Date().toISOString().slice(0, 7)); }', 'const display = new Date().toISOString().slice(0, 7);'],
   ["screens/admin/audit/AuditScreen.tsx", 'function utc(value: string) { return date.toISOString().slice(0, value.length) !== value; }', 'const display = date.toISOString().slice(0, value.length);'],
  ] as const;
  for (const [file, allowed, display] of cases) {
   const path = join(root, file);
   mkdirSync(resolve(path, ".."), { recursive: true });
   writeFileSync(path, allowed + "\n" + display + "\nconst newTimestamp = iso.slice(11, 19);\n");
  }
  expect(violations(root).sort()).toEqual(cases.flatMap(([file]) => [`${file}:2`, `${file}:3`]).sort());
 } finally { rmSync(root, { recursive: true, force: true }); }
});


it("rejects unsliced ISO display in text, tooltips, templates and display helpers", () => {
 const root = mkdtempSync(join(tmpdir(), "viewer-local-direct-iso-"));
 try {
  writeFileSync(join(root, "timestamp.tsx"), [
   'const text = <p>Checked: {new Date(at).toISOString()}</p>;',
   'const tooltip = <time title={new Date(at).toISOString()} />;',
   'const message = `Recovery until ${new Date(at).toISOString()}`;',
   'const words = (at: number) => new Date(at) .toISOString( );',
   'const stamp = date.toISOString();',
  ].join("\n"));
  expect(violations(root)).toEqual(Array.from({ length: 5 }, (_, index) => `timestamp.tsx:${index + 1}`));
 } finally { rmSync(root, { recursive: true, force: true }); }
});
it("allows a named machine serialization without exempting another display in the same file", () => {
 const root = mkdtempSync(join(tmpdir(), "viewer-local-machine-iso-"));
 try {
  mkdirSync(join(root, "screens/session"), { recursive: true });
  writeFileSync(join(root, "screens/session/Composer.tsx"), 'function change() { setDraftAt(new Date().toISOString()); }\nfunction change() { return <p>{new Date().toISOString()}</p>; }\nconst display = new Date().toISOString();\n');
  expect(violations(root)).toEqual(["screens/session/Composer.tsx:2", "screens/session/Composer.tsx:3"]);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

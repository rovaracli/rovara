import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("record subjects require actionSubject at compile time, including selectors and payloads", () => {
 const file = resolve("tests/web/safe-action-subject.fixture.ts");
 const source = `
import { actionSubject, createActionRecords, type RecordConfig } from "../../packages/ui/src/safe-action.js";
type Subject = ReturnType<typeof actionSubject>;
type Pending = { subject: Subject; requestId: string; startedAt: string };
type Answer = { subject: Subject; requestId: string };
declare const records: ReturnType<typeof createActionRecords<Pending, Answer>>;
declare const config: RecordConfig<Pending, Answer>;
const subject = actionSubject({ orgId: "org-a", developerId: "person-a", subjectId: "task-a" });
const pending = { subject, requestId: "request", startedAt: "time" };
const answer = { subject, requestId: "request" };
records.readPendingNow(subject); records.readAcceptedNow(subject);
records.parsePending(null, subject); records.parseAccepted(null, subject);
records.usePending(subject); records.useAccepted(subject);
records.writePending(pending); records.writeAccepted(answer);
records.claimPending(pending, () => undefined, "storage");
records.recordAccepted(pending, answer); records.acceptedStoredExactly(answer);
records.clearPending(subject, "request", "time"); records.clearAccepted(subject, "request");
records.lockName(pending);
// @ts-expect-error raw strings cannot construct the brand
const raw: Subject = "org-a|person-a|task-a";
// @ts-expect-error record reads require a built subject
records.readPendingNow("raw");
// @ts-expect-error accepted reads require a built subject
records.readAcceptedNow("raw");
// @ts-expect-error pending parsers require a built subject
records.parsePending(null, "raw");
// @ts-expect-error accepted parsers require a built subject
records.parseAccepted(null, "raw");
// @ts-expect-error pending hooks require a built subject
records.usePending("raw");
// @ts-expect-error accepted hooks require a built subject
records.useAccepted("raw");
// @ts-expect-error pending clears require a built subject
records.clearPending("raw", "request", "time");
// @ts-expect-error accepted clears require a built subject
records.clearAccepted("raw", "request");
// @ts-expect-error a selector cannot bypass identity construction
config.pendingSubject = () => "raw";
// @ts-expect-error accepted selectors cannot bypass identity construction
config.acceptedSubject = () => "raw";
// @ts-expect-error pending writes cannot carry a raw subject
records.writePending({ ...pending, subject: "raw" });
// @ts-expect-error accepted writes cannot carry a raw subject
records.writeAccepted({ ...answer, subject: "raw" });
// @ts-expect-error claiming cannot carry a raw subject
records.claimPending({ ...pending, subject: "raw" }, () => undefined, "storage");
// @ts-expect-error recording cannot carry a raw subject
records.recordAccepted(pending, { ...answer, subject: "raw" });
// @ts-expect-error readback cannot carry a raw subject
records.acceptedStoredExactly({ ...answer, subject: "raw" });
// @ts-expect-error lock derivation cannot carry a raw subject
records.lockName({ ...pending, subject: "raw" });
`;
 const options: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2023.d.ts", "lib.dom.d.ts"] };
 const host = ts.createCompilerHost(options), getSourceFile = host.getSourceFile.bind(host);
 host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === file ? ts.createSourceFile(name, source, languageVersion, true) : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
 const program = ts.createProgram([file], options, host);
 expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
});

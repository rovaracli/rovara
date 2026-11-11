import { VisibleText } from "../../design/VisibleText.js";
import { collapseFallbacks, fallbackSentence, stageName } from "./model-fallbacks.js";
import { taskPageFlags } from "./task-page-flags.js";
import type { ReadTask } from "./workspace-types.js";
/**
 * One plain line when a stage ran on a different model than wanted, with the raw model ids and any repeats behind "Details" (experience lane). Nothing when there was no fallback.
 * With `plainNotices` off, the old per-stage "Used X because Y was unavailable." list. Model ids are model text, so they show as plain text.
 */
export function ModelFallbackNotes({ task }: { task: ReadTask }) {
 const notes = task.modelFallbacks ?? [];
 if (notes.length === 0) return null;
 if (!taskPageFlags().plainNotices) return <section aria-label="Model changes" className="rv-model-fallbacks"><ul>{notes.map((note, index) => <li key={String(index)}><span className="rv-muted">{stageName(note.stage)}</span> <VisibleText text={fallbackSentence(note)} /></li>)}</ul></section>;
 const collapsed = collapseFallbacks(notes)!;
 return <section aria-label="Model changes" className="rv-model-fallbacks"><p className="rv-model-fallback-line">{collapsed.line}.</p><details className="rv-model-fallback-details"><summary>Details</summary><ul>{collapsed.details.map((row, index) => <li key={String(index)}><span className="rv-muted">{stageName(row.stage)}</span> <VisibleText text={row.sentence} />{row.count > 1 && <span className="rv-muted">{" (recorded " + String(row.count) + " times)"}</span>}</li>)}</ul></details></section>;
}

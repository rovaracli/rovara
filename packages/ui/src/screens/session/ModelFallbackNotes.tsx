import { VisibleText } from "../../design/VisibleText.js";
import { fallbackSentence, readModelFallbacks, stageName } from "./model-fallbacks.js";
import type { ReadTask } from "./workspace-types.js";
/** "Used X because Y was unavailable." for each stage that ran on a different model than wanted. Nothing when there was no fallback. Model ids are model text, so they show as plain text. */
export function ModelFallbackNotes({ task }: { task: ReadTask }) {
 const notes = readModelFallbacks(task);
 if (notes.length === 0) return null;
 return <section aria-label="Model changes" className="rv-model-fallbacks"><ul>{notes.map((note, index) => <li key={String(index)}><span className="rv-muted">{stageName(note.stage)}</span> <VisibleText text={fallbackSentence(note)} /></li>)}</ul></section>;
}

import { Button } from "../../design/Button.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import type { ReadSession } from "./SessionHeader.js";
import { visibleAnchor, type ReadTask, type CommentOnPart } from "./workspace-types.js";
export function ChangesTab({ session, task, onComment }: { session: ReadSession; task: ReadTask; onComment?: CommentOnPart | undefined }) {
 return <section aria-label="Changed files">{task.changedFiles?.length ? <ul className="rv-changed-files">{task.changedFiles.map(file => { const anchor = visibleAnchor(session, "change_file", file.repository + ":" + file.path);return <li key={file.repository + ":" + file.path}><div><strong><VisibleText text={file.path} /></strong><p className="rv-muted"><VisibleText text={file.repository} /></p><p>{file.added} lines added, {file.removed} removed</p></div>{anchor && onComment && <Button variant="quiet" aria-label={"Comment on " + visibleText(file.path)} onClick={event => onComment(anchor, event.currentTarget)}>Comment</Button>}</li>; })}</ul> : <p>No changed files are available yet.</p>}</section>;
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { RETIRE_REASONS, useLearnedApi, learnedKey } from "../../../api/learned.js";
import { useLessonsExtrasApi } from "../../../api/lessons-extras.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { ApiError } from "../../../api/errors.js";

export function KeepCard({ project, lesson, onDone }: { project: string; lesson: Record<string, unknown>; onDone?: () => void }) {
 const query = useQueryClient(), api = useLessonsExtrasApi(), learned = useLearnedApi(), announce = useAnnounce();
 const [busy, setBusy] = useState(false), [reason, setReason] = useState("not_useful"), [retiring, setRetiring] = useState(false), [message, setMessage] = useState("");
 const id = typeof lesson["lessonId"] === "string" ? lesson["lessonId"] : typeof lesson["id"] === "string" ? lesson["id"] : "", title = typeof lesson["title"] === "string" ? lesson["title"] : "Lesson", area = typeof lesson["area"] === "string" ? lesson["area"] : "the whole project";
 async function finish(text: string) { setMessage(text);announce(text);await query.invalidateQueries({ queryKey: learnedKey(project) });onDone?.(); }
 async function keep() { if (busy) return;setBusy(true);setMessage("");try { await api.keep(project, id);await finish("Kept. Rovara will keep giving it to tasks where it fits."); } catch (e) { if (e instanceof ApiError && e.status === 409) await finish("Someone already answered this.");else setMessage("That didn't go through. Nothing was changed."); } finally { setBusy(false); } }
 async function retire() { if (busy) return;setBusy(true);try { await learned.retire(project, id, reason as never);await finish("Retired. Rovara no longer gives it to tasks."); } catch { setMessage("That didn't go through. Nothing was changed."); } finally { setBusy(false); } }
 if (lesson["cause"] !== "asked_to_keep") return null;
 const repeat = typeof lesson["repeat"] === "object" && lesson["repeat"] !== null ? lesson["repeat"] as Record<string, unknown> : undefined;
 return <article className="rv-graduation-card" data-testid="keep-card"><h4>Keep it?</h4><p><Link to={`/app/projects/${encodeURIComponent(project)}?tab=how-we-work&lesson=${encodeURIComponent(id)}`}><strong><VisibleText text={title} /></strong></Link></p><p>No task has needed this lesson for a long time.</p><p className="rv-muted">Applies to: <VisibleText text={area} /></p>{repeat === undefined ? null : <p className="rv-muted">Since this lesson: the correction came back {String(repeat["back"])} times in {String(repeat["matched"])} matching tasks.</p>}<p className="rv-muted">If nobody answers, Rovara stops giving it to tasks.</p>{retiring ? <div><Select label="Why retire this lesson?" value={reason} options={RETIRE_REASONS} onValueChange={setReason} /><Button busy={busy} variant="danger" onClick={() => { void retire(); }}>Retire</Button><Button variant="quiet" onClick={() => setRetiring(false)}>Cancel</Button></div> : <div><Button busy={busy} variant="primary" onClick={() => { void keep(); }}>Keep</Button><Button variant="quiet" disabled={busy} onClick={() => setRetiring(true)}>Retire</Button></div>}{message && <p role="status">{message}</p>}</article>;
}

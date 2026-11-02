import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { savedEnvKey, useSavedEnvApi, useSavedEnvPanel } from "../../api/saved-env.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { ENV as T, failureText, healthText, imageText, lastReasonText, rebuildText } from "./environment-panel-text.js";
import "./learning.css";

/**
 * The project's saved environment (SH26): its health, how old the saved copy is, why the last rebuild was started, and Reset for a maintainer. Every sentence is a fixed one; the server sends words, counts and times.
 * Where saved environments are not on (the route answers 404) the panel shows nothing at all. A read that fails otherwise is a quiet sentence with Try again, not an alert: the panel is a secondary part of the page. Reset asks for a rebuild once per press and shows the server's answer as the new panel; a person who cannot reset sees no button (the server says so in `canReset`).
 */
export function EnvironmentPanel({ project }: { project: string }) {
 const read = useSavedEnvPanel(project), api = useSavedEnvApi(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 if (read.isPending) return <section className="rv-project-section rv-learning" aria-label={T.HEADING}><Skeleton label={T.LOADING} /></section>;
 if (read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403)) return null;
 if (read.data === undefined) return <section className="rv-project-section rv-learning" aria-label={T.HEADING}><h2>{T.HEADING}</h2><p>{T.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button></section>;
 const panel = read.data;
 async function reset() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await api.reset(project);
   query.setQueryData(savedEnvKey(project), answer.panel);
   setMessage({ kind: "status", text: answer.status === "queued" ? T.RESET_QUEUED : T.RESET_NOTHING });
  } catch (error) {
   setMessage({ kind: "alert", text: error instanceof ApiError && error.status === 403 ? T.RESET_REFUSED : T.RESET_FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 return <section className="rv-project-section rv-learning" aria-label={T.HEADING} aria-busy={busy}>
  <h2>{T.HEADING}</h2>
  <p className="rv-muted">{T.HELP}</p>
  <p><strong>{healthText(panel.health)}</strong></p>
  <p>{panel.image === undefined ? T.NO_IMAGE : imageText(panel.image)}</p>
  {panel.rebuild !== undefined && <p>{rebuildText(panel.rebuild)}</p>}
  {panel.lastRebuildReason !== undefined && <p className="rv-muted">{lastReasonText(panel.lastRebuildReason)}</p>}
  {panel.lastFailure !== undefined && <p className="rv-muted">{failureText(panel.lastFailure)}</p>}
  {panel.canReset ? <><p className="rv-muted">{T.RESET_HELP}</p><Button busy={busy} disabled={busy} onClick={() => { void reset(); }}>{T.RESET}</Button></> : <p className="rv-muted">{T.ONLY_MAINTAINER}</p>}
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert">{message.text}</p>}
 </section>;
}

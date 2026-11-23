import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLessonsExtrasApi, useWeeklySummary } from "../../../api/lessons-extras.js";
import { learnedKey, type LessonMode } from "../../../api/learned.js";
import { lessonsOff, notServed } from "../../../api/learned.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { WriteRegion } from "../write-freeze.js";
import { Skeleton } from "../../../design/Skeleton.js";

export function WeeklySummaryRow({ project, mode }: { project: string; mode: LessonMode }) {
 const read = useWeeklySummary(project), api = useLessonsExtrasApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [error, setError] = useState("");
 if (read.isPending) return <Skeleton label="Loading the weekly summary setting" />;
 if (read.isError) {
  if (lessonsOff(read.error) || notServed(read.error) || (read.error instanceof ApiError && read.error.status === 403)) return null;
  return <section role="alert"><p>Couldn't load the weekly summary setting. Try again.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 }
 const data = read.data;
 async function change(on: boolean) { setBusy(true);setError("");try { const result = await api.setSummary(project, on);if (result.kind !== "done") throw new Error();query.setQueryData([...learnedKey(project), "weekly-summary"], result.value);await query.invalidateQueries({ queryKey: learnedKey(project) }); } catch { setError("Couldn't save that. Reload to check where it stands."); } finally { setBusy(false); } }
 return <section className="rv-learned-mode" data-testid="weekly-summary"><WriteRegion><h3>Weekly summary in chat</h3><p className="rv-muted">{data.on ? "On. Once a week, the people who decide this project's lessons get a short message: what is waiting, what expires soon, what is fading. Sent only when there is something to say." : "Off. Nobody gets a weekly message. Suggestions still wait here."}</p>{data.source === "pilot_default" ? <p className="rv-muted">On by default for your company. Turn it off here for this project.</p> : data.source === "default" ? <p className="rv-muted">Off by default.</p> : null}<p className="rv-muted">Each person gets it in the chat they chose in their own notice settings.</p>{mode === "off" && <p className="rv-muted">Learning is off, so nothing is sent.</p>}{data.canChange ? <label>Weekly summary <input type="checkbox" checked={data.on} disabled={busy} onChange={event => { void change(event.currentTarget.checked); }} /></label> : <p className="rv-muted">Only a project maintainer, or a company owner or admin, can change this.</p>}{error && <p role="alert">{error}</p>}</WriteRegion></section>;
}

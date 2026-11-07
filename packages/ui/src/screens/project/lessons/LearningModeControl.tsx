import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LearningMode } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { lessonsKey } from "../../../api/lessons.js";
import { learningModeKey, useLearningMode, useLearningModeWrite } from "../../../api/learning-mode.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { T } from "./lessons-text.js";
import { MODE_ORDER, MODE_WORDS } from "./learning-mode-words.js";

const looser = (left: LearningMode, right: LearningMode) => MODE_ORDER.indexOf(left) > MODE_ORDER.indexOf(right);

/** Why a mode change was refused, in fixed words by code. */
function refusal(error: unknown): string {
 const code = error instanceof ApiError ? error.code : "";
 if (code === "LEARNING_LOCKED") return "Your company keeps learning stricter than that for every project.";
 if (code === "CHANGE_STALE") return "Someone changed how this project learns. It was read again; check it and try again.";
 if (code === "FORBIDDEN") return "Only a maintainer of this project, or a company admin, in a browser, can change how it learns.";
 if (code === "PROJECT_ARCHIVED") return "This project is archived, so how it learns can't be changed. Restore it first.";
 if (code === "TEAM_RECORD_PAUSED") return "The team record is paused in this installation, so nothing is learned until it is resumed.";
 if (code === "AUDIT_UNAVAILABLE") return "This change needs the audit ledger, which isn't available right now. Try again later.";
 return "Couldn't change how this project learns. Try again.";
}

/**
 * How this project learns: Off, Collect, Suggest or On, set here by a maintainer (UX-4b). The company's lock wins, so a mode looser than it is offered but disabled, with the reason.
 * When the team record isn't set up in this installation it says so, with the cause and who can change it.
 */
export function LearningModeControl({ project, compact = false }: { project: string; compact?: boolean }) {
 const read = useLearningMode(project), write = useLearningModeWrite(project), query = useQueryClient();
 const [choice, setChoice] = useState<LearningMode>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 if (read.isPending) return <p className="rv-muted" role="status">Loading how this project learns</p>;
 if (read.isError) {
  const gone = read.error instanceof ApiError && read.error.status === 404;
  if (read.error instanceof ApiError && read.error.code === "TEAM_RECORD_PAUSED") return <div className="rv-learning-mode"><p className="rv-muted">The team record is paused in this installation: nothing new is captured or learned. Whoever runs the installation resumes it with agentx config set teamRecord.enabled 1.</p></div>;
  return <div className="rv-learning-mode"><p className={gone ? "rv-muted" : undefined} role={gone ? undefined : "alert"}>{gone ? T.SOURCES_UNAVAILABLE : "Couldn't read how this project learns."}</p>{!gone && <Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button>}</div>;
 }
 const view = read.data, picked = choice ?? view.mode;
 async function save() {
  setBusy(true);setError(undefined);setSaved(false);
  try {
   const next = await write.send({ requestId: crypto.randomUUID(), mode: picked, expectedMode: view.mode });
   query.setQueryData(learningModeKey(project), next);
   setChoice(undefined);setSaved(true);
   await query.invalidateQueries({ queryKey: lessonsKey(project) });
  } catch (caught) {
   setError(refusal(caught));
   if (caught instanceof ApiError && caught.code === "CHANGE_STALE") { setChoice(undefined);await read.refetch(); }
  } finally { setBusy(false); }
 }
 const status = <p>{"Learning: "}<strong>{MODE_WORDS[view.effective].label}</strong>{". " + MODE_WORDS[view.effective].means}{view.lock !== undefined && view.lock !== view.mode && looser(view.mode, view.lock) && <span className="rv-muted">{" Your company keeps it at " + MODE_WORDS[view.lock].label + " for every project."}</span>}</p>;
 if (!view.canChange) return <div className="rv-learning-mode">{status}{!compact && <p className="rv-muted">A maintainer of this project can change how it learns.</p>}</div>;
 return <div className="rv-learning-mode">
  {status}
  <Select label="How this project learns" value={picked} disabled={busy} onValueChange={value => { setChoice(value as LearningMode);setSaved(false); }} options={MODE_ORDER.map(mode => ({ value: mode, label: MODE_WORDS[mode].label + (view.lock !== undefined && looser(mode, view.lock) ? " (your company keeps it stricter)" : ""), disabled: view.lock !== undefined && looser(mode, view.lock) }))} />
  {picked !== view.mode && <p className="rv-muted">{MODE_WORDS[picked].means}</p>}
  <Button variant="primary" busy={busy} disabled={picked === view.mode} onClick={() => { void save(); }}>{picked === "off" ? "Turn learning off" : view.mode === "off" ? "Turn learning on" : "Save"}</Button>
  {saved && <p role="status">Saved. This project now learns in {MODE_WORDS[view.mode].label} mode.</p>}
  {error !== undefined && <p role="alert">{error}</p>}
 </div>;
}

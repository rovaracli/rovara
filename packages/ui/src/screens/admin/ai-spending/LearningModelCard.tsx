// DEC 254zzz63 (Code #1075): "Lessons learning model", beside the engine model in Company settings, AI. The model Rovara's lessons learn with is the company's choice; until the
// company chooses, it is this Rovara's default (Claude Haiku 5.5 unless the install says otherwise). Everyone in the company sees what it is and whose choice it is; an owner or admin
// picks from the Claude models the company's gateway offers it now, or goes back to the default. Every refusal shown is the server's own fixed sentence; a read that fails says fixed words.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LEARNING_MODEL_PATH, learningModelLabel, readLearningModel, type LearningModelRead } from "../../../api/learning-model.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { BACK_TO_DEFAULT, DEFAULT_MODEL, defaultModelText, modelScopeId, useModelScope } from "../../setup/model-scope.js";
import { VisibleText } from "../../../design/VisibleText.js";

export const LEARNING_MODEL_CARD_WORDS = Object.freeze({
 title: "Lessons learning model",
 intro: "The AI model Rovara's lessons learn with. Learning has its own model and does not follow task source order. Current source, readiness, pause state and price are unavailable here.",
 companyChoice: "Your choice",
 installDefault: "Rovara's default",
 noDefault: "Current model can't be shown yet.",
 pick: "Learning model",
 pickHint: "Claude models your company can use now.",
 readOnly: "Only a company owner or admin can change this. Ask one of them.",
 noneOffered: "No Claude model is offered to your company right now, so this can't be changed yet.",
 notOffered: "This model isn't offered to your company now. Pick one from the list.",
 save: "Save learning model",
 useDefault: BACK_TO_DEFAULT,
 saved: "Saved.",
 savedDefault: "Saved. Lessons use this Rovara's default again.",
 notYet: "Choosing the lessons learning model isn't available on this Rovara yet.",
 unavailable: "The lessons learning model couldn't be read just now. Try again in a moment.",
 failed: "Couldn't load the lessons learning model. Try again.",
 saveFailed: "Couldn't save that. Try again.",
});
const W = LEARNING_MODEL_CARD_WORDS;
type Notice = { ok: boolean; text: string } | undefined;

export function LearningModelCard({ developerId, role, orgId = "" }: { developerId: string; role: string; orgId?: string }) {
 return <ScopedLearningModel key={modelScopeId(orgId, developerId, role)} {...{ developerId, role, orgId }} />;
}
function ScopedLearningModel({ developerId, role, orgId }: { developerId: string; role: string; orgId: string }) {
 const scope = useModelScope("ai-spend", orgId, developerId, role, "learning-model"), { api } = scope;
 const read = useQuery({ queryKey: scope.key, queryFn: () => api.get(LEARNING_MODEL_PATH, { parse: readLearningModel }), gcTime: 0, refetchOnWindowFocus: false });
 const [notice, setNotice] = useState<Notice>();
 const error = read.error;
 const readFailure = error instanceof ApiError && error.status === 501 ? W.notYet : error instanceof ApiError && error.status === 503 ? W.unavailable : W.failed;
 return <section id="learning-model" className="rv-ai-spend rv-learning-model" aria-label={W.title} data-testid="learning-model-card">
  <h3>{W.title}</h3><p>{W.intro}</p>
  {read.isError ? <><p role="alert" data-testid="learning-model-read-error">{readFailure}</p>{!(error instanceof ApiError && error.status === 501) && <Button onClick={() => { void read.refetch(); }}>Try again</Button>}</>
   : read.data === undefined ? <Skeleton label="Loading the lessons learning model" />
   : <Body scope={scope} view={{ ...read.data, canChange: role !== "member" && read.data.canChange }} notice={notice} setNotice={setNotice} reload={() => { void read.refetch(); }} />}
 </section>;
}

function Body({ view, notice, setNotice, reload, scope }: { view: LearningModelRead; notice: Notice; setNotice: (notice: Notice) => void; reload: () => void; scope: ReturnType<typeof useModelScope> }) {
 const { api, active } = scope;
 const [loaded, setLoaded] = useState(view);
 const [picked, setPicked] = useState(view.source === "company" ? view.model ?? DEFAULT_MODEL : DEFAULT_MODEL), [busy, setBusy] = useState(false);
 const current = view.source === "install" ? defaultModelText(view.model === null ? null : learningModelLabel(view.model)) : `Your choice: ${view.model === null ? "unavailable" : learningModelLabel(view.model)}`;
 const stale = view.model !== null && view.canChange && !view.offered.includes(view.model);
 // The default is a distinct option; an offered preselect never constitutes intent to pin.
 const unchanged = picked === (loaded.source === "company" ? loaded.model : DEFAULT_MODEL);

 async function send(model: string | null) {
  if (!active() || busy || !view.canChange) return;
  setBusy(true); setNotice(undefined);
  try {
   const saved = await api.sendAnswer("PUT", LEARNING_MODEL_PATH, { model }, { parse: readLearningModel }, { retry: "never" });
   if (!active()) return;
   setLoaded(saved); setPicked(saved.source === "company" ? saved.model ?? DEFAULT_MODEL : DEFAULT_MODEL);
   setNotice({ ok: true, text: model === null ? W.savedDefault : W.saved });
   reload();
  } catch (error) {
   if (!active()) return;
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : W.saveFailed });
   // A refusal may mean the list or the setting moved: read both again.
   reload();
  } finally { if (active()) setBusy(false); }
 }

 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "learning-model-saved" : "learning-model-error"}><VisibleText text={notice.text} /></p>}
  <p data-testid="learning-model-current"><VisibleText text={current} /></p>
  {!view.canChange ? <p data-testid="learning-model-read-only">{W.readOnly}</p>
   : view.offered.length === 0 ? <>
    <p data-testid="learning-model-none-offered">{W.noneOffered}</p>
    {/* Going back to the default needs no offered list (Code clears the setting without one), so a stale own choice can always be dropped. */}
    {view.source === "company" && <p><Button disabled={busy} onClick={() => { void send(null); }}>{W.useDefault}</Button></p>}
   </>
   : <>
    {stale && <p data-testid="learning-model-stale">{W.notOffered}</p>}
    <Select label={W.pick} value={picked} onValueChange={setPicked} options={[{ value: DEFAULT_MODEL, label: defaultModelText(view.source === "install" && view.model !== null ? learningModelLabel(view.model) : null) }, ...view.offered.map(id => ({ value: id, label: learningModelLabel(id) })), ...(view.model !== null && !view.offered.includes(view.model) ? [{ value: view.model, label: `${learningModelLabel(view.model)} (no longer offered)`, disabled: true }] : [])]} disabled={busy} />
    <p className="rv-muted">{W.pickHint}</p>
    <p>
     <Button variant="primary" busy={busy} disabled={unchanged || (picked !== DEFAULT_MODEL && !view.offered.includes(picked))} onClick={() => { void send(picked === DEFAULT_MODEL ? null : picked); }}>{W.save}</Button>{" "}
     {view.source === "company" && <Button disabled={busy} onClick={() => { void send(null); }}>{W.useDefault}</Button>}
    </p>
   </>}
 </>;
}

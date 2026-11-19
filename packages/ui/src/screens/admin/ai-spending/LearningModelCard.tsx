// DEC 254zzz63 (Code #1075): "Lessons learning model", beside the engine model in Company settings, AI. The model Rovara's lessons learn with is the company's choice; until the
// company chooses, it is this Rovara's default (Claude Haiku 5.5 unless the install says otherwise). Everyone in the company sees what it is and whose choice it is; an owner or admin
// picks from the Claude models the company's gateway offers it now, or goes back to the default. Every refusal shown is the server's own fixed sentence; a read that fails says fixed words.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LEARNING_MODEL_PATH, learningModelLabel, readLearningModel, type LearningModelRead } from "../../../api/learning-model.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";

export const LEARNING_MODEL_CARD_WORDS = Object.freeze({
 title: "Lessons learning model",
 intro: "The AI model Rovara's lessons learn with. Learning has its own model and does not follow task source order. Hosted learning currently uses Claude through the company’s Anthropic key. Rovara’s AI is a restricted fallback for an eligible exempt company; OpenAI, OpenRouter, own Bedrock and endpoint connections alone do not enable learning on this release. Current source, readiness, pause state and price could not be checked here.",
 companyChoice: "Your company's choice",
 installDefault: "This Rovara's default",
 noDefault: "No default is set on this Rovara.",
 pick: "Learning model",
 pickHint: "Claude models your company can use now.",
 readOnly: "Only a company owner or admin can change this. Ask one of them.",
 noneOffered: "No Claude model is offered to your company right now, so this can't be changed yet.",
 notOffered: "This model isn't offered to your company now. Pick one from the list.",
 save: "Save",
 useDefault: "Use the default",
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
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["ai-spend", orgId, developerId, role, "learning-model"], queryFn: () => api.get(LEARNING_MODEL_PATH, { parse: readLearningModel }), gcTime: 0, refetchOnWindowFocus: false });
 const [notice, setNotice] = useState<Notice>();
 const error = read.error;
 const readFailure = error instanceof ApiError && error.status === 501 ? W.notYet : error instanceof ApiError && error.status === 503 ? W.unavailable : W.failed;
 return <section id="learning-model" className="rv-ai-spend rv-learning-model" aria-label={W.title} data-testid="learning-model-card">
  <h3>{W.title}</h3><p>{W.intro}</p>
  {read.isError ? <><p role="alert" data-testid="learning-model-read-error">{readFailure}</p>{!(error instanceof ApiError && error.status === 501) && <Button onClick={() => { void read.refetch(); }}>Try again</Button>}</>
   : read.data === undefined ? <Skeleton label="Loading the lessons learning model" />
   : <Body key={`${read.data.source}:${read.data.model ?? ""}`} view={{ ...read.data, canChange: role !== "member" && read.data.canChange }} notice={notice} setNotice={setNotice} reload={() => { void read.refetch(); }} />}
 </section>;
}

function Body({ view, notice, setNotice, reload }: { view: LearningModelRead; notice: Notice; setNotice: (notice: Notice) => void; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [picked, setPicked] = useState(view.preselect ?? ""), [busy, setBusy] = useState(false);
 const current = view.model === null ? W.noDefault : learningModelLabel(view.model);
 const stale = view.model !== null && view.canChange && !view.offered.includes(view.model);
 // Saving the model already in force is only a change when it moves from the default to the company's own choice.
 const unchanged = picked === "" || (view.source === "company" && picked === view.model);

 async function send(model: string | null) {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer("PUT", LEARNING_MODEL_PATH, { model }, { parse: readLearningModel }, { retry: "never" });
   setNotice({ ok: true, text: model === null ? W.savedDefault : W.saved });
   reload();
  } catch (error) {
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : W.saveFailed });
   // A refusal may mean the list or the setting moved: read both again.
   reload();
  } finally { setBusy(false); }
 }

 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "learning-model-saved" : "learning-model-error"}><VisibleText text={notice.text} /></p>}
  <p data-testid="learning-model-current">{W.pick}: <b><VisibleText text={current} /></b>{view.model !== null && ` (${view.source === "company" ? W.companyChoice : W.installDefault})`}</p>
  {!view.canChange ? <p data-testid="learning-model-read-only">{W.readOnly}</p>
   : view.offered.length === 0 ? <>
    <p data-testid="learning-model-none-offered">{W.noneOffered}</p>
    {/* Going back to the default needs no offered list (Code clears the setting without one), so a stale own choice can always be dropped. */}
    {view.source === "company" && <p><Button disabled={busy} onClick={() => { void send(null); }}>{W.useDefault}</Button></p>}
   </>
   : <>
    {stale && <p data-testid="learning-model-stale">{W.notOffered}</p>}
    <Select label={W.pick} value={picked} onValueChange={setPicked} options={view.offered.map(id => ({ value: id, label: learningModelLabel(id) }))} disabled={busy} />
    <p className="rv-muted">{W.pickHint}</p>
    <p>
     <Button variant="primary" busy={busy} disabled={unchanged} onClick={() => { void send(picked); }}>{W.save}</Button>{" "}
     {view.source === "company" && <Button disabled={busy} onClick={() => { void send(null); }}>{W.useDefault}</Button>}
    </p>
   </>}
 </>;
}

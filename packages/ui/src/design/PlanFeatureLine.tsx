import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PlanFeatureChoicesResponse } from "@agentx/contracts/web";
import type { ReadDecisionCard } from "../api/decisions.js";
import { ApiError } from "../api/errors.js";
import { createPlanFeatureApi } from "../api/plan-feature.js";
import { useAppHost } from "../host.js";
import { Button } from "./Button.js";
import { Select } from "./Select.js";
import { TextField } from "./TextField.js";
import { VisibleText } from "./VisibleText.js";

const NAME_MAX = 80;

/**
 * A coding plan card's feature line (lead 4 PCF): ONE line Code words ("Feature: Checkout v2 (from the Linear parent)"), and for the person Code says may change it, "Change" (pick another open feature, or make a new
 * one when Code says they may) and "No feature". Everything drawn comes from the card's `planFeature`; Code decides who may on every read and press, and a press it refuses shows its words. The line is not part
 * of the card's digest, so a change never makes the card stale: the page reads the cards again and the new line arrives with them.
 */
export function PlanFeatureLine({ card }: { card: ReadDecisionCard }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createPlanFeatureApi(host), [host]);
 const [mode, setMode] = useState<"idle" | "pick">("idle"), [choices, setChoices] = useState<PlanFeatureChoicesResponse>(), [pick, setPick] = useState(""), [name, setName] = useState("");
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
 const feature = card.kind === "approve_plan" && card.status === "pending" ? card.planFeature : undefined, taskId = card.taskId;
 if (feature === undefined) return null;
 const controls = feature.canChange && taskId !== undefined;
 const run = async (work: () => Promise<void>) => {
  if (busy) return;
  setBusy(true);setError(undefined);setSaved(false);
  try { await work(); } catch (failure) { setError(failure instanceof ApiError && failure.message !== "" ? failure.message : "Couldn't save the feature. Try again."); }
  finally { setBusy(false); }
 };
 // After a save the cards are read again: the new line comes with them (a plan card's feature is outside its digest, so nothing goes stale).
 const done = async () => { setMode("idle");setSaved(true);setName("");await Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["work"] })]); };
 const open = () => run(async () => {
  const read = await api.choices(taskId!);
  setChoices(read);setPick(read.features.find(item => item.id === feature.feature?.id)?.id ?? read.features[0]?.id ?? "");setMode("pick");
 });
 const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
 return <div className="rv-plan-feature" data-testid="plan-feature">
  <p className="rv-plan-feature-line"><VisibleText text={feature.line} />{saved && <span role="status"> Saved.</span>}</p>
  {controls && mode === "idle" && <div className="rv-plan-feature-actions">
   <Button busy={busy} onClick={() => { void open(); }}>Change</Button>
   {feature.feature !== null && <Button busy={busy} onClick={() => { void run(async () => { await api.set(taskId, null);await done(); }); }}>No feature</Button>}
  </div>}
  {controls && mode === "pick" && choices !== undefined && <div className="rv-plan-feature-pick">
   {choices.features.length === 0 ? <p className="rv-muted">This company has no open features yet.</p>
    : <><Select label="Feature" value={pick} onValueChange={setPick} options={choices.features.map(item => ({ value: item.id, label: item.name }))} />
     <Button variant="primary" busy={busy} disabled={pick === ""} onClick={() => { void run(async () => { await api.set(taskId, pick);await done(); }); }}>Use this feature</Button></>}
   {choices.canCreate && feature.canCreate && <div className="rv-plan-feature-create">
    <TextField label="Or make a new feature" value={name} maxLength={NAME_MAX} onChange={event => setName(event.target.value)} />
    <Button busy={busy} disabled={clean === ""} onClick={() => { void run(async () => { const id = await api.create(clean);await api.set(taskId, id);await done(); }); }}>Make it and use it</Button>
   </div>}
   <Button variant="quiet" onClick={() => { setMode("idle");setError(undefined); }}>Cancel</Button>
  </div>}
  {error !== undefined && <p role="alert" data-testid="plan-feature-error"><VisibleText text={error} /></p>}
 </div>;
}

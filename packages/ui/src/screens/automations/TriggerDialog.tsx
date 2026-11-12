// exp/automations: add or change a trigger of a chain. What starts it is an event in another tool or a schedule; nothing else is offered here. The server checks everything again
// and its sentence is shown if it refuses. Turning a trigger on waits for a confirmation (the answer says so); a new trigger can be saved paused instead.
import { useId, useRef, useState } from "react";
import { newTriggerId, useAutomationsApi, type TriggerRead } from "../../api/automations.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Select } from "../../design/Select.js";
import { Switch } from "../../design/Switch.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ActionNote, noteOf, problemNote, type Note } from "./ActionNote.js";
import { EVENT_SOURCE_NAMES, EVENT_TYPES, SCHEDULE_INTERVALS, WEEKDAY_NAMES, eventTypeWords, intervalWords, specWords } from "./automation-text.js";

type Kind = "event" | "schedule";
type Frequency = "interval" | "daily" | "weekly";
type Spec = TriggerRead["spec"];
const problem = (message: string | undefined) => message === undefined ? {} : { error: message };
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

interface Initial { kind: Kind; source: string; type: string; frequency: Frequency; minutes: string; at: string; day: string; timezone: string; missed: "skip" | "run_once"; hookId: string; runs: string }
function initialOf(trigger: TriggerRead | undefined): Initial {
  const base: Initial = { kind: "event", source: "github", type: "pull_request.opened", frequency: "daily", minutes: "60", at: "09:00", day: "MON", timezone: zone(), missed: "run_once", hookId: "", runs: "" };
  if (trigger === undefined) return base;
  const spec = trigger.spec as { kind: string; source?: string; type?: string; schedule?: { kind: string; minutes?: number; at?: string; day?: string }; timezone?: string; missed?: "skip" | "run_once" };
  const out: Initial = { ...base, hookId: trigger.hookId ?? "", runs: String(trigger.maxRunsPerHour) };
  if (spec.kind === "event") return { ...out, kind: "event", source: spec.source ?? base.source, type: spec.type ?? base.type };
  if (spec.kind === "schedule" && spec.schedule !== undefined) {
    const { schedule } = spec;
    return { ...out, kind: "schedule", frequency: (schedule.kind === "interval" || schedule.kind === "weekly" ? schedule.kind : "daily"), minutes: String(schedule.minutes ?? 60), at: schedule.at ?? "09:00", day: schedule.day ?? "MON", timezone: spec.timezone ?? base.timezone, missed: spec.missed ?? "run_once" };
  }
  return out;
}

/** The spec the form describes. Parts of an existing trigger the form does not edit (an event's filter, a daily schedule's weekdays) are kept while what they belong to is unchanged. */
export function specOf(form: Initial, existing: TriggerRead | undefined): Spec {
  const old = existing?.spec as { kind: string; source?: string; type?: string; filter?: Record<string, string[]>; schedule?: { kind: string; days?: string[] } } | undefined;
  if (form.kind === "event") {
    const keep = old?.kind === "event" && old.source === form.source && old.type === form.type && old.filter !== undefined;
    return { kind: "event", source: form.source, type: form.type, ...(keep ? { filter: old.filter } : {}) };
  }
  const keepDays = old?.kind === "schedule" && old.schedule?.kind === "daily" && form.frequency === "daily" && old.schedule.days !== undefined;
  const schedule = form.frequency === "interval" ? { kind: "interval", minutes: Number(form.minutes) } : form.frequency === "weekly" ? { kind: "weekly", at: form.at, day: form.day } : { kind: "daily", at: form.at, ...(keepDays ? { days: old.schedule!.days } : {}) };
  return { kind: "schedule", schedule, timezone: form.timezone.trim(), missed: form.missed };
}

export function TriggerDialog({ chainId, project: projectProp, trigger, open, onOpenChange, onSaved }: { chainId: string; project: string | undefined; trigger?: TriggerRead | undefined; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (note: Note) => void }) {
  const api = useAutomationsApi(), [project, setProject] = useState(projectProp ?? ""), [form, setForm] = useState(() => initialOf(trigger)), [on, setOn] = useState(trigger === undefined ? true : trigger.enabled), [busy, setBusy] = useState(false), [note, setNote] = useState<Note>(), sending = useRef(false), id = useId();
  const set = <K extends keyof Initial>(key: K, value: Initial[K]) => { setForm(current => ({ ...current, [key]: value })); };
  const types = EVENT_TYPES[form.source] ?? [];
  const bad = form.kind === "schedule" && (form.frequency !== "interval" && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(form.at) || form.timezone.trim() === "");
  const badRuns = form.runs.trim() !== "" && !(Number.isInteger(Number(form.runs)) && Number(form.runs) >= 1 && Number(form.runs) <= 60);
  async function save() {
    if (sending.current || bad || badRuns || project.trim() === "") return;
    sending.current = true;setBusy(true);setNote(undefined);
    try {
      const result = await api.putTrigger(chainId, trigger?.triggerId ?? newTriggerId(), {
        project: project.trim(), spec: specOf(form, trigger), enabled: on, ...(form.runs.trim() === "" ? {} : { maxRunsPerHour: Number(form.runs) }), ...(form.hookId.trim() === "" ? {} : { hookId: form.hookId.trim() }),
      });
      onSaved(noteOf(result, trigger === undefined ? (on ? "The trigger is on." : "The trigger is saved and paused.") : "The trigger is saved."));
      onOpenChange(false);
    } catch (error) { setNote(problemNote(error)); }
    finally { sending.current = false;setBusy(false); }
  }
  return <Dialog title={trigger === undefined ? "Add a trigger" : "Change this trigger"} description="A trigger starts this chain on its own. Turning one on waits for someone who can confirm it." open={open} onOpenChange={onOpenChange}>
    <form className="rv-auto-form" onSubmit={event => { event.preventDefault();void save(); }}>
      {projectProp === undefined && <TextField label="Project" hint="The project this trigger works in." value={project} maxLength={200} onChange={event => { setProject(event.target.value); }} autoComplete="off" />}
      <Select label="What starts it" value={form.kind} onValueChange={value => { set("kind", value === "schedule" ? "schedule" : "event"); }} options={[{ value: "event", label: "Something happens in another tool" }, { value: "schedule", label: "A schedule" }]} />
      {form.kind === "event" ? <>
        <Select label="Tool" value={form.source} onValueChange={value => { setForm(current => ({ ...current, source: value, type: EVENT_TYPES[value]?.[0] ?? "" })); }} options={EVENT_SOURCE_NAMES.map(([value, label]) => ({ value, label }))} />
        <Select label="What happens" value={form.type} onValueChange={value => { set("type", value); }} options={types.map(value => ({ value, label: eventTypeWords(value) }))} />
        {form.source !== "github" && <TextField label="Webhook ID" hint="Optional. The hook this tool sends its events to." value={form.hookId} onChange={event => { set("hookId", event.target.value); }} autoComplete="off" />}
      </> : <>
        <Select label="How often" value={form.frequency} onValueChange={value => { set("frequency", value === "interval" || value === "weekly" ? value : "daily"); }} options={[{ value: "interval", label: "Every so often" }, { value: "daily", label: "Every day" }, { value: "weekly", label: "Every week" }]} />
        {form.frequency === "interval" ? <Select label="Every" value={form.minutes} onValueChange={value => { set("minutes", value); }} options={SCHEDULE_INTERVALS.map(minutes => ({ value: String(minutes), label: intervalWords(minutes).replace(/^Every /u, "") }))} /> : <>
          {form.frequency === "weekly" && <Select label="Day" value={form.day} onValueChange={value => { set("day", value); }} options={WEEKDAY_NAMES.map(([value, label]) => ({ value, label }))} />}
          <TextField label="Time" hint="24-hour, like 09:30" value={form.at} onChange={event => { set("at", event.target.value); }} {...problem(/^([01]\d|2[0-3]):[0-5]\d$/u.test(form.at) ? undefined : "Use a time like 09:30")} inputMode="numeric" autoComplete="off" />
        </>}
        <TextField label="Time zone" hint="Like Europe/Berlin or UTC" value={form.timezone} onChange={event => { set("timezone", event.target.value); }} autoComplete="off" />
        <Select label="If a run is missed" value={form.missed} onValueChange={value => { set("missed", value === "skip" ? "skip" : "run_once"); }} options={[{ value: "run_once", label: "Run once when it can" }, { value: "skip", label: "Skip it" }]} />
      </>}
      <TextField label="Most runs per hour" hint="Optional, 1 to 60." type="number" min={1} max={60} value={form.runs} onChange={event => { set("runs", event.target.value); }} {...problem(badRuns ? "Use a whole number from 1 to 60" : undefined)} />
      <Switch label={trigger === undefined ? "Turn it on now" : "On"} checked={on} onCheckedChange={setOn} />
      <p className="rv-muted" id={id}>Starts: <VisibleText text={specWords(specOf(form, trigger))} /></p>
      <ActionNote note={note} />
      <div className="rv-actions"><Button variant="primary" type="submit" busy={busy} disabled={bad || badRuns || project.trim() === ""}>{trigger === undefined ? "Add trigger" : "Save"}</Button><Button onClick={() => { onOpenChange(false); }}>Cancel</Button></div>
    </form>
  </Dialog>;
}

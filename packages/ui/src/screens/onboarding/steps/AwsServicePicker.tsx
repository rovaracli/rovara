import { useId, useMemo, useState } from "react";
import { AWS_EMULATOR_ENGINE_VERSION, AWS_EMULATOR_SERVICES, TEST_ENV_DEPENDENCY_LIMITS, awsFidelityPercent, awsSeededKinds } from "@agentx/cloud-contracts/web";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";

/** Most rows listed at once; the search narrows the rest (the table has hundreds of services). */
export const AWS_PICKER_SHOWN = 40;

/** What Rovara tells about one service of the table: its fidelity score against AWS, and whether its resources are created from the project's declarations. Fixed words and table values only. */
export function serviceNote(key: string): string {
  const percent = awsFidelityPercent(key);
  const score = percent === undefined ? "AWS fidelity score: not scored" : `AWS fidelity score ${String(percent)}%`;
  return awsSeededKinds(key).length === 0 ? `${score}. Starts empty; tests create their resources.` : `${score}. Rovara creates the resources your project declares.`;
}

/** What a save came to: done, or refused with the words to show (`stale`: the proposal moved on since the picker opened, so the picks are kept and the person chooses what to do). */
export type AwsServicesSaveResult = { ok: true } | { ok: false; stale: boolean; message: string };

/**
 * The AWS services one emulated dependency uses (decision 109: any service Rovara local AWS serves), as a searchable list over the generated table, each row with its fidelity score. The dependency's own service
 * (`required`) is always in the list, checked and locked. The caller saves the chosen keys into the environment the picker was opened on (`snapshot`: the proposal's digest and environment as they were when this instance
 * first rendered, so a save never builds on newer state it did not show); nothing here approves anything. The caller keys the picker by the dependency and its saved services, so a changed saved list starts it again.
 */
export function AwsServicePicker({ snapshot, selected, required, onSave, onDiscard }: {
  /** What the proposal was when the picker opened: given back to `onSave` unchanged. */
  snapshot: { digest: string; environment: unknown };
  selected: readonly string[];
  /** The dependency's own service key: always part of the list. */
  required: string | undefined;
  onSave: (snapshot: { digest: string; environment: unknown }, services: string[]) => Promise<AwsServicesSaveResult>;
  /** "Discard my changes and reload": the caller reads the proposal again and starts the picker afresh. */
  onDiscard: () => void;
}) {
  const [opened] = useState(snapshot);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>(() => (required === undefined || selected.includes(required) ? [...selected] : [required, ...selected]));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ message: string; stale: boolean }>();
  const hint = useId();
  const max = TEST_ENV_DEPENDENCY_LIMITS.awsServices;
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? AWS_EMULATOR_SERVICES : AWS_EMULATOR_SERVICES.filter((row) => row.key.includes(needle) || row.sdkId.toLowerCase().includes(needle));
  }, [query]);
  // The picked ones first (they stay in view while the search changes), then the other matches.
  const rows = useMemo(() => [...found.filter((row) => chosen.includes(row.key)), ...found.filter((row) => !chosen.includes(row.key))].slice(0, Math.max(AWS_PICKER_SHOWN, chosen.length)), [found, chosen]);
  const changed = [...chosen].sort().join(",") !== [...selected].sort().join(",");
  const full = chosen.length >= max;
  const toggle = (key: string) => setChosen((now) => (key === required ? now : now.includes(key) ? now.filter((entry) => entry !== key) : now.length >= max ? now : [...now, key]));
  async function save(): Promise<void> {
    setSaving(true); setProblem(undefined);
    try {
      const result = await onSave(opened, [...chosen]);
      if (!result.ok) setProblem({ message: result.message, stale: result.stale });
    } finally { setSaving(false); }
  }
  return <div className="rv-proposal-card" role="group" aria-label="AWS services for this dependency">
    <p className="rv-proposal-meta" id={hint}>Rovara local AWS ({AWS_EMULATOR_ENGINE_VERSION}) serves {AWS_EMULATOR_SERVICES.length} AWS services. Pick the ones your tests use, up to {max}.</p>
    <p role="status" aria-live="polite">{chosen.length} picked{full ? `. You can pick up to ${String(max)}, so the other boxes are off until you clear one.` : ""}</p>
    <TextField label="Search AWS services" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="for example lambda or step functions" aria-describedby={hint} />
    <ul aria-label="AWS services" style={{ listStyle: "none", paddingInlineStart: 0 }}>{rows.map((row) => {
      const on = chosen.includes(row.key);
      const locked = row.key === required;
      const id = `aws-service-${row.key}`;
      return <li key={row.key}>
        <label htmlFor={id} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", minHeight: 44, padding: "0.5rem 0", overflowWrap: "anywhere" }}>
          <input id={id} type="checkbox" checked={on} disabled={locked || (!on && full)} onChange={() => toggle(row.key)} style={{ width: 24, height: 24, flex: "none" }} />
          <span><code><VisibleText text={row.key} /></code>{locked && <strong> used by this dependency</strong>}
            <span className="rv-proposal-meta" style={{ display: "block" }}><VisibleText text={`${row.sdkId}: ${serviceNote(row.key)}`} /></span></span>
        </label>
      </li>;
    })}</ul>
    {found.length === 0 && <p role="status">No AWS service matches that search.</p>}
    {found.length > rows.length && <p className="rv-proposal-meta">Showing {rows.length} of {found.length}. Search to narrow.</p>}
    {problem !== undefined && <div role="alert"><p><VisibleText text={problem.message} /></p>{problem.stale && <Button onClick={onDiscard}>Discard my changes and reload</Button>}</div>}
    <Button variant="primary" busy={saving} disabled={!changed} onClick={() => { void save(); }}>Save the AWS services</Button>
  </div>;
}

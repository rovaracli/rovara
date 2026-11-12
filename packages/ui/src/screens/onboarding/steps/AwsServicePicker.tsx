import { useMemo, useState } from "react";
import { AWS_EMULATOR_ENGINE_VERSION, AWS_EMULATOR_SERVICES, TEST_ENV_DEPENDENCY_LIMITS, awsFidelityPercent, awsSeededKinds } from "@agentx/cloud-contracts/web";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";

/** Most rows listed at once; the search narrows the rest (the table has hundreds of services). */
const SHOWN = 40;

/** What Rovara tells about one service of the table: its fidelity score against AWS, and whether its resources are created from the project's declarations. Fixed words and table values only. */
export function serviceNote(key: string): string {
  const percent = awsFidelityPercent(key);
  const score = percent === undefined ? "AWS fidelity score: not scored" : `AWS fidelity score ${String(percent)}%`;
  return awsSeededKinds(key).length === 0 ? `${score}. Starts empty; tests create their resources.` : `${score}. Rovara creates the resources your project declares.`;
}

/**
 * The AWS services one emulated dependency uses (decision 109: any service Rovara local AWS serves), as a searchable list over the generated table, each row with its fidelity score. The family's own service stays on. The
 * caller saves the chosen keys into the environment (a maintainer's edit, checked again by the server); nothing here approves anything.
 */
export function AwsServicePicker({ selected, required, busy, onSave }: { selected: readonly string[]; /** The dependency's own service: always part of the list. */ required: string; busy: boolean; onSave: (services: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>(selected);
  const max = TEST_ENV_DEPENDENCY_LIMITS.awsServices;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = needle === "" ? AWS_EMULATOR_SERVICES : AWS_EMULATOR_SERVICES.filter((row) => row.key.includes(needle) || row.sdkId.toLowerCase().includes(needle));
    // The picked ones first (they stay in view while the search changes), then the other matches.
    return [...found.filter((row) => chosen.includes(row.key)), ...found.filter((row) => !chosen.includes(row.key))].slice(0, Math.max(SHOWN, chosen.length));
  }, [query, chosen]);
  const changed = [...chosen].sort().join(",") !== [...selected].sort().join(",");
  const toggle = (key: string) => setChosen((now) => (now.includes(key) ? now.filter((entry) => entry !== key) : now.length >= max ? now : [...now, key]));
  return <div className="rv-proposal-card" role="group" aria-label="AWS services for this dependency">
    <p className="rv-proposal-meta">Rovara local AWS ({AWS_EMULATOR_ENGINE_VERSION}) serves {AWS_EMULATOR_SERVICES.length} AWS services. Pick the ones your tests use, up to {max}. {chosen.length} picked.</p>
    <TextField label="Search AWS services" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="for example lambda or step functions" />
    <ul aria-label="AWS services">{rows.map((row) => {
      const on = chosen.includes(row.key);
      const id = `aws-service-${row.key}`;
      return <li key={row.key}>
        <input id={id} type="checkbox" checked={on} disabled={row.key === required || (!on && chosen.length >= max)} onChange={() => toggle(row.key)} />
        {" "}<label htmlFor={id}><code><VisibleText text={row.key} /></code></label>
        <span className="rv-proposal-meta"> <VisibleText text={`${row.sdkId}: ${serviceNote(row.key)}`} /></span>
      </li>;
    })}</ul>
    {rows.length === 0 && <p role="status">No AWS service matches that search.</p>}
    <Button variant="primary" busy={busy} disabled={!changed} onClick={() => onSave([...chosen])}>Save the AWS services</Button>
  </div>;
}

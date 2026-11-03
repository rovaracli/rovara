import { SETUP_LIMIT_NAMES, type SetupLimitName } from "../../api/setup-limits.js";
import { TextField } from "../../design/TextField.js";
import { LIMIT_LABELS } from "./limits-text.js";

/** The five limit boxes, shared by the project's limits and the company's. An empty box is "no setting". `hints` are fixed sentences built by the caller from numbers, never from server text. */
export function LimitFields({ fields, hints, problems, disabled, onChange }: { fields: Record<SetupLimitName, string>; hints: Record<SetupLimitName, string>; problems: Partial<Record<SetupLimitName, string>>; disabled: boolean; onChange: (name: SetupLimitName, text: string) => void }) {
 return <>{SETUP_LIMIT_NAMES.map(name => <TextField key={name} label={LIMIT_LABELS[name]} hint={hints[name]} inputMode="decimal" autoComplete="off" value={fields[name]} disabled={disabled} {...(problems[name] === undefined ? {} : { error: problems[name] })} onChange={event => { onChange(name, event.target.value); }} />)}</>;
}

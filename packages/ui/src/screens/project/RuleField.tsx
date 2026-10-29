import { TextArea } from "../../design/TextArea.js";
import { RULE_TEXT_MAX, ruleLength, ruleTooLong } from "./rule-text.js";
/** A rules text box with its limit: 4,000 characters, counted the way the server counts them (after hidden characters are removed and the ends trimmed). */
export function RuleField({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
 const count = ruleLength(value), over = ruleTooLong(value);
 return <TextArea label={label} value={value} disabled={disabled === true} rows={5} onChange={event => onChange(event.target.value)} hint={(hint === undefined ? "" : hint + " ") + count.toLocaleString("en-US") + " of " + RULE_TEXT_MAX.toLocaleString("en-US") + " characters."} {...(over ? { error: "Use at most " + RULE_TEXT_MAX.toLocaleString("en-US") + " characters. This is " + count.toLocaleString("en-US") + "." } : {})} />;
}

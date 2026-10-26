import { useId } from "react";
import { visibleText } from "./VisibleText.js";
export interface SelectOption { value: string; label: string; disabled?: boolean }
export function Select({ label, value, onValueChange, options, placeholder = "Choose", disabled = false }: { label: string; value?: string; onValueChange?: (value: string) => void; options: readonly SelectOption[]; placeholder?: string; disabled?: boolean }) {
 const id = useId();
 // RULING Q27: pinned Radix Select injects static CSS through raw HTML, rejected by Trusted Types. Native semantics need no policy or HTML sink.
 return <div className="rv-field"><label htmlFor={id}>{visibleText(label)}</label><select id={id} className="rv-input rv-select-trigger" {...(value === undefined ? { defaultValue: "" } : { value })} onChange={event => onValueChange?.(event.target.value)} disabled={disabled}><option value="" disabled>{visibleText(placeholder)}</option>{options.map(option => <option key={option.value} value={option.value} disabled={Boolean(option.disabled)}>{visibleText(option.label)}</option>)}</select></div>;
}

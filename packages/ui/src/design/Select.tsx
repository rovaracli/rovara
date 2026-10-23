import { useId } from "react";
import { Select as R } from "radix-ui";
export interface SelectOption { value: string; label: string; disabled?: boolean }
export function Select({ label, value, onValueChange, options, placeholder = "Choose", disabled = false }: { label: string; value?: string; onValueChange?: (value: string) => void; options: readonly SelectOption[]; placeholder?: string; disabled?: boolean }) {
 const id = useId();return <div className="rv-field"><label htmlFor={id}>{label}</label><R.Root {...(value !== undefined ? { value } : {})} {...(onValueChange ? { onValueChange } : {})} disabled={disabled}><R.Trigger id={id} className="rv-input rv-select-trigger"><R.Value placeholder={placeholder} /><R.Icon aria-hidden="true">⌄</R.Icon></R.Trigger><R.Portal><R.Content position="popper" className="rv-popover"><R.Viewport>{options.map(option => <R.Item key={option.value} value={option.value} disabled={Boolean(option.disabled)} className="rv-menu-item"><R.ItemText>{option.label}</R.ItemText><R.ItemIndicator aria-hidden="true">✓</R.ItemIndicator></R.Item>)}</R.Viewport></R.Content></R.Portal></R.Root></div>;
}

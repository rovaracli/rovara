import { useId } from "react";
import { Switch as R } from "radix-ui";
/** `help`: a short line under the switch that says what it does; the switch is described by it (read out with the label). */
export function Switch({ label, checked, onCheckedChange, disabled = false, help }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; help?: string }) {
 const id = useId(), helpId = id + "-help";
 const row = <div className="rv-check-row"><R.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="rv-switch" {...(help === undefined ? {} : { "aria-describedby": helpId })}><R.Thumb className="rv-switch-thumb" /></R.Root><label htmlFor={id}>{label}</label></div>;
 return help === undefined ? row : <>{row}<p id={helpId} className="rv-muted rv-switch-help">{help}</p></>;
}

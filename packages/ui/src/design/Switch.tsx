import { useId } from "react";
import { Switch as R } from "radix-ui";
export function Switch({ label, checked, onCheckedChange, disabled = false }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean }) { const id = useId();return <div className="rv-check-row"><R.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="rv-switch"><R.Thumb className="rv-switch-thumb" /></R.Root><label htmlFor={id}>{label}</label></div>; }

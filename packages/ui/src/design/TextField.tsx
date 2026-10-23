import { useId, type ComponentProps } from "react";
export interface TextFieldProps extends ComponentProps<"input"> { label: string; hint?: string; error?: string }
export function TextField({ label, hint, error, id, className = "", ...props }: TextFieldProps) {
 const generated = useId(), field = id ?? generated;
 return <div className="rv-field"><label htmlFor={field}>{label}</label>{hint && <p id={`${field}-hint`} className="rv-muted">{hint}</p>}<input {...props} id={field} className={`rv-input ${className}`} aria-invalid={Boolean(error)} aria-describedby={[hint ? `${field}-hint` : "", error ? `${field}-error` : ""].filter(Boolean).join(" ") || undefined} />{error && <p id={`${field}-error`} role="alert" className="rv-error">{error}</p>}</div>;
}

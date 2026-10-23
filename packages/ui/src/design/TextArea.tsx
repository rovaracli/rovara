import { useId, type ComponentProps } from "react";
export interface TextAreaProps extends ComponentProps<"textarea"> { label: string; hint?: string; error?: string }
export function TextArea({ label, hint, error, id, className = "", ...props }: TextAreaProps) {
 const generated = useId(), field = id ?? generated;
 return <div className="rv-field"><label htmlFor={field}>{label}</label>{hint && <p id={`${field}-hint`} className="rv-muted">{hint}</p>}<textarea {...props} id={field} className={`rv-input ${className}`} aria-invalid={Boolean(error)} aria-describedby={[hint ? `${field}-hint` : "", error ? `${field}-error` : ""].filter(Boolean).join(" ") || undefined} />{error && <p id={`${field}-error`} role="alert" className="rv-error">{error}</p>}</div>;
}

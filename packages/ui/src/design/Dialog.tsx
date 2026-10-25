import { useId, type ReactElement, type ReactNode } from "react";
import { Dialog as R } from "radix-ui";
import { VisibleText } from "./VisibleText.js";
import { IconButton } from "./IconButton.js";
export interface DialogProps { title: string; description?: string; children: ReactNode; trigger?: ReactElement; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string; onCloseAutoFocus?: ((event: Event) => void) | undefined }
export function Dialog({ title, description, children, trigger, open, onOpenChange, className = "", onCloseAutoFocus }: DialogProps) {
 const descriptionId = useId();return <R.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>{trigger && <R.Trigger asChild>{trigger}</R.Trigger>}<R.Portal><R.Overlay className="rv-overlay" /><R.Content {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})} aria-describedby={description ? descriptionId : undefined} className={`rv-dialog ${className}`}><div className="rv-dialog-heading"><R.Title><VisibleText text={title} /></R.Title><R.Close asChild><IconButton label="Close dialog" variant="quiet">×</IconButton></R.Close></div>{description && <R.Description id={descriptionId}><VisibleText text={description} /></R.Description>}{children}</R.Content></R.Portal></R.Root>;
}

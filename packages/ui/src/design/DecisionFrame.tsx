import { useId, type HTMLAttributes, type ReactNode } from "react";
import { StatusChip, type StatusChipProps } from "./StatusChip.js";
import { VisibleText } from "./VisibleText.js";
import "./parts/decision-timeline.css";

export interface DecisionFrameProps extends Omit<HTMLAttributes<HTMLElement>, "title" | "children"> {
 title: string;
 status?: StatusChipProps;
 meta?: string;
 children: ReactNode;
 actions: ReactNode;
 footer?: ReactNode;
 /** Preserve the existing Home article and task-pane section landmarks. */
 as?: "article" | "section";
 headingLevel?: 2 | 3;
 /** Preserve the owning screen’s existing headline selector. */
 titleClassName?: string;
}

/** Visual hierarchy only: the caller owns authority, evidence locks and every action. */
export function DecisionFrame({ title, status, meta, children, actions, footer, as: Root = "article", headingLevel = 2, titleClassName = "", className = "", ...attributes }: DecisionFrameProps) {
 const titleId = useId(), Heading = headingLevel === 3 ? "h3" : "h2";
 return <Root aria-labelledby={titleId} {...attributes} className={`rv-decision-frame ${className}`}>
  <header className="rv-decision-frame-header">{status !== undefined && <StatusChip {...status} />}<Heading id={titleId} className={`rv-decision-frame-title ${titleClassName}`}><VisibleText text={title} /></Heading>{meta !== undefined && <p className="rv-decision-frame-meta"><VisibleText text={meta} /></p>}</header>
  <div className="rv-decision-frame-body">{children}</div>
  {actions != null && <div className="rv-decision-frame-actions">{actions}</div>}
  {footer != null && <footer className="rv-decision-frame-footer">{footer}</footer>}
 </Root>;
}

import { Button, type ButtonProps } from "./Button.js";
export interface IconButtonProps extends ButtonProps { label: string }
export function IconButton({ label, className = "", ...props }: IconButtonProps) { return <Button {...props} aria-label={label} title={label} className={`rv-icon-button ${className}`} />; }

import type { ReactElement } from "react";
import { DropdownMenu as R } from "radix-ui";
export interface MenuItem { label: string; onSelect: () => void; disabled?: boolean }
export function Menu({ trigger, items, onCloseAutoFocus }: { trigger: ReactElement; items: readonly MenuItem[]; onCloseAutoFocus?: (event: Event) => void }) { return <R.Root><R.Trigger asChild>{trigger}</R.Trigger><R.Portal><R.Content onCloseAutoFocus={onCloseAutoFocus} className="rv-popover" sideOffset={4}>{items.map(item => <R.Item key={item.label} onSelect={item.onSelect} disabled={Boolean(item.disabled)} className="rv-menu-item">{item.label}</R.Item>)}</R.Content></R.Portal></R.Root>; }

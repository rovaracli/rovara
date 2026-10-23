import type { ReactElement } from "react";
import { DropdownMenu as R } from "radix-ui";
export interface MenuItem { label: string; onSelect: () => void; disabled?: boolean }
export function Menu({ trigger, items }: { trigger: ReactElement; items: readonly MenuItem[] }) { return <R.Root><R.Trigger asChild>{trigger}</R.Trigger><R.Portal><R.Content className="rv-popover" sideOffset={4}>{items.map(item => <R.Item key={item.label} onSelect={item.onSelect} disabled={Boolean(item.disabled)} className="rv-menu-item">{item.label}</R.Item>)}</R.Content></R.Portal></R.Root>; }

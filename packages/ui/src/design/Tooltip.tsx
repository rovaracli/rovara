import type { ReactElement } from "react";
import { Tooltip as R } from "radix-ui";
export function Tooltip({ text, children }: { text: string; children: ReactElement }) { return <R.Provider delayDuration={500}><R.Root><R.Trigger asChild>{children}</R.Trigger><R.Portal><R.Content className="rv-tooltip" sideOffset={6}>{text}</R.Content></R.Portal></R.Root></R.Provider>; }

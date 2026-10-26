import { VisuallyHidden as R } from "radix-ui";
import type { ComponentProps } from "react";
export function VisuallyHidden(props: ComponentProps<typeof R.Root>) { return <R.Root {...props} />; }

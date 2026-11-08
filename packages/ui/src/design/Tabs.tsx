import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Tabs as R } from "radix-ui";
export interface TabItem { value: string; label: string; content: ReactNode; disabled?: boolean }
/** Width of the fade at a strip edge that still has tabs past it; `--rv-tab-fade` on `.rv-tabs` in design.css is the same number. */
export const TAB_FADE_PX = 28;
/** Which edges of a scrolling strip have tabs hidden past them (1px of slack for fractional scroll positions). */
export function hiddenEdges(strip: { scrollLeft: number; clientWidth: number; scrollWidth: number }): { start: boolean; end: boolean } {
 return { start: strip.scrollLeft > 1, end: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 };
}
/** The scrollLeft that brings a tab fully into the strip and clear of the fades, or the current one when it is already there. Both boxes are viewport rectangles. */
export function scrollToTab(strip: { left: number; right: number; scrollLeft: number; scrollWidth: number; clientWidth: number }, tab: { left: number; right: number }): number {
 const target = tab.left < strip.left + TAB_FADE_PX ? strip.scrollLeft + tab.left - strip.left - TAB_FADE_PX : tab.right > strip.right - TAB_FADE_PX ? strip.scrollLeft + tab.right - strip.right + TAB_FADE_PX : strip.scrollLeft;
 return Math.max(0, Math.min(target, strip.scrollWidth - strip.clientWidth));
}
/** Keeps `data-more-start` / `data-more-end` true while tabs are hidden past that edge (the stylesheet fades them), and scrolls the selected tab into view on mount and whenever the selection changes. Arrow keys, focus and roles are Radix's, untouched. */
function useTabStripCue() {
 const ref = useRef<HTMLDivElement>(null);
 // Before paint, so the first frame already has the selected tab in view and the fade on.
 useLayoutEffect(() => {
  const strip = ref.current;
  if (strip === null) return;
  const mark = () => { const edges = hiddenEdges(strip);strip.toggleAttribute("data-more-start", edges.start);strip.toggleAttribute("data-more-end", edges.end); };
  const reveal = () => {
   const tab = strip.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
   if (tab === null) return;
   const box = strip.getBoundingClientRect(), left = scrollToTab({ left: box.left, right: box.right, scrollLeft: strip.scrollLeft, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth }, tab.getBoundingClientRect());
   if (Math.abs(left - strip.scrollLeft) > 1) strip.scrollLeft = left;
  };
  reveal();mark();
  strip.addEventListener("scroll", mark, { passive: true });
  // Web fonts change how wide the tabs are, so look again once they are in.
  let gone = false;
  void document.fonts?.ready.then(() => { if (!gone) { reveal();mark(); } });
  // A narrower window, a tab added or removed, or a font that finishes loading changes how many tabs fit.
  // A change in the strip's own width (rotating the phone, a closed panel opening) looks for the selected tab again; a tab changing width only redraws the fades, so a strip the person scrolled by hand stays put.
  let width = strip.clientWidth;
  const sizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (strip.clientWidth !== width) { width = strip.clientWidth;reveal(); } mark(); });
  const watch = () => { sizes?.observe(strip);for (const child of strip.children) sizes?.observe(child); };
  const changes = new MutationObserver(() => { watch();reveal();mark(); });
  changes.observe(strip, { attributes: true, attributeFilter: ["data-state"], childList: true, subtree: true });
  watch();
  return () => { gone = true;strip.removeEventListener("scroll", mark);changes.disconnect();sizes?.disconnect(); };
 }, []);
 return ref;
}
export function Tabs({ label, value, defaultValue, onValueChange, items }: { label: string; value?: string; defaultValue?: string; onValueChange?: (value: string) => void; items: readonly TabItem[] }) { const strip = useTabStripCue();return <R.Root {...(value !== undefined ? { value } : {})} {...(defaultValue !== undefined ? { defaultValue } : {})} {...(onValueChange ? { onValueChange } : {})}><R.List ref={strip} aria-label={label} className="rv-tabs">{items.map(item => <R.Trigger key={item.value} value={item.value} disabled={Boolean(item.disabled)} className="rv-tab">{item.label}</R.Trigger>)}</R.List>{items.map(item => <R.Content key={item.value} value={item.value} className="rv-tab-panel">{item.content}</R.Content>)}</R.Root>; }

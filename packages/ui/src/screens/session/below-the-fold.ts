import { useEffect, useState } from "react";

/**
 * True while `node` is not fully on screen AND lies below the visible part of the page (it has not been scrolled past), on a screen wide enough for a desktop layout.
 * The task page uses it to show a pinned Approve bar only when the Approve row itself is out of view, so the two never show side by side.
 * Where the browser cannot observe (no IntersectionObserver) it stays false and nothing extra is drawn.
 */
export function useBelowTheFold(node: HTMLElement | null): boolean {
 const [below, setBelow] = useState(false);
 useEffect(() => {
  if (node === null || typeof IntersectionObserver === "undefined") return;
  const wide = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 640px)") : undefined;
  let ratio = 1, top = 0;
  const decide = () => setBelow(ratio < 0.99 && top > 0 && (wide === undefined || wide.matches));
  const observer = new IntersectionObserver(entries => {
   const entry = entries[entries.length - 1];
   if (entry === undefined) return;
   ratio = entry.intersectionRatio;top = entry.boundingClientRect.top;decide();
  }, { threshold: [0, 0.5, 0.99, 1] });
  observer.observe(node);
  wide?.addEventListener?.("change", decide);
  return () => { observer.disconnect();wide?.removeEventListener?.("change", decide);setBelow(false); };
 }, [node]);
 return below;
}

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A piece of the task page that keeps its React state (open disclosures, typed text, an open dialog) when the page changes layout (the phone order at 480px and narrower, the wide order above it).
 * The two layouts put the same pieces in different places of the tree, and React remounts a piece whose place moved. A slot fixes the piece's place in the React tree (`SlotContent`, always drawn
 * at the same spot) and moves only its DOM node to where the current layout wants it (`SlotPlace`). Nothing is drawn again: the node, with its open `details` and its inputs, moves with it.
 */
export interface Slot { readonly host: HTMLElement }
/** The wrapper draws no box of its own, so the layout around it is the layout it would have without it. */
const NO_BOX = { display: "contents" } as const;

export function useSlot(): Slot {
 return useState<Slot>(() => { const host = document.createElement("div");host.className = "rv-slot";host.style.display = "contents";return { host }; })[0];
}
/** Moves the slot's node into `anchor`. Focus inside it survives the move (the browser drops it when a focused node leaves the page for an instant). */
function moveInto(anchor: HTMLElement, host: HTMLElement) {
 if (host.parentNode === anchor) return;
 const active = document.activeElement, focused = active instanceof HTMLElement && host.contains(active) ? active : undefined;
 anchor.appendChild(host);
 if (focused !== undefined && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
/** Where the slot's piece shows in this layout. Only one place per slot is drawn at a time. */
export function SlotPlace({ slot }: { slot: Slot }) {
 return <div className="rv-slot" style={NO_BOX} ref={anchor => { if (anchor !== null) moveInto(anchor, slot.host); }} />;
}
/** The piece itself. Draw it at the same place in the tree in every layout, after the layouts (so a place exists when its first effects run). */
export function SlotContent({ slot, children }: { slot: Slot; children: ReactNode }) {
 return createPortal(children, slot.host);
}

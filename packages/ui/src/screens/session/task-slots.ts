import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// Where the task page's own composition wants the Stop control: inside the current-step card (1a). The control itself stays
// owned by SessionControls (its request, lock and dialog); this only says where its trigger is drawn. Without a provider
// (the unchanged live page) there is no slot and Stop stays among the page's controls.
type TaskChip = "ready_to_merge" | "checking" | undefined;
/** "Continue in my tool" is a task-level action drawn inside "Task actions" (mock 4d). TaskActions owns its guarded handler; this only carries the menu entry to the menu. */
export type TaskContinueEntry = { disabled: boolean; onSelect: () => void; /** A short visible reason the entry is blocked (DEC 254zzz374: a plan waiting at plan review says "approve the plan first"). */ reason?: string };
type Slots = { continueEntry: TaskContinueEntry | undefined; setContinueEntry: (entry: TaskContinueEntry | undefined) => void; planNote: HTMLElement | null; setPlanNote: (element: HTMLElement | null) => void; stop: HTMLElement | null; setStop: (element: HTMLElement | null) => void; chip: TaskChip; setChip: (chip: TaskChip) => void };
const TaskSlots = createContext<Slots | undefined>(undefined);
export function TaskSlotsProvider({ children }: { children: ReactNode }) {
 const [continueEntry, setContinueEntry] = useState<TaskContinueEntry>(), [planNote, setPlanNote] = useState<HTMLElement | null>(null), [stop, setStop] = useState<HTMLElement | null>(null), [chip, setChip] = useState<TaskChip>(undefined);
 return createElement(TaskSlots.Provider, { value: { continueEntry, setContinueEntry, planNote, setPlanNote, stop, setStop, chip, setChip } }, children);
}
export const useTaskStopSlot = (): HTMLElement | null => useContext(TaskSlots)?.stop ?? null;
export const useRegisterTaskStopSlot = (): ((element: HTMLElement | null) => void) | undefined => useContext(TaskSlots)?.setStop;

/** The status chip the merge section says the page should show (Ready to merge), when its own read is the source of that state. */
export const useTaskChip = (): TaskChip => useContext(TaskSlots)?.chip;
export const useRegisterTaskChip = (): ((chip: TaskChip) => void) | undefined => useContext(TaskSlots)?.setChip;

/** Where the plan decision card draws the one line that says how it was reached (the handoff note), so it sits inside the card under its title (mocks 1c, 1j). */
export const useTaskPlanNoteSlot = (): HTMLElement | null => useContext(TaskSlots)?.planNote ?? null;
export const useRegisterTaskPlanNoteSlot = (): ((element: HTMLElement | null) => void) | undefined => useContext(TaskSlots)?.setPlanNote;

/** The Task actions entry for "Continue in my tool", when the page offers it. */
export const useTaskContinueEntry = (): TaskContinueEntry | undefined => useContext(TaskSlots)?.continueEntry;
/** TaskActions registers its own guarded handler as the menu entry; the entry always calls the latest handler and is withdrawn when the action is not offered. */
export function useRegisterTaskContinue(entry: { disabled: boolean; onSelect: () => void; reason?: string } | undefined): void {
 const register = useContext(TaskSlots)?.setContinueEntry, latest = useRef(entry?.onSelect), offered = entry !== undefined, disabled = entry?.disabled === true, onSelect = entry?.onSelect, reason = entry?.reason;
 useEffect(() => { latest.current = onSelect; });
 useEffect(() => {
  if (register === undefined || !offered) return;
  register({ disabled, ...(reason === undefined ? {} : { reason }), onSelect: () => { latest.current?.(); } });
  return () => { register(undefined); };
 }, [register, offered, disabled, reason]);
}

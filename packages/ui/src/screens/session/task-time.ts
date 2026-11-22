/** Viewer-local clock time (HH:MM, 24 hour) for a recorded instant; never a fixed zone and never a relative age. */
export function clockTime(at: string | undefined): string | undefined {
 if (at === undefined) return undefined;
 const time = Date.parse(at);
 if (!Number.isFinite(time)) return undefined;
 return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

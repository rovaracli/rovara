/** Format a recorded instant in the viewer's locale and time zone. Never cache a fixed-zone formatter. */
export function viewerTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}): string {
 return new Date(value).toLocaleString(undefined, options);
}

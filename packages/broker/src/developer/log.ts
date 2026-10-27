/** One structured log line. Only event names, reasons and error names: never payloads or secrets. */
export function logDeveloperEvent(entry: Record<string, string>): void {
  console.log(JSON.stringify({ component: "broker", ...entry }));
}

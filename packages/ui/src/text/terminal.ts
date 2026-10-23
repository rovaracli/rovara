export function stripTerminalEscapes(text: string): string {
 // eslint-disable-next-line no-control-regex -- remove OSC terminal control sequences, including their ESC/BEL terminators.
 const withoutOsc = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
 // eslint-disable-next-line no-control-regex -- remove ANSI CSI terminal controls before displaying a session peek.
 return withoutOsc.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

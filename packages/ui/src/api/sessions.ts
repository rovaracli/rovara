export function acceptSessionRead(previous: unknown, _next: unknown) { return previous; }
export function mergeSessionMessages(_pages: unknown) { return [] as Array<{ text: string }>; }
export function createSessionApi(_host: unknown) { return { async read(_id: string) { return { title: "" }; }, async sendMessage(_id: string, _input: unknown) { return { kind: "unimplemented" }; } }; }

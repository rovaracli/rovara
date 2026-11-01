/** A route's answer with a status other than 200; the broker's handler writes the status and the body. */
export class StatusReply {
  constructor(readonly statusCode: number, readonly body: object) {}
}

/** A route's answer that is already a finished HTTP reply (bytes, a redirect): the broker's handler writes it as it is, with no JSON wrapper. Used by the evidence download. */
export class RawReply {
  constructor(readonly response: { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded?: boolean }) {}
}

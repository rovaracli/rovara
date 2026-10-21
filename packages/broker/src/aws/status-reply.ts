/** A route's answer with a status other than 200; the broker's handler writes the status and the body. */
export class StatusReply {
  constructor(readonly statusCode: number, readonly body: object) {}
}

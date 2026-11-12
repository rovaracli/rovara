// Convergence lane A8: an SES double for the email adapter's tests. It takes the SDK's `SendEmailCommand` the way the service does (it reads the command's input, never a field the adapter did not set), keeps what it took, and
// can fail the way the service fails: by error name, with a message that names the address (as the service's own messages do), by hanging until the call's abort signal fires, or by being down.
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailMessage } from "../../../packages/broker/src/cloud-adapters/k1-ports/index.js";
import type { SesSender } from "../../../packages/broker/src/cloud-adapters/email-realtime.js";

type Input = SendEmailCommand["input"];

export class FakeSes implements SesSender {
  readonly inputs: Input[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  /** The next calls fail with these, oldest first (each is used once). */
  readonly failures: Error[] = [];
  down = false;
  hang = false;
  destroyed = false;

  async send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const input = command.input;
    this.signals.push(options?.abortSignal);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    if (this.down) throw serviceError("ServiceUnavailable", `connect ECONNREFUSED while sending to ${input.Destination?.ToAddresses?.[0] ?? "?"}`);
    if (this.hang) {
      await new Promise<void>((_resolve, reject) => {
        const signal = options?.abortSignal;
        const fail = (): void => reject(serviceError("TimeoutError", "The operation was aborted due to timeout"));
        if (signal?.aborted === true) fail(); else signal?.addEventListener("abort", fail, { once: true });
      });
    }
    this.inputs.push(input);
    return { MessageId: "0000000000000000-fake" };
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** What the service took, as the port's message shape (the company and purpose are not on the wire, so they read "unknown"). */
  taken(): EmailMessage[] {
    return this.inputs.map((input) => {
      const simple = input.Content?.Simple;
      const unsubscribe = simple?.Headers?.find((header) => header.Name === "List-Unsubscribe")?.Value;
      return {
        companyId: "unknown", purpose: "unknown", to: input.Destination?.ToAddresses?.[0] ?? "", subject: simple?.Subject?.Data ?? "", text: simple?.Body?.Text?.Data ?? "",
        ...(simple?.Body?.Html?.Data === undefined ? {} : { html: simple.Body.Html.Data }),
        ...(unsubscribe === undefined ? {} : { unsubscribeUrl: unsubscribe.replace(/^<|>$/gu, "") }),
      };
    });
  }
}

/** An error as the SDK throws one: its `name` is the service's error name, its message may name the address. */
export function serviceError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

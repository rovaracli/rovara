// Plan 4 Task 26: stand-ins for EventBridge Scheduler and for the dead-letter queue, speaking the SDK's commands (`CreateScheduleCommand` and the rest), so the code under test sends
// what it would send to AWS. The scheduler enforces what the real one refuses and the code could get wrong: a name that exists is a ConflictException, one that doesn't is a
// ResourceNotFoundException, `Update` replaces the whole schedule (so a field it leaves out is gone), names, descriptions and inputs keep to the service's limits.

type Input = Record<string, unknown>;
interface Command { constructor: { name: string }; input: Input }

export interface FakeSchedule {
  name: string;
  group: string;
  input: Input;
  state: "ENABLED" | "DISABLED";
}

function failure(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const NAME = /^[0-9a-zA-Z-_.]{1,64}$/;
const text = (value: unknown, otherwise: string): string => (typeof value === "string" ? value : otherwise);

export class FakeSchedulerClient {
  /** The schedules, by `<group>/<name>`. */
  readonly schedules = new Map<string, FakeSchedule>();
  /** Every call, in order, by the command's name. */
  readonly calls: Array<{ command: string; input: Input }> = [];
  /** The next call fails with this. */
  failNext: Error | undefined;
  /** Calls that fail with this error while it is set, whatever the command (an outage). */
  down: Error | undefined;

  private key = (group: unknown, name: unknown): string => `${text(group, "default")}/${text(name, "")}`;

  /** The schedule of the trigger in the group, as the scheduler holds it. */
  get(group: string, name: string): FakeSchedule | undefined {
    return this.schedules.get(this.key(group, name));
  }

  commands(name: string): Input[] {
    return this.calls.filter((call) => call.command === name).map((call) => call.input);
  }

  private check(input: Input): void {
    const name = input["Name"];
    if (typeof name !== "string" || !NAME.test(name)) throw failure("ValidationException", "the name is not valid");
    const description = input["Description"];
    if (description !== undefined && (typeof description !== "string" || description.length > 512)) throw failure("ValidationException", "the description is not valid");
    const expression = input["ScheduleExpression"];
    if (typeof expression !== "string" || !/^(rate\(\d+ (minute|minutes|hour|hours|day|days)\)|cron\([^)]+\))$/.test(expression)) throw failure("ValidationException", "the schedule expression is not valid");
    const target = input["Target"] as { Arn?: unknown; RoleArn?: unknown; Input?: unknown } | undefined;
    if (target === undefined || typeof target.Arn !== "string" || typeof target.RoleArn !== "string") throw failure("ValidationException", "the target needs an ARN and a role");
    if (typeof target.Input === "string" && target.Input.length > 8192) throw failure("ValidationException", "the input is too long");
    if ((input["FlexibleTimeWindow"] as { Mode?: unknown } | undefined)?.Mode === undefined) throw failure("ValidationException", "a flexible time window is required");
    if (input["State"] !== undefined && input["State"] !== "ENABLED" && input["State"] !== "DISABLED") throw failure("ValidationException", "the state is not valid");
  }

  send = async (command: Command): Promise<unknown> => {
    const name = command.constructor.name;
    this.calls.push({ command: name, input: structuredClone(command.input) });
    if (this.down !== undefined) throw this.down;
    const failing = this.failNext;
    this.failNext = undefined;
    if (failing !== undefined) throw failing;
    const input = command.input;
    const key = this.key(input["GroupName"], input["Name"]);
    switch (name) {
      case "CreateScheduleCommand": {
        this.check(input);
        if (this.schedules.has(key)) throw failure("ConflictException", "the schedule exists");
        this.schedules.set(key, { name: text(input["Name"], ""), group: text(input["GroupName"], "default"), input: structuredClone(input), state: (input["State"] as "ENABLED" | "DISABLED" | undefined) ?? "ENABLED" });
        return { ScheduleArn: `arn:aws:scheduler:us-east-1:123456789012:schedule/${key}` };
      }
      case "UpdateScheduleCommand": {
        this.check(input);
        if (!this.schedules.has(key)) throw failure("ResourceNotFoundException", "no such schedule");
        this.schedules.set(key, { name: text(input["Name"], ""), group: text(input["GroupName"], "default"), input: structuredClone(input), state: (input["State"] as "ENABLED" | "DISABLED" | undefined) ?? "ENABLED" });
        return { ScheduleArn: `arn:aws:scheduler:us-east-1:123456789012:schedule/${key}` };
      }
      case "GetScheduleCommand": {
        const found = this.schedules.get(key);
        if (found === undefined) throw failure("ResourceNotFoundException", "no such schedule");
        return { ...structuredClone(found.input), Name: found.name, GroupName: found.group, State: found.state, Arn: `arn:aws:scheduler:us-east-1:123456789012:schedule/${key}` };
      }
      case "DeleteScheduleCommand": {
        if (!this.schedules.delete(key)) throw failure("ResourceNotFoundException", "no such schedule");
        return {};
      }
      default: throw failure("ValidationException", `${name} is not a command of this fake`);
    }
  };
}

/** What the scheduler leaves in the dead-letter queue: the target's input as the message body. */
export class FakeDeadLetterQueue {
  readonly messages: Array<{ handle: string; body: string }> = [];
  readonly deleted: string[] = [];
  readonly received: number[] = [];
  failReceive: Error | undefined;
  private counter = 0;

  add(body: unknown): string {
    this.counter += 1;
    const handle = `h${String(this.counter)}`;
    this.messages.push({ handle, body: typeof body === "string" ? body : JSON.stringify(body) });
    return handle;
  }

  send = async (command: Command): Promise<unknown> => {
    const name = command.constructor.name;
    if (name === "ReceiveMessageCommand") {
      if (this.failReceive !== undefined) throw this.failReceive;
      const max = Number(command.input["MaxNumberOfMessages"] ?? 1);
      this.received.push(max);
      return { Messages: this.messages.slice(0, Math.min(max, 10)).map((message) => ({ MessageId: message.handle, ReceiptHandle: message.handle, Body: message.body })) };
    }
    if (name === "DeleteMessageCommand") {
      const handle = String(command.input["ReceiptHandle"]);
      this.deleted.push(handle);
      const index = this.messages.findIndex((message) => message.handle === handle);
      if (index >= 0) this.messages.splice(index, 1);
      return {};
    }
    throw failure("ValidationException", `${name} is not a command of this fake`);
  };
}

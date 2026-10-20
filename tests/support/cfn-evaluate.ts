/**
 * A small evaluator for the CloudFormation intrinsics a synthesised template uses, so a test can say what a policy
 * grants for a given parameter value instead of only matching the template's shape: Ref, Fn::Join, Fn::Split,
 * Fn::Select, Fn::If, Fn::Equals, Fn::Not, Fn::And, Fn::Or and Condition references.
 */
export interface CfnContext {
  parameters: Record<string, string>;
  /** The template's `Conditions`, unevaluated. */
  conditions: Record<string, unknown>;
  pseudo?: Record<string, string>;
}

const PSEUDO: Record<string, string> = { "AWS::Partition": "aws", "AWS::Region": "us-east-1", "AWS::AccountId": "123456789012", "AWS::URLSuffix": "amazonaws.com" };

export function evaluate(value: unknown, context: CfnContext): unknown {
  if (Array.isArray(value)) return value.map((entry) => evaluate(entry, context));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [name, argument] = entries[0]!;
    switch (name) {
      case "Ref": {
        const key = String(argument);
        const found = context.parameters[key] ?? context.pseudo?.[key] ?? PSEUDO[key];
        if (found === undefined) throw new Error(`no value for Ref ${key}`);
        return found;
      }
      case "Condition": return evaluateCondition(String(argument), context);
      case "Fn::Join": {
        const [delimiter, list] = argument as [string, unknown[]];
        return (evaluate(list, context) as unknown[]).join(delimiter);
      }
      case "Fn::Split": {
        const [delimiter, text] = argument as [string, unknown];
        return String(evaluate(text, context)).split(delimiter);
      }
      case "Fn::Select": {
        const [index, list] = argument as [unknown, unknown];
        const items = evaluate(list, context) as unknown[];
        const at = Number(evaluate(index, context));
        if (items[at] === undefined) throw new Error(`Fn::Select ${at} is out of range`);
        return items[at];
      }
      case "Fn::Equals": {
        const [left, right] = (argument as unknown[]).map((entry) => evaluate(entry, context));
        return left === right;
      }
      case "Fn::Not": return !(evaluate((argument as unknown[])[0], context) as boolean);
      case "Fn::And": return (argument as unknown[]).every((entry) => evaluate(entry, context) === true);
      case "Fn::Or": return (argument as unknown[]).some((entry) => evaluate(entry, context) === true);
      case "Fn::If": {
        const [condition, yes, no] = argument as [string, unknown, unknown];
        return evaluate(evaluateCondition(condition, context) ? yes : no, context);
      }
      default: break;
    }
  }
  return Object.fromEntries(entries.map(([key, entry]) => [key, evaluate(entry, context)]));
}

export function evaluateCondition(name: string, context: CfnContext): boolean {
  const expression = context.conditions[name];
  if (expression === undefined) throw new Error(`no condition ${name}`);
  return evaluate(expression, context) as boolean;
}

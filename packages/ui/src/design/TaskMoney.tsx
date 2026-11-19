import { taskMoneyWords, type TaskMoneyV1 } from "@agentx/contracts/web";
/** All task surfaces use the same uncertainty and sub-cent formatting. */
export function TaskMoney({ money }: { money: TaskMoneyV1 | undefined }) {
 return <span className="rv-num">{taskMoneyWords(money)}</span>;
}

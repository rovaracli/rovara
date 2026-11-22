import { Button } from "../../design/Button.js";

type Props = { state: "unavailable" | "load-failed"; onRetry?: () => void };

export function TaskDiffReadRecoveryView(props: Props) {
 if (props.state === "unavailable") {
  return <p role="status">This diff is unavailable to this account. No code was changed by this read. Ask your project admin to check access.</p>;
 }
 return <p role="status">The diff could not be loaded. This does not change the branch. <Button variant="quiet" onClick={() => { props.onRetry?.(); }}>Load diff again</Button></p>;
}

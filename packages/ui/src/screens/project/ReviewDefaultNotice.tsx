import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ApiError } from "../../api/errors.js";
import { reviewDefaultNoticeKey, useReviewDefaultNotice, useReviewDefaultNoticeApi } from "../../api/review-default-notice.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { stageResult, type StageModelsStage } from "../../api/stage-models.js";
import { COMPANY_PAGE, REVIEW_DEFAULT_NOTICE as T } from "./stage-model-text.js";
import { isCheckingStage } from "./stage-model-text.js";

/**
 * The one-time notice that reviews now use a model from a different company (owner decision 2026-11-02). Shown only while a review step is on that default (its reason says so), to every member;
 * an owner or admin can dismiss it, and the dismissal is the company's. Whether it is dismissed and who may dismiss are the server's to say. Nothing is shown while that cannot be read.
 */
export function ReviewDefaultNotice({ stages, labelOf }: { stages: readonly StageModelsStage[]; labelOf: (model: string) => string }) {
 const read = useReviewDefaultNotice(), api = useReviewDefaultNoticeApi(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState(false), [failed, setFailed] = useState<string>();
 const models = [...new Set(stages.filter(stage => isCheckingStage(stage.stage)).flatMap(stage => { const result = stageResult(stage);return result.kind === "effective" && result.reason === "DEFAULT_DIFFERENT_COMPANY" ? [labelOf(result.model.provider + "/" + result.model.modelId)] : []; }))];
 if (read.data === undefined || read.data.dismissed || models.length === 0) return null;
 const { canDismiss } = read.data;
 async function dismiss() {
  if (sending.current) return;
  sending.current = true;setBusy(true);setFailed(undefined);
  try { query.setQueryData(reviewDefaultNoticeKey, await api.dismiss()); }
  catch (error) { setFailed(error instanceof ApiError && error.status === 403 ? T.NOT_ALLOWED : T.FAILED); }
  finally { sending.current = false;setBusy(false); }
 }
 return <section aria-label={T.LABEL} className="rv-project-section rv-hww-review-default" aria-busy={busy}>
  <p role="status"><VisibleText text={T.PREFIX + models.join(", ") + ". "} />{canDismiss ? <Link to={COMPANY_PAGE}><VisibleText text={T.CHANGE} /></Link> : <VisibleText text={T.CHANGE} />}</p>
  {canDismiss && <Button busy={busy} onClick={() => { void dismiss(); }}><VisibleText text={T.DISMISS} /></Button>}
  {failed !== undefined && <p role="alert"><VisibleText text={failed} /></p>}
 </section>;
}

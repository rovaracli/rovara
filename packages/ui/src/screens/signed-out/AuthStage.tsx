import type { ReactNode } from "react";
import "./signed-out.css";

const WORKFLOW_STEPS = [
  { number: "01", title: "Agree on the plan", detail: "Approach and required checks approved in Slack", state: "done" as const },
  { number: "02", title: "Build and verify", detail: "Isolated cloud workspace runs tests and reviews", state: "done" as const },
  { number: "03", title: "Review the draft PR", detail: "Checked diff and results ready for your team", state: "ready" as const },
] as const;

export interface AuthStageProps {
  testId?: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthStage({ testId, eyebrow = "Rovara Cloud", children, footer }: AuthStageProps) {
  return (
    <main className="rv-auth-stage" data-testid={testId}>
      <section className="rv-auth-brand" aria-label="About Rovara">
        <div className="rv-auth-brand-top">
          <span className="rv-auth-wordmark">
            <span className="rv-auth-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" focusable="false">
                <path d="M6 19V5h6.5a4 4 0 0 1 1.7 7.62L18 19h-4.4l-3.4-5.4V19H6Zm3.4-9.5v2.4h2.9a1.2 1.2 0 0 0 0-2.4H9.4Z" fill="currentColor" />
              </svg>
            </span>
            Rovara
          </span>
          <span className="rv-auth-env-pill">
            <span className="rv-auth-env-dot" aria-hidden="true" />
            Cloud workspace
          </span>
        </div>

        <div className="rv-auth-brand-body">
          <p className="rv-auth-brand-eyebrow">Cloud coding agents · Your AWS account</p>
          <p className="rv-auth-brand-headline">
            Give your agents a task. <span>Work with them in Slack.</span>
          </p>
          <p className="rv-auth-brand-copy">
            Agree on the plan, follow the cloud build, inspect the checks, and review the draft PR from one connected workspace.
          </p>

          <div className="rv-auth-preview" aria-hidden="true">
            <div className="rv-auth-preview-head">
              <div className="rv-auth-preview-task">
                <strong>Export orders to CSV</strong>
                <span># engineering · app-api</span>
              </div>
              <span className="rv-auth-preview-badge">Draft PR ready</span>
            </div>
            <ol className="rv-auth-steps">
              {WORKFLOW_STEPS.map((step) => (
                <li className="rv-auth-step" key={step.number}>
                  <span className="rv-auth-step-num">{step.number}</span>
                  <div className="rv-auth-step-text">
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </div>
                  <span className="rv-auth-step-state" data-state={step.state}>
                    {step.state === "done"
                      ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 5" /></svg>
                      : <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3.5" /></svg>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <p className="rv-auth-brand-foot">Persistent workspaces, verifiable checks, and team-controlled merges.</p>
      </section>

      <div className="rv-auth-panel">
        <div className="rv-auth-card">
          <p className="rv-auth-card-eyebrow">{eyebrow}</p>
          {children}
          {footer !== undefined && <div className="rv-auth-meta">{footer}</div>}
        </div>
      </div>
    </main>
  );
}

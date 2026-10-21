# Plan 2 staging checks

## Task 12 Step 6: GitHub App install callback probe (2026-10-21)

The owner applied the five-line checklist to the staging App `agentx-preplabsai-staging` (public; Callback URL
`https://sv3dwut47b.execute-api.us-west-2.amazonaws.com/v1/github/install/callback`; "Request user authorization (OAuth)
during installation"; "Redirect on update"; Members read-only) and opened
`https://github.com/apps/agentx-preplabsai-staging/installations/new?state=probe123`.

| Case | Result |
|---|---|
| Install on a personal account (`setup_action=install`) | Completed; the callback address was not captured. |
| Reconfigure that install (`setup_action=update`) | `.../v1/github/install/callback?code=<code>&installation_id=173860001&setup_action=update&state=probe123`: **state, code, installation_id and setup_action all present.** |
| Request by a non-owner (`setup_action=request`) | Not run (no non-owner account to hand). |

Conclusions:
- `state` survives GitHub's redirect with user authorization on, at least for updates; GitHub documents the same pass-through
  for installs, so Task 13 keeps its state-bound design. The install case is re-checked in the Task 23 staging round.
- The `request` case is unverified. Task 14 is built as planned; if its callback lacks `code`, the request is not attributed and
  nothing is bound (the plan's fail-closed fallback), and the Task 23 staging round checks it with a non-owner account.
- The probe's personal-account install was uninstalled afterwards; the PrepLabsAI install was left as it was.

# v0.7.6 Event-driven GitHub Actions dispatch

## What changed

Primary trigger is now Cloudflare Worker -> GitHub workflow_dispatch when GitHub-heavy work is queued.
The Worker 1-minute Cron also dispatches if an older heavy backlog already exists.
GitHub's 5-minute schedule remains only as fallback.

D1 `external_runner_leases` is reused for:
- `research`: active GitHub runner lease
- `github-dispatch`: 180-second dispatch cooldown

This prevents repeated workflow dispatches while a runner is active or a dispatch is already in flight.

## One required Cloudflare secret

Create a GitHub token that can run Actions in `kcbcdc/dcv-research-platform`, then set it only as a Cloudflare Worker secret:

```bash
npx wrangler secret put GITHUB_ACTIONS_TOKEN
```

Do not put the token in `wrangler.jsonc` or GitHub source.

The non-secret routing values are already configured in `wrangler.jsonc`:
- GITHUB_OWNER=kcbcdc
- GITHUB_REPO=dcv-research-platform
- GITHUB_WORKFLOW=dcv-research.yml
- GITHUB_REF=main

## Browser diagnostics

```js
fetch('/api/runner/status',{cache:'no-store'})
  .then(r=>r.json())
  .then(console.log)
```

Expected after deployment and secret configuration:
- `configured: true`
- `heavy_due > 0` when compute jobs are waiting
- shortly after enqueue/cron: `dispatch_cooldown_active: true`
- while Actions is working: `runner_active: true`
- after completion: newer `last_completed_at` and higher `jobs_completed`

Manual server-side wake (still respects queue/cooldown):

```js
fetch('/api/runner/dispatch',{method:'POST'})
  .then(r=>r.json())
  .then(console.log)
```

Possible statuses: `dispatched`, `dispatch_cooldown`, `runner_active`, `no_heavy_work`, `not_configured`, `dispatch_failed`.

## Validation

- npm test: 159/159 PASS
- JavaScript syntax check: PASS
- npm run predeploy: PASS

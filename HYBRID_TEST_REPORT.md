# DCV Research Platform v0.7.3 — Hybrid executor verification

- Full Node test suite: **150 / 150 passed**
- JavaScript syntax check (`node --check`): **passed** for `src/`, `public/`, `scripts/`, `tests/`
- New regression coverage:
  - Worker-light vs GitHub-heavy lane classification
  - Disjoint D1 job claiming between Worker and Actions
  - Worker rejection of heavy Monte Carlo/LAB execution in hybrid mode
  - Heavy queued work remains untouched by Worker
  - External Validation Matrix falls back to last valid snapshot during a new Evidence Revision
- `npm run predeploy`: **passed**, 58 scientific source/schema files bundled.
- Wrangler dry-run: **not executed in this sandbox** because a local Wrangler binary is not installed; `npx` attempted remote resolution and timed out. This is an environment limitation, not a test failure.

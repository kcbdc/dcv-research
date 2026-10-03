# DCV Research Platform v0.7.9 — Human participant carry-forward fix

## Fixed bug
Human-study evidence was incorrectly scoped to `research_cycle` even when the human-study protocol had not changed. Advancing the AI research cycle therefore made the dashboard and 10-agent AI lab report `0 / 30` eligible participants while cumulative participants remained non-zero.

## New rule
- AI `research_cycle` changes do **not** reset human participants.
- Human observations remain eligible while `human_protocol` is unchanged.
- A genuinely different `human_protocol` is still analyzed separately.
- Browser participant identity is now keyed by `project + human_protocol`, not `project + research_cycle`.

## Modified areas
- Project detail/live-report participant counters
- Reviewer-model fitting sample gate
- Thesis/report human evidence aggregation
- 10-agent AI lab evidence snapshot
- Dashboard labels/session persistence
- Regression tests for cycle rollover

## Validation
Targeted regression suite: 40/40 PASS, including dashboard D1-read guards, human report scope, live participants, and 10-agent lab tests.

The reconstructed upstream snapshot also contains two unrelated pre-existing full-suite failures (compute recovery batch 100 vs 208 and official-source backlog progression). This patch does not modify those areas.

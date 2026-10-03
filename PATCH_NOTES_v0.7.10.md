# DCV Research Platform v0.7.10 — Human evidence / reviewer model / funnel / regret fixes

## Fixed
1. **80명 vs 78명 participant mismatch**
   - Explicitly different human-study protocol records are still excluded.
   - Legacy records created before `context_json.protocol` tagging are carried forward into the current protocol instead of silently dropping participants.
   - Dashboard/live report, thesis/report aggregation, reviewer fitting, and 10-agent lab snapshot use the same rule.

2. **Reviewer model version displayed as '-'**
   - Reports now show the latest reviewer-model version even while the current Evidence Revision is waiting for refit.
   - Freshness is labeled as current vs `현재 Evidence 재적합 대기`.
   - Newly fitted models store the human protocol, legacy-untagged count, and observation watermark.

3. **Figure 7 progresses too slowly**
   - Robust Historical + Stress jobs are queued for up to 500 confirmed candidates in one wave instead of only 60.
   - Robust-done detection is scoped to the active research cycle via candidate lineage.
   - Current-cycle simulation reads no longer depend on a nonexistent `simulation_runs.research_cycle` column.

4. **Figure 3 Minimax Regret appears blank / axis labels all 0**
   - Tiny regret values now use adaptive precision/scientific notation.
   - If regret is not yet computable, Figure 3 explicitly shows `Minimax Regret 계산 대기` instead of rendering null as zero.
   - Regret is not promoted from a single comparable candidate; at least 2 comparable candidates are required.

5. **Reviewer counter regression**
   - Manual reviewer observations once again increment `projects.reviewer_obs_count` atomically.

## Version
- package: 0.7.10
- report APP_VERSION: 0.7.10

## Validation
- Targeted participant/report/figure/validation tests: PASS.
- D1 read/counter regression tests: PASS.
- Full suite: 169/170 PASS; the remaining failure is the pre-existing unrelated `official-only jobs advance through all enabled sources despite unrelated backlog and missing keys` test and is outside this patch scope.

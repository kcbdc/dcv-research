-- Repair legacy simulation cycle attribution and rebuild derived caches exactly once.
-- Safe for databases where simulation_runs.research_cycle was added manually before 0023.

-- 1) The candidate row is the source of truth for a run's research cycle.
UPDATE simulation_runs
SET research_cycle = COALESCE(
  (SELECT c.research_cycle FROM design_candidates c WHERE c.id=simulation_runs.candidate_id),
  research_cycle,
  1
)
WHERE research_cycle IS NULL
   OR research_cycle != COALESCE(
        (SELECT c.research_cycle FROM design_candidates c WHERE c.id=simulation_runs.candidate_id),
        research_cycle,
        1
      );

-- 2) project_cycle_stats is only a materialized summary. Rebuild it from source tables so
-- manual migration/trigger ordering cannot leave stale pending/simulation counts.
DELETE FROM project_cycle_stats;

INSERT INTO project_cycle_stats(
  project_id,research_cycle,candidate_total,candidate_pending,candidate_feasible,candidate_infeasible,
  candidate_unresolved,boundary_sum,boundary_count,regret_updated_at
)
SELECT project_id,research_cycle,COUNT(*),
  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status='confirmed_feasible' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
  SUM(CASE WHEN evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
  COALESCE(SUM(COALESCE(boundary_score,0)),0),
  SUM(CASE WHEN boundary_score IS NOT NULL THEN 1 ELSE 0 END),
  MAX(CASE WHEN max_regret IS NOT NULL THEN updated_at END)
FROM design_candidates
GROUP BY project_id,research_cycle;

INSERT INTO project_cycle_stats(
  project_id,research_cycle,simulation_total,simulation_exploration,simulation_refinement,
  simulation_confirmation,simulation_robust,latest_simulation_at
)
SELECT project_id,COALESCE(research_cycle,1),COUNT(*),
  SUM(CASE WHEN phase='exploration' THEN 1 ELSE 0 END),
  SUM(CASE WHEN phase='refinement' THEN 1 ELSE 0 END),
  SUM(CASE WHEN phase='confirmation' THEN 1 ELSE 0 END),
  SUM(CASE WHEN phase IN ('historical','stress') THEN 1 ELSE 0 END),
  MAX(created_at)
FROM simulation_runs
GROUP BY project_id,COALESCE(research_cycle,1)
ON CONFLICT(project_id,research_cycle) DO UPDATE SET
  simulation_total=excluded.simulation_total,
  simulation_exploration=excluded.simulation_exploration,
  simulation_refinement=excluded.simulation_refinement,
  simulation_confirmation=excluded.simulation_confirmation,
  simulation_robust=excluded.simulation_robust,
  latest_simulation_at=excluded.latest_simulation_at;

-- 3) Matrix rows are derived from runs + validations. Drop the stale cache so the application
-- rebuilds it against the repaired cycle attribution on the next matrix GET.
DELETE FROM candidate_validation_matrix;

CREATE INDEX IF NOT EXISTS idx_runs_project_cycle_created
ON simulation_runs(project_id,research_cycle,created_at,candidate_id,phase);

-- Direct simulation-cycle accounting.
-- The production database already has simulation_runs.research_cycle; new databases get it from 0001_init.sql.
-- This migration removes per-row design_candidates lookups from simulation summary triggers.

DROP TRIGGER IF EXISTS trg_sim_stats_insert;
CREATE TRIGGER trg_sim_stats_insert
AFTER INSERT ON simulation_runs
BEGIN
  INSERT OR IGNORE INTO project_cycle_stats(project_id,research_cycle)
  VALUES(NEW.project_id,COALESCE(NEW.research_cycle,1));

  UPDATE project_cycle_stats SET
    simulation_total=simulation_total+1,
    simulation_exploration=simulation_exploration+(CASE WHEN NEW.phase='exploration' THEN 1 ELSE 0 END),
    simulation_refinement=simulation_refinement+(CASE WHEN NEW.phase='refinement' THEN 1 ELSE 0 END),
    simulation_confirmation=simulation_confirmation+(CASE WHEN NEW.phase='confirmation' THEN 1 ELSE 0 END),
    simulation_robust=simulation_robust+(CASE WHEN NEW.phase IN ('historical','stress') THEN 1 ELSE 0 END),
    latest_simulation_at=CASE
      WHEN latest_simulation_at IS NULL OR NEW.created_at>latest_simulation_at THEN NEW.created_at
      ELSE latest_simulation_at END
  WHERE project_id=NEW.project_id AND research_cycle=COALESCE(NEW.research_cycle,1);
END;

DROP TRIGGER IF EXISTS trg_sim_stats_delete;
CREATE TRIGGER trg_sim_stats_delete
AFTER DELETE ON simulation_runs
BEGIN
  UPDATE project_cycle_stats SET
    simulation_total=MAX(0,simulation_total-1),
    simulation_exploration=MAX(0,simulation_exploration-(CASE WHEN OLD.phase='exploration' THEN 1 ELSE 0 END)),
    simulation_refinement=MAX(0,simulation_refinement-(CASE WHEN OLD.phase='refinement' THEN 1 ELSE 0 END)),
    simulation_confirmation=MAX(0,simulation_confirmation-(CASE WHEN OLD.phase='confirmation' THEN 1 ELSE 0 END)),
    simulation_robust=MAX(0,simulation_robust-(CASE WHEN OLD.phase IN ('historical','stress') THEN 1 ELSE 0 END))
  WHERE project_id=OLD.project_id AND research_cycle=COALESCE(OLD.research_cycle,1);
END;

CREATE INDEX IF NOT EXISTS idx_runs_project_cycle_phase_cand
ON simulation_runs(project_id,research_cycle,phase,candidate_id,created_at);

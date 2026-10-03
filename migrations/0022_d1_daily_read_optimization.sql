-- v0.7.9: D1 Free tier row-read optimization.
-- Keep exact per-cycle counters on writes so dashboards/schedulers do not repeatedly scan
-- design_candidates/simulation_runs/reviewer_observations as those tables grow.
CREATE TABLE IF NOT EXISTS project_cycle_stats (
  project_id TEXT NOT NULL,
  research_cycle INTEGER NOT NULL,
  candidate_total INTEGER NOT NULL DEFAULT 0,
  candidate_pending INTEGER NOT NULL DEFAULT 0,
  candidate_feasible INTEGER NOT NULL DEFAULT 0,
  candidate_infeasible INTEGER NOT NULL DEFAULT 0,
  candidate_unresolved INTEGER NOT NULL DEFAULT 0,
  boundary_sum REAL NOT NULL DEFAULT 0,
  boundary_count INTEGER NOT NULL DEFAULT 0,
  simulation_total INTEGER NOT NULL DEFAULT 0,
  simulation_exploration INTEGER NOT NULL DEFAULT 0,
  simulation_refinement INTEGER NOT NULL DEFAULT 0,
  simulation_confirmation INTEGER NOT NULL DEFAULT 0,
  simulation_robust INTEGER NOT NULL DEFAULT 0,
  latest_simulation_at TEXT,
  regret_updated_at TEXT,
  PRIMARY KEY(project_id,research_cycle)
);

-- One-time exact backfill. Future reads are O(1) per project/cycle.
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
FROM design_candidates GROUP BY project_id,research_cycle
ON CONFLICT(project_id,research_cycle) DO UPDATE SET
  candidate_total=excluded.candidate_total,candidate_pending=excluded.candidate_pending,
  candidate_feasible=excluded.candidate_feasible,candidate_infeasible=excluded.candidate_infeasible,
  candidate_unresolved=excluded.candidate_unresolved,boundary_sum=excluded.boundary_sum,
  boundary_count=excluded.boundary_count,regret_updated_at=excluded.regret_updated_at;

INSERT INTO project_cycle_stats(project_id,research_cycle,simulation_total,simulation_exploration,simulation_refinement,simulation_confirmation,simulation_robust,latest_simulation_at)
SELECT r.project_id,c.research_cycle,COUNT(*),
  SUM(CASE WHEN r.phase='exploration' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.phase='refinement' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.phase='confirmation' THEN 1 ELSE 0 END),
  SUM(CASE WHEN r.phase IN ('historical','stress') THEN 1 ELSE 0 END),
  MAX(r.created_at)
FROM simulation_runs r JOIN design_candidates c ON c.id=r.candidate_id
GROUP BY r.project_id,c.research_cycle
ON CONFLICT(project_id,research_cycle) DO UPDATE SET
  simulation_total=excluded.simulation_total,simulation_exploration=excluded.simulation_exploration,
  simulation_refinement=excluded.simulation_refinement,simulation_confirmation=excluded.simulation_confirmation,
  simulation_robust=excluded.simulation_robust,latest_simulation_at=excluded.latest_simulation_at;

CREATE INDEX IF NOT EXISTS idx_cycle_stats_pending ON project_cycle_stats(candidate_pending,project_id,research_cycle);
CREATE INDEX IF NOT EXISTS idx_candidates_min_regret ON design_candidates(project_id,research_cycle,max_regret,id) WHERE max_regret IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_active_project ON jobs(project_id,status,type,created_at);

CREATE TRIGGER IF NOT EXISTS trg_candidate_stats_insert AFTER INSERT ON design_candidates BEGIN
  INSERT INTO project_cycle_stats(project_id,research_cycle,candidate_total,candidate_pending,candidate_feasible,candidate_infeasible,candidate_unresolved,boundary_sum,boundary_count,regret_updated_at)
  VALUES(NEW.project_id,NEW.research_cycle,1,
    CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status='confirmed_feasible' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END,
    CASE WHEN NEW.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END,
    COALESCE(NEW.boundary_score,0),CASE WHEN NEW.boundary_score IS NOT NULL THEN 1 ELSE 0 END,
    CASE WHEN NEW.max_regret IS NOT NULL THEN NEW.updated_at ELSE NULL END)
  ON CONFLICT(project_id,research_cycle) DO UPDATE SET
    candidate_total=candidate_total+1,
    candidate_pending=candidate_pending+excluded.candidate_pending,
    candidate_feasible=candidate_feasible+excluded.candidate_feasible,
    candidate_infeasible=candidate_infeasible+excluded.candidate_infeasible,
    candidate_unresolved=candidate_unresolved+excluded.candidate_unresolved,
    boundary_sum=boundary_sum+excluded.boundary_sum,boundary_count=boundary_count+excluded.boundary_count,
    regret_updated_at=COALESCE(excluded.regret_updated_at,regret_updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_candidate_stats_update AFTER UPDATE OF status,evidence_status,boundary_score,max_regret,updated_at ON design_candidates
WHEN OLD.research_cycle=NEW.research_cycle BEGIN
  UPDATE project_cycle_stats SET
    candidate_pending=candidate_pending+(CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END),
    candidate_feasible=candidate_feasible+(CASE WHEN NEW.status='confirmed_feasible' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='confirmed_feasible' THEN 1 ELSE 0 END),
    candidate_infeasible=candidate_infeasible+(CASE WHEN NEW.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END)-(CASE WHEN OLD.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END),
    candidate_unresolved=candidate_unresolved+(CASE WHEN NEW.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END)-(CASE WHEN OLD.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END),
    boundary_sum=boundary_sum+COALESCE(NEW.boundary_score,0)-COALESCE(OLD.boundary_score,0),
    boundary_count=boundary_count+(CASE WHEN NEW.boundary_score IS NOT NULL THEN 1 ELSE 0 END)-(CASE WHEN OLD.boundary_score IS NOT NULL THEN 1 ELSE 0 END),
    regret_updated_at=CASE WHEN NEW.max_regret IS NOT NULL AND (OLD.max_regret IS NULL OR NEW.max_regret!=OLD.max_regret) THEN COALESCE(NEW.updated_at,regret_updated_at) ELSE regret_updated_at END
  WHERE project_id=NEW.project_id AND research_cycle=NEW.research_cycle;
END;

CREATE TRIGGER IF NOT EXISTS trg_candidate_stats_delete AFTER DELETE ON design_candidates BEGIN
  UPDATE project_cycle_stats SET
    candidate_total=MAX(0,candidate_total-1),
    candidate_pending=MAX(0,candidate_pending-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)),
    candidate_feasible=MAX(0,candidate_feasible-(CASE WHEN OLD.status='confirmed_feasible' THEN 1 ELSE 0 END)),
    candidate_infeasible=MAX(0,candidate_infeasible-(CASE WHEN OLD.status IN ('infeasible','confirmation_failed') THEN 1 ELSE 0 END)),
    candidate_unresolved=MAX(0,candidate_unresolved-(CASE WHEN OLD.evidence_status='UNRESOLVED' THEN 1 ELSE 0 END)),
    boundary_sum=boundary_sum-COALESCE(OLD.boundary_score,0),
    boundary_count=MAX(0,boundary_count-(CASE WHEN OLD.boundary_score IS NOT NULL THEN 1 ELSE 0 END))
  WHERE project_id=OLD.project_id AND research_cycle=OLD.research_cycle;
END;

CREATE TRIGGER IF NOT EXISTS trg_sim_stats_insert AFTER INSERT ON simulation_runs BEGIN
  INSERT INTO project_cycle_stats(project_id,research_cycle,simulation_total,simulation_exploration,simulation_refinement,simulation_confirmation,simulation_robust,latest_simulation_at)
  VALUES(NEW.project_id,COALESCE((SELECT research_cycle FROM design_candidates WHERE id=NEW.candidate_id),1),1,
    CASE WHEN NEW.phase='exploration' THEN 1 ELSE 0 END,
    CASE WHEN NEW.phase='refinement' THEN 1 ELSE 0 END,
    CASE WHEN NEW.phase='confirmation' THEN 1 ELSE 0 END,
    CASE WHEN NEW.phase IN ('historical','stress') THEN 1 ELSE 0 END,NEW.created_at)
  ON CONFLICT(project_id,research_cycle) DO UPDATE SET
    simulation_total=simulation_total+1,
    simulation_exploration=simulation_exploration+excluded.simulation_exploration,
    simulation_refinement=simulation_refinement+excluded.simulation_refinement,
    simulation_confirmation=simulation_confirmation+excluded.simulation_confirmation,
    simulation_robust=simulation_robust+excluded.simulation_robust,
    latest_simulation_at=CASE WHEN latest_simulation_at IS NULL OR excluded.latest_simulation_at>latest_simulation_at THEN excluded.latest_simulation_at ELSE latest_simulation_at END;
END;

CREATE TRIGGER IF NOT EXISTS trg_sim_stats_delete AFTER DELETE ON simulation_runs BEGIN
  UPDATE project_cycle_stats SET
    simulation_total=MAX(0,simulation_total-1),
    simulation_exploration=MAX(0,simulation_exploration-(CASE WHEN OLD.phase='exploration' THEN 1 ELSE 0 END)),
    simulation_refinement=MAX(0,simulation_refinement-(CASE WHEN OLD.phase='refinement' THEN 1 ELSE 0 END)),
    simulation_confirmation=MAX(0,simulation_confirmation-(CASE WHEN OLD.phase='confirmation' THEN 1 ELSE 0 END)),
    simulation_robust=MAX(0,simulation_robust-(CASE WHEN OLD.phase IN ('historical','stress') THEN 1 ELSE 0 END))
  WHERE project_id=OLD.project_id AND research_cycle=COALESCE((SELECT research_cycle FROM design_candidates WHERE id=OLD.candidate_id),1);
END;

-- Distinct human participant registries: dashboard counts become a few index rows instead of
-- a full reviewer_observations scan with JSON extraction.
CREATE TABLE IF NOT EXISTS reviewer_participants_total (
  project_id TEXT NOT NULL, participant_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,participant_hash)
);
CREATE TABLE IF NOT EXISTS reviewer_participants_cycle (
  project_id TEXT NOT NULL,research_cycle INTEGER NOT NULL,protocol TEXT NOT NULL,participant_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,research_cycle,protocol,participant_hash)
);
INSERT OR IGNORE INTO reviewer_participants_total(project_id,participant_hash)
SELECT project_id,participant_hash FROM reviewer_observations WHERE participant_hash!='anonymous' GROUP BY project_id,participant_hash;
INSERT OR IGNORE INTO reviewer_participants_cycle(project_id,research_cycle,protocol,participant_hash)
SELECT project_id,CAST(json_extract(context_json,'$.cycle') AS INTEGER),COALESCE(json_extract(context_json,'$.protocol'),''),participant_hash
FROM reviewer_observations
WHERE participant_hash!='anonymous' AND json_extract(context_json,'$.cycle') IS NOT NULL
GROUP BY project_id,CAST(json_extract(context_json,'$.cycle') AS INTEGER),COALESCE(json_extract(context_json,'$.protocol'),''),participant_hash;

CREATE TRIGGER IF NOT EXISTS trg_reviewer_participants_insert AFTER INSERT ON reviewer_observations
WHEN NEW.participant_hash!='anonymous' BEGIN
  INSERT OR IGNORE INTO reviewer_participants_total(project_id,participant_hash) VALUES(NEW.project_id,NEW.participant_hash);
  INSERT OR IGNORE INTO reviewer_participants_cycle(project_id,research_cycle,protocol,participant_hash)
  VALUES(NEW.project_id,COALESCE(CAST(json_extract(NEW.context_json,'$.cycle') AS INTEGER),1),COALESCE(json_extract(NEW.context_json,'$.protocol'),''),NEW.participant_hash);
END;

-- Make reviewer_obs_count self-maintaining for every insert path (API, tests, imports).
-- Existing values were backfilled by migration 0008; from this migration onward callers must not increment manually.
CREATE TRIGGER IF NOT EXISTS trg_reviewer_obs_project_count_insert AFTER INSERT ON reviewer_observations BEGIN
  UPDATE projects SET reviewer_obs_count=reviewer_obs_count+1 WHERE id=NEW.project_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_reviewer_obs_project_count_delete AFTER DELETE ON reviewer_observations BEGIN
  UPDATE projects SET reviewer_obs_count=MAX(0,reviewer_obs_count-1) WHERE id=OLD.project_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_reviewer_participants_update AFTER UPDATE OF participant_hash,context_json ON reviewer_observations BEGIN
  DELETE FROM reviewer_participants_total
   WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash
     AND NOT EXISTS(SELECT 1 FROM reviewer_observations WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash AND id<>OLD.id);
  DELETE FROM reviewer_participants_cycle
   WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash
     AND NOT EXISTS(SELECT 1 FROM reviewer_observations WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash AND id<>OLD.id
       AND COALESCE(CAST(json_extract(context_json,'$.cycle') AS INTEGER),1)=reviewer_participants_cycle.research_cycle
       AND COALESCE(json_extract(context_json,'$.protocol'),'')=reviewer_participants_cycle.protocol);
  INSERT OR IGNORE INTO reviewer_participants_total(project_id,participant_hash)
    SELECT NEW.project_id,NEW.participant_hash WHERE NEW.participant_hash!='anonymous';
  INSERT OR IGNORE INTO reviewer_participants_cycle(project_id,research_cycle,protocol,participant_hash)
    SELECT NEW.project_id,COALESCE(CAST(json_extract(NEW.context_json,'$.cycle') AS INTEGER),1),COALESCE(json_extract(NEW.context_json,'$.protocol'),''),NEW.participant_hash
    WHERE NEW.participant_hash!='anonymous';
END;
CREATE TRIGGER IF NOT EXISTS trg_reviewer_participants_delete AFTER DELETE ON reviewer_observations BEGIN
  DELETE FROM reviewer_participants_total
   WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash
     AND NOT EXISTS(SELECT 1 FROM reviewer_observations WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash);
  DELETE FROM reviewer_participants_cycle
   WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash
     AND research_cycle=COALESCE(CAST(json_extract(OLD.context_json,'$.cycle') AS INTEGER),1)
     AND protocol=COALESCE(json_extract(OLD.context_json,'$.protocol'),'')
     AND NOT EXISTS(SELECT 1 FROM reviewer_observations WHERE project_id=OLD.project_id AND participant_hash=OLD.participant_hash
       AND COALESCE(CAST(json_extract(context_json,'$.cycle') AS INTEGER),1)=reviewer_participants_cycle.research_cycle
       AND COALESCE(json_extract(context_json,'$.protocol'),'')=reviewer_participants_cycle.protocol);
END;

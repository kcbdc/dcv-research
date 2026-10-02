## 0.7.8
- 인간실험 참가자 세션을 프로젝트·연구주기별로 분리해 동일 브라우저의 참가자 식별자 고정 버그 수정
- 실제 다른 참가자가 시작할 때 사용할 `새 참가자 시작` UI와 현재 세션/현재 분석 참가자/누적 참가자 표시 추가
- 보고서 표본 경고를 현재 규약·연구주기 참가자 기준으로 명확화하고 누적 참가자 수를 병기
- 서로 다른 14명 calibrated-task-v2 관측이 현재 주기 참가자 수 14명으로 집계되는 회귀 테스트 추가

# v0.7.6 — Event-driven GitHub heavy runner

## v0.7.7 — Event-dispatch CI reliability fix

- Heavy-job enqueue now passes an authoritative `heavyHint` to the GitHub dispatcher instead of immediately re-querying D1 after the durable INSERT.
- Runner-active and dispatch-cooldown leases are still enforced, so burst coalescing and duplicate-run protection are unchanged.
- Cron/manual dispatch paths still query D1 for due heavy work.
- Delayed heavy jobs do not dispatch early; the Worker cron wakes them when due.
- Fixes the Node 24 CI failure where `hybrid heavy enqueue event-dispatches GitHub once...` could observe zero mock dispatch calls.


- Cloudflare Worker now dispatches `dcv-research.yml` immediately when a GitHub-heavy job is enqueued.
- Worker 1-minute Cron also checks existing heavy D1 backlog and dispatches Actions, so stranded pre-deployment jobs recover automatically.
- D1 `external_runner_leases` provides a 180-second dispatch cooldown and active-runner detection to avoid dispatch storms.
- Added `/api/runner/status` and `/api/runner/dispatch` diagnostics. Secrets are never returned.
- GitHub 5-minute schedule remains as a fallback; event-driven Worker dispatch is now the primary trigger.
- Preserves v0.7.5 starvation repair: GitHub prioritizes `compute_candidate` over shared transition jobs and demotes stale queued `advance_project`.

## v0.7.5 — GitHub Compute Starvation Fix

- GitHub hybrid claim order now prioritizes `compute_candidate`, then validation/reviewer jobs, then other heavy jobs, and only then shared transition jobs.
- Pending compute no longer promotes `advance_project` to priority 5; queued stale advance jobs are automatically demoted to priority 90.
- Fixes the observed state where `compute_candidate` stayed queued with attempts=0 while `advance_project` completed every five minutes.
- Added regression tests for starvation reproduction and automatic priority repair.

## v0.7.4 — Aggressive Hybrid Fast Path

- Expanded Cloudflare Worker fast-path to `measure_project` and `seed_candidates`.
- Added shared-fast transitions (`advance_project`, `recompute_project`, `finalize_recompute`, `approve_project`) claimable by either Worker or GitHub, with D1 atomic claim preventing duplicate execution.
- Worker scheduled orchestration now runs up to three fast-path rounds per event so newly queued transition work can progress without waiting for another long interval.
- Worker Cron increased from every 5 minutes to every minute; GitHub heavy compute schedule increased from 12-minute cadence to 5-minute cadence.
- GitHub Actions can consume shared transition jobs immediately after heavy compute, avoiding an extra Worker-Cron wait.
- Dashboard now labels recent jobs as WORKER FAST / SHARED FAST / GITHUB HEAVY and displays HYBRID FAST in the research briefing.
- Heavy simulation, validation, reviewer fitting, empirical refit, external collection and report generation remain on GitHub Actions.

## v0.7.3 — Hybrid Worker/Actions executor + persistent validation snapshots

- Added a hybrid executor: Cloudflare Worker handles only lightweight orchestration (`advance_project`, `approve_project`); GitHub Actions handles simulation, validation, collection, reviewer fitting, recompute finalization, reporting and other heavy work.
- Partitioned the durable D1 jobs queue by runtime lane so Worker and Actions cannot claim each other's jobs.
- Added defense-in-depth guards preventing Monte Carlo and Research LAB work from running on the public Worker in hybrid mode.
- Worker cron reduced from 15 minutes to 5 minutes so stage transitions resume without waiting for the next Actions run.
- Manual project Run advances lightweight orchestration immediately in hybrid mode; report generation remains queued for Actions.
- External Validation Matrix now falls back to the most recent valid snapshot when a new Evidence Revision is still revalidating, with explicit STALE/current revision metadata instead of showing NO DATA.
- Dashboard shows `STALE rN → rM` and preserves the corresponding Funnel until the current revision replaces it.
- Added regression tests for disjoint execution lanes, Worker heavy-compute blocking, and stale Matrix preservation.

## v0.5.21 — Live-load recovery + toolkit click fix + right-reference height sync + report figure restore

- Fixed thesis-toolkit/module timing race by resolving `window.DCV` dynamically at click time; Word, MD+그림, 더보기 and 논문 도구 controls no longer retain an undefined core reference.
- Initial browser load now retries project loading up to three times for transient cold-start/network failures instead of requiring the in-app refresh button.
- API responses and browser fetches remain no-store; static asset URLs bumped to v0.5.21 to avoid stale bundles.
- Desktop analytical cards now use the rendered right-most card as the height reference; left and middle cards are set to the same measured height. Projects card is similarly matched to Approval.
- Added ResizeObserver re-sync after dynamic content changes.
- Report figures now hydrate independently, match tolerant path/query/extension forms, invalidate on cycle/revision change, and use per-figure SVG fallback so one rendering exception cannot blank every image.
- Auxiliary snapshot cache is only committed after all auxiliary loads succeed; transient failures auto-retry.

## v0.5.20 — F5 Recovery + Exact Height Sync + Report Figure Recovery

- Added `Cache-Control: no-store` to API JSON responses and browser API/thesis fetches so a browser reload cannot reuse stale project snapshots.
- Versioned `style.css`, `app.js`, and `thesis.js` asset URLs to avoid stale static bundles after deployment.
- Auxiliary FDIC / Official / Validation Matrix snapshots are cached only after all three loads succeed; failed F5-time loads are retried automatically.
- Added ResizeObserver-based desktop height synchronization: the right analytical card is measured after render and the left/middle cards are matched; Projects/Approval are also synchronized.
- Report preview now renders figure placeholders immediately and hydrates figures individually from the current thesis snapshot.
- Figure matching is path/query/extension tolerant; one figure renderer failure no longer removes all report figures.
- Thesis cache invalidates when project cycle/evidence revision changes.

## v0.5.19 — Refresh Recovery + Three-column Analysis + Report Visual Restore

- Fixed browser F5/reload initialization order: project wrappers and auxiliary loaders are now registered before the first project load.
- Stabilized feasible-region canvas with a post-layout redraw on initial load.
- Replaced the stretched 2-column analysis row with three independent columns: Feasible Region / CDRS Evidence / Robust Regret + Human Recompute.
- Removed forced equal-height stretching that created large blank areas under the left chart.
- Restored rendered report preview: headings/tables render immediately as HTML and SVG figures hydrate asynchronously from the current thesis snapshot.
- Report open explicitly triggers the renderer, avoiding a raw-Markdown preview regression.
- Replaced enqueueOnce SELECT-then-INSERT with an atomic INSERT-WHERE-NOT-EXISTS path, eliminating one hot SELECT per enqueue attempt.
- Same profiler workload: SELECTs 904 → 669 (-26.0% from v0.5.18; -51.0% from v0.5.17 baseline 1,365), estimated rows read 4,920 → 4,685.

## v0.5.18 — Precision Layout + D1 Read Optimization

- Rebuilt the main dashboard on deterministic CSS grids: 4-column metrics, 1:1 Compute/Evidence, 1:1 Projects/Approval, and a 12-column detail grid.
- Fixed table row/column drift with fixed-layout tables, unified cell heights and consistent gutters.
- Deferred FDIC / Official Source / External Validation Matrix loads until after the critical project/candidate render and cached them per project cycle/evidence revision.
- Batched FDIC status dashboard reads into one D1 round-trip in production instead of sequential status queries.
- Batched Official Data status reads into one D1 round-trip.
- Removed the FDIC episode-link write N+1 pattern by accumulating writes and using D1 batch.
- Memoized high-frequency project cycle/evidence metadata and protocol-integrity head reads during candidate simulation.
- D1 profiler on the same synthetic full pipeline: SELECT count 1,365 → 904 (-33.8%), total query count 4,094 → 3,633 (-11.3%), estimated rows read 5,381 → 4,920 (-8.6%).
- Lightened the feasible-region canvas to match the white research-portal UI.

## v0.5.17
- 청와대/공공 포털형 레이아웃을 다시 정리하고 panel title/subtitle을 항상 2행 구조로 고정해 어색한 줄바꿈을 제거했습니다.
- 메인 비주얼 바로 아래 `RESEARCH BRIEFING`을 추가해 현재 프로젝트명, stage, 후보수, Evidence revision, 승인 gate를 항상 노출합니다.
- 프로젝트 목록이 비어도 마지막 프로젝트 ID를 직접 조회해 복구를 시도하는 recovery path를 추가했습니다. 목록 API/스키마 호환 문제로 연구내용이 사라진 것처럼 보이는 상황을 완화합니다.
- 실제 프로젝트가 없거나 저장소 오류인 경우 blank dashboard 대신 recovery-first 경고 상태를 표시합니다.
- compute/projects/detail 영역의 좌우 균형, 카드 높이, 차트 높이, 모바일 반응형을 재조정했습니다.
- 테스트 84/84 통과.

## v0.5.16
- 대통령실 사이트를 참고한 화이트/네이비 공공서비스형 UI 전면 개편: 큰 타이포, 데스크톱 수평 메뉴, 6:6/7:5 균형 레이아웃, 상세영역 빈 공간 제거, 접근성·가독성 강화.

## v0.5.15 — Light Research Console UI

- Reference style: `cbdc-research-client.pages.dev`의 연구 콘솔 UI를 바탕으로 밝은 white/light-blue surface, compact form/card, restrained blue accent로 전면 개편.
- dark glassmorphism/과도한 배경 장식을 제거하고 입력·테이블·모달·Workbench까지 light theme으로 통일.
- compute/projects/detail panel의 `h-100` stretch와 고정 min-height를 무력화해 빈 공간을 크게 축소.
- hero를 compact research header로 축소하고 workflow/stats/chart/panels 간 vertical rhythm을 촘촘하게 재조정.
- 상세영역 desktop grid를 데이터 1.65fr / 인간검토 0.67fr / 작업 0.67fr로 재배치.

# Changelog

## v0.5.14 — Figure 7 layout fix
- Delegation Evidence Funnel의 마지막 Human 블록과 Final strict survivor 문구가 겹치던 문제를 수정했습니다.
- Funnel 본문 높이를 단계 수에 따라 동적으로 계산하고 footer 영역을 별도로 확보했습니다.
- 긴 주석을 두 줄로 분리하고 source snapshot을 별도 행으로 이동했습니다.


## v0.5.13 — Validation/Regret UX clarity
- Clarified Matrix/Funnel lifecycle: G3 Robust Validation creates the matrix/funnel; G5 Recompute confirms the Human layer; G6 is human scientific sign-off, not another statistical test.
- Split the dashboard conceptually into `Robust Minimax Regret` and `Human Recompute` instead of implying that human trials directly recompute the regret metric.
- Added regret provenance to project detail: basis, Research Cycle/Evidence Revision, last update time, and Historical/Adversarial/BIS/ECB scenario counts.
- Explicitly labels Human Recompute as excluded from the minimax-regret metric; human-only evidence changes need not change the regret number.
- Replaced ambiguous “후보 검증 후 자동 생성” placeholders with gate-specific guidance.
- Added regression guards for the new explanatory labels.


## v0.5.6 — Episode Reverification Workbench
- Added a full-screen Bootstrap Workbench for CRITICAL/HIGH FDIC discrepancy episodes.
- Side-by-side view: thesis-panel values, FDIC CERT linkage, state-market HHI, Financials deposit dynamics, and SOD branch-level raw observations.
- Added conservative auto-suggested discrepancy causes (market definition, time window, accounting definition, reconstruction, coverage, linkage); suggestions never auto-determine the scientific conclusion.
- Added an 8-item human reverification checklist and reviewer-controlled status/action workflow: OPEN / IN_REVIEW / ESCALATED / RESOLVED.
- RESOLVED requires every checklist item and a reviewer note; completion creates a new REVERIFICATION_REVIEW evidence revision, stales the previous approval/report, and re-runs validation without silently changing panel values.
- Added D1 migration `0012_fdic_reverification_workbench.sql`, audit trail, report Table 3D, Workbench review summary, and `fdic_reverification_reviews.csv` export.
- Added regression tests for raw-evidence exposure, suggested causes, non-overwrite behavior, and checklist-gated resolution.


## v0.5.5 — FDIC discrepancy diagnostics & reverification priority
- Added `0011_fdic_reverification_priority.sql` and `fdic_reverification_rankings` to persist episode-level diagnostic comparisons without overwriting the thesis panel.
- Added automatic comparison of panel `concentration` vs FDIC SOD state-market HHI and panel `peak_outflow` vs FDIC Financials maximum quarterly peak-to-trough deposit drawdown.
- Added empirical-percentile discrepancy score across available dimensions and CRITICAL/HIGH/MEDIUM/LOW/INSUFFICIENT reverification priority tiers.
- Reconstructed provenance is a context/tie-break signal only, not a numeric penalty; ranking remains driven by observed discrepancy.
- Added automatic ranking refresh after every FDIC collection, API endpoints (`GET/POST /fdic/reverification`), dashboard TOP ranking table, report Table 3C, thesis CSV export, and audit event.
- Added explicit comparability guardrails: FDIC state HHI and quarterly drawdown are validation covariates/proxies and never silently replace thesis `concentration` or `peak_outflow`.
- Added regression tests for ranking order, priority classification, reason metadata, and non-overwrite behavior.

# v0.5.4 — FDIC SOD + Financials automatic connectors

- Added episode↔FDIC CERT linkage registry with conservative auto-match from the official Failures endpoint and manual confirmation path.
- Added CERT-linked Financials collection (episode year-1 through episode year, available from 1992).
- Added CERT-linked SOD collection (available from 1994) and state-market deposit HHI verification metric.
- FDIC-derived metrics are verification covariates only; they never silently overwrite thesis `concentration` or `peak_outflow`.
- Added optional `FDIC_API_KEY` secret support (`X-Api-Key`) for FDIC's evolving API governance.
- Added one-click FDIC package enablement (register both connectors → conservative CERT auto-match → queue collection), plus manual matching/collection controls.
- Scheduled re-fetches are change-aware: unchanged FDIC payloads do not create new evidence revisions or needless DCV revalidation cycles.
- Added migration `0010_fdic_connectors.sql` and connector tests.

# v0.5.3 — Incremental DCV Revalidation

- Added evidence revisions and research cycles.
- A new human-review trial invalidates the prior approval and re-runs VALIDATE → RECOMPUTE → APPROVE only.
- New external/empirical data opens a new research cycle from MEASURE; scenario updates restart at COMPUTE; design/constraint/RQ changes restart at DEFINE.
- Approval workflow now reports six evidence gates (Protocol, Compute, Robust Validation, Human Validation, Recompute, Scientific Sign-off) rather than the project stage index.
- Added stale approval/report semantics and evidence snapshots for auditability.
- Added external-source presets for FDIC, BIS, ECB, BOK ECOS, IMF FAS and World Bank Findex.
- Stage aliases now display scientific_review as APPROVED and complete/report_ready as REPORT.

# v0.5.2  D1 읽기 재점검 2차 + 큐 지연 전달 보정

- **그림 M0(연구모형 전체 설계도) 겹침 수정**: 절 좌표가 서로 모순이어서 ⑦ 복구 규칙이 섹션 4 제목에 가려지고, 섹션 5·6 상자가
  섹션 7 제목을 덮고, 섹션 7 상자와 결론 바가 겹치며, 시나리오 집합 상자의 두 줄·섹션 6 하단 카드와 "Ideal Reviewer Region"
  문구가 겹쳤다. 좌표를 위에서 아래로 누적 계산(섹션 2 상자 확대, 섹션 3 좌측 열 확장, 섹션 5~7 순차 배치)하도록 바꾸고 캔버스 높이를
  1584→1778로 확대. Word 삽입 시 페이지 넘침 방지를 위해 `buildDocx`에 이미지 높이 상한(`maxHeightCm`, 기본 22.5cm) 추가.

**연구 결과는 바뀌지 않는다**: 시뮬레이션·검증 결과 체크섬 `488d2e3adca2db28`이 v0.5.1과 동일, `buildThesisData`/CSV 6종은
4개 시나리오(검토자 0명·1명·40명·400명)에서 원본과 JSON 동일 확인.

측정(`scripts/profile-d1.mjs --api`, 추정 읽기 행수, 후보 128·검토자 관측 400·에폭 81):

| 항목 | v0.5.1 | v0.5.2 |
|---|---|---|
| 프로젝트 상세 `GET /api/projects/:id` | 870행 | **470행** (검토자 관측 수 COUNT 제거) |
| `GET /thesis` | 2,275행 | **1,643행** |
| `GET /export/candidates.csv` | 2,160행 | **1,528행** |
| 파이프라인 1회 완주 | 5,532행 | **4,907행** |
| 24시간 정상 운영(Cron 96회) | 96행 | 192행 (안전망 비용, 아래 참고) |

- **thesis 집계 중복 스캔 제거**: `simulation_runs` 2회→1회(단계별 집계를 같은 조회에서 JS로), `reviewer_observations` 2회→1회
  ((신뢰도 구간×참가자)로 묶어 한 번에 읽고 합계·참가자 수·구간별 값을 모두 파생).
- **카운터 비정규화(0008)**: `projects.candidate_count`, `projects.reviewer_obs_count`. 프로젝트 목록은 프로젝트마다 후보 128행을,
  상세는 검토자 관측 전체를 세던 것이 O(1). 관측은 계속 쌓이므로 이전에는 비용이 선형 증가. 시드 batch / `POST /reviewer-observations`
  batch 안에서 함께 갱신. 파이프라인 판정은 이 값이 아니라 원본 행을 사용한다.
- **클라이언트 중복 호출 제거**: 논문 도구 창이 Word/MD/HTML/JSON/ZIP/그림 저장 버튼을 누를 때마다 `/thesis`를 재조회하던 것을
  90초 사본 재사용으로. 참가자 시행 1건마다 후보 128행을 다시 받던 것을 생략.
- **큐 지연 전달 보정(정합성)**: `enqueue(…, delaySeconds)`가 `run_after`는 미래로 두면서 큐 메시지는 즉시 보냈다. 컨슈머가 아직 due가
  아닌 job을 못 집고 ack하면 그 job은 다음 메시지가 올 때까지 방치되고, `enqueueOnce`(0.5.1) 때문에 Cron이 되살릴 수도 없었다.
  이제 메시지도 같은 지연으로 보내고(`delaySeconds`, 상한 12h), 재시도 job에도 backoff 시각의 메시지를 예약하며, Cron이 due 상태의
  방치 job을 최대 10행까지 찾아 다시 깨운다(`wakeDueJobs`). 현실적 지연에서는 v0.5.1도 완주하므로 "항상 멈춤"이 아니라
  꼬리 구간·재시도에서 확률적으로 생기던 취약점의 제거다. 안전망 비용은 24시간 약 96행(인덱스 조회, LIMIT 10).
- 프로파일러: 지연 메시지를 지키는 시간 기반 큐 모델로 교체(이전 모델은 메시지당 6초를 흘려 위 문제를 가렸다), 카운터 정합 확인,
  파이프라인 상위 쿼리 출력 추가.
- 테스트 6건 추가(큐 지연·재시도 깨우기·방치 job 복구·thesis 단일 스캔·카운터 원자성). 전체 46건 통과.
- **배포 주의**: 마이그레이션 0008이 코드보다 먼저 적용되어야 한다(`deploy.yml`은 이미 그 순서). 카운터가 어긋났다고 의심되면
  `0008_denormalized_counts.sql`의 UPDATE를 다시 실행.
- **의도적으로 하지 않은 것**: (1) 검토자 대기 프로젝트의 Cron advance 생략 — `fit_reviewer` 성공 뒤 다음 단계 진행을 Cron의
  advance가 맡고 있어 위험. (2) `candidates.csv`/`/thesis` 서버 캐시 — 내보내기 데이터의 최신성이 더 중요. (3) compute_candidate마다의
  프로토콜 해시 1행 확인 — 변조 방지 장치이므로 유지.

# v0.5.1  D1 읽기(Rows read) 최적화

일일 무료 한도(5,000,000 rows read) 초과 대응. **연구 결과(시뮬레이션 수치·시드·프로토콜 해시)는 바뀌지 않는다**
(전후 결과 체크섬 동일, `scripts/profile-d1.mjs` 참고).

- **인덱스 추가(0007)**: `simulation_runs`, `validations`, `measurements`, `approvals`, `reports`, `audit_log`, `reviewer_observations`,
  `data_sources`, `raw_observations`, `jobs`에 `project_id` 기반 인덱스가 없어 매 요청이 모든 프로젝트의 행을 전체 스캔했다.
  `/candidates`의 상관 서브쿼리는 후보 행마다 `validations` 전체를 스캔했다.
- **완료 프로젝트 제외**: Cron(15분)이 `complete/report_ready` 프로젝트까지 매번 advance + 집계했다. 이제 건너뛴다.
- **인간 검토 대기 폴링 제거**: 표본 게이트 미달 시 `fit_reviewer → advance_project(900초) → fit_reviewer …`가 무한 반복되며
  매번 `reviewer_observations`와 전체 스캔 쿼리를 실행했다. 마지막 HOLD 이후 새 관측이 있을 때만 재시도(`projects.reviewer_hold_marker`).
- **advance_project 폭주 억제**: `compute_candidate`가 끝날 때마다 무조건 enqueue → 대기 중 1건으로 병합(`enqueueOnce`).
  검토자 관측 POST도 30초 지연 + 병합.
- **compute_candidate 1건당 재조회 제거**: 프로토콜 무결성(후보 128행+에폭+계수 재구성), 정의, 보정계수, 에폭 패널을
  isolate 메모(60초, 쓰기 시 즉시 무효화)로. 무결성은 동결 해시 1행 확인 + 10분 TTL 재검증.
- **루프 쿼리 제거(N+1)**: `validateProject`, `computeRegretTable`, `finalizeRecompute`, `enqueueRobustValidation`, `enqueueRecompute`.
- `claimJobs` 인덱스 순서 조회(대기열 전체 읽기+정렬 제거), 스테일 점검은 isolate당 2분 1회, 끝난 job 정리(하루 4회).
- 주기 수집에서 새 행이 없으면 measure→seed 연쇄 생략, `seedCandidates`의 불필요한 프로토콜 재구성 제거.
- 테스트 `tests/d1reads.test.mjs`(인덱스 회귀 가드 포함), 프로파일러 `scripts/profile-d1.mjs`.
- **배포 주의**: 마이그레이션(0007)이 코드보다 먼저 적용되어야 한다(`deploy.yml`은 이미 그 순서).

# v0.5.0 — Defense Rigor / International Review Hardening

- 확증 분석 전 연구 프로토콜 SHA-256 동결 및 protocol drift 차단
- 확증/강건 단계 Bonferroni family-wise 다중비교 보정
- n=81 패널 stratified bootstrap + reconstructed measurement-error 전파
- theta3 digital 계수를 historical calibration에 사용하지 않도록 수정
- FP/FN 손실계수를 direct cost가 아닌 empirical proxy로 명시하고 proxy-range sensitivity 추가
- 인간 검토자 모델을 관측건수 기준에서 participant-cluster bootstrap 기준으로 강화
- 최소 인간실험 sample gate(참가자/정답/오답 trial) 추가
- 교차사례 검증을 slope sign 하나에서 shared-grid Spearman + boundary MAE + slope 일치 기준으로 강화
- 자동 승인을 COMPUTATIONALLY_CONFIRMED로 제한하고 SCIENTIFICALLY_APPROVED는 사람의 수동 sign-off로 분리
- 보고서에 Claim Scope Matrix, 프로토콜 해시, 다중비교, calibration uncertainty, proxy identification 한계 자동 표기
- 신규 migration 0006_defense_rigor.sql 및 rigor test 추가

# Changelog

## 0.4.3
- FP/FN 용어를 엔진 기준으로 전면 통일: FP=정지 오판(정상지급 차단), FN=정지 누락(부정지급·유출 미차단).
- 표 M5의 과거 용어 대응 주의문 삭제, 표 2/6/8 및 연구모형 그림 라벨 수정.
- 81개 위기 사례 패널 기반 경험적 손실 보정 추가: 실패/비실패 peak_outflow 층화로 c_FN/c_FP, q95, 검토·재조정 비용 스케일 도출.
- 식 18~24와 compute.js 손실/목적함수를 같은 경험적 스케일로 교체; 임의 0.45/1.4, 0.045/0.012, K 손실배수, 목적함수 임의 가중치 제거.
- 패키지에 crisis_episodes_platform.json 포함 및 UI/API에서 내장 81개 사례 적재+OLS 재보정 지원.
- A3형 '박사논문 연구모형 전체 설계도'(그림 M0) 자동 생성 및 Word/HTML/Markdown 보고서에 포함.

## v0.4.2 — 보고서에 박사논문 연구모형 전체 설계 추가
- Added: 보고서 **1절 "박사논문 연구모형 전체 설계"** (자동 생성 보고서, Word·HTML·Markdown 공통). 구성: 1.1 연구대상 · 1.2 연구모형(데이터–결정 사슬) · 1.3 연구질문 RQ1~3 · 1.4 연구설계(DCV-C 단계·게이트 판정 규칙) · 1.5 연구명제 P1~P4 · 1.6 변수·설계벡터 · 1.7 계산 산식 · 1.8 위임 가능 영역 개념도와 증거수준. 이후 절 번호는 2~10으로 이동.
- Added: **연구모형 그림 3종**(그림 M1 데이터–결정 사슬과 𝒟 정의, M2 DCV-C 연구설계·게이트·논문 3편 대응, M3 위임 가능 영역 개념도). M1의 제약값, M2의 현재 프로젝트 진행 상태(정의 버전·후보 수·검증 건수·검토자 관측·최종 판정)는 프로젝트 자료에서 채워짐. M3은 모식도이며 그림 안에 표기.
- Added: **계산 산식 37개(번호 자동 부여)**: 설계벡터, 잠재상태·관측, 실증 채널 Π, EMA/Kalman/변화점/적응형 추정기, 신뢰도 Φ, 검토 규칙(K0~K3), 손실·복구(safe mode)·목적함수 J, 제약·위임 가능 영역 𝒟, Wilson 구간, FEASIBLE/INFEASIBLE/UNRESOLVED 판정, 경계 점수, 시드 분리, ±40% 27조합 stress, Regret·Minimax Regret·x*, 실증 회귀, ARR·ERT, 인간 행동 재투입(𝒟_ideal→𝒟_human). 엔진(`compute.js`)의 실제 연산·기본값과 대응시켰고, 기본값은 프로젝트 벤치마크 설정을 우선 사용.
- Added: **수식 렌더링**(`public/mathtext.js`): 보고서 Markdown에서 `$$ … $$ (n)` 별행 수식, `$…$` 인라인 수식. 그리스 문자·아래/위첨자·분수·집합 기호 지원. 보고서 창·HTML에서는 수식 블록, Word(.docx)에서는 Cambria Math 네이티브 첨자 런으로 나오는 "Equation" 스타일 문단(번호 우측 정렬).
- Added: 이전 버전으로 저장된 보고서를 열면 저장된 요약·논의 문장은 유지한 채 연구모형 절을 자동으로 추가(`upgradeStoredReport`, AI 재호출 없음).
- Tests: `tests/model.test.mjs` 추가(수식 파서, HTML/Word 수식 출력, 수식 번호 연속성·인라인 `$` 짝·미해석 명령 없음, 빈 프로젝트, 저장 보고서 자동 업그레이드). 전체 26개 통과.

## v0.4.1 — 보고서 Word(.docx) / Markdown+그림 다운로드
- Added: **진짜 Word(.docx) 내보내기** (`public/docx.js`, 외부 라이브러리 없음). 기존 `.doc`는 HTML을 Word 확장자로 저장한 파일이라 서식·그림이 Word 버전에 따라 깨지고 편집이 불편했음. 이제 표는 Word 네이티브 표(삼선표, 페이지를 넘겨도 머리행 반복), 그림 5종은 고해상도 PNG로 본문에 삽입(대체 텍스트 포함), 제목 스타일(탐색 창·목차 사용 가능), 글머리 목록, 인용 상자, 표/그림 캡션, 쪽번호, A4 여백 포함. OOXML 스키마(XSD) 검증 통과, Word·LibreOffice에서 열림 확인.
- Added: **Markdown + 그림 ZIP** (report.md + figures/*.png·svg). Markdown은 그림을 파일로 참조하므로 단일 .md에는 그림이 포함될 수 없어, 상대경로가 살아 있는 폴더째 내려받도록 함(Typora·VS Code·Obsidian 호환).
- Added: 보고서 창 상단에 **Word / MD+그림** 바로 받기 버튼. 기존 "다운로드" 버튼은 "더보기"(논문 도구 창)로 변경.
- Changed: 논문 패키지 ZIP의 `report.doc` → `report.docx`.
- Removed: HTML 위장 `.doc` 생성 코드(`buildWordDocument`).
- Tests: `tests/docx.test.mjs` 추가 — python-docx로 열어 표·그림·제목·목록·캡션 개수와 한글 텍스트를 검증(python-docx가 없으면 자동 건너뜀).

## v0.4.0 — Thesis toolkit (논문 작성 보조 도구)
- Added: **논문급 자동 보고서**. 연구질문·설계공간·제약(표 1~2), 실증 패널 기술통계(표 3), 실행량(표 4), 변수별 위임 가능 비율+Wilson 95% CI(표 5), 추정기 비교(표 6), Minimax Regret 상위 후보(표 7), 선택 후보 단계별 성능(표 8), 강건성 검증(표 9), 검토자 행동 모수(표 10~11), 판정 근거, 논의·한계·후속 연구, 재현성 부록. 수치는 전부 D1 집계에서 계산하고 AI는 요약·논의 문장만 작성(수치 생성 금지). 기존 대비 분량·정보량 대폭 증가.
- Added: **논문 사용 전 점검 사항** 자동 생성(검토자 표본·참가자 수, estimated 자료 비율, Evidence Level, 자동 승인 여부, 일반화 시뮬레이션 모델 경고 등).
- Added: **그림 5종**(SVG 벡터 + PNG ×2~×4 고해상도, 흰 배경·색각 친화 팔레트): σ×α 히트맵, 추정기별 비율+CI, Regret 순위, 검토자 수용률, 사례 패널 산점도.
- Added: **논문 도구 창**(상세 패널의 "논문 도구" 버튼): 그림 개별 PNG/SVG, 표 CSV(UTF-8 BOM, Excel 한글 호환), 보고서 MD/HTML(인쇄·PDF)/Word(.doc), 전체 **논문 패키지 ZIP**. 위임 가능 영역 패널에 PNG/SVG 빠른 저장 버튼 추가.
- Added: 보고서 창이 그림·표가 포함된 서식 보기로 열리며 "원문 보기" 전환 지원.
- Added: `GET /api/projects/:id/thesis`(집계 JSON), `GET /api/projects/:id/export/<name>.csv`.
- Fixed: 프로젝트 "열기" 버튼이 이미 열려 있는 상세 패널에서는 아무 반응이 없어 보이던 문제 → 상세 패널로 스크롤·강조하고 안내 메시지 표시.
- Tests: 실제 SQLite(node:sqlite) 기반 D1 shim으로 집계·보고서·CSV·그림·ZIP 통합 테스트 추가(Node ≥22.5, 없으면 자동 건너뜀).

## v0.3.2 — Menu navigation & AI summary fixes
- Fixed: 좌측 오프캔버스 메뉴가 동작하지 않던 문제. `<a data-bs-dismiss="offcanvas">`는 Bootstrap이 기본 동작(hash 이동)을 막고, 열려 있는 동안 body 스크롤이 잠겨 이동이 불가능했음. 이제 JS 핸들러가 메뉴를 닫은 뒤(`hidden.bs.offcanvas`) 해당 섹션으로 스크롤하며, 프로젝트 미선택 시 숨김 섹션(데이터/Empirical)은 첫 프로젝트를 자동으로 연다. "논문 및 리포트"는 보고서 모달을 연다.
- Fixed: AI 요약 미동작. 원인: (1) 프롬프트에 JSON 스키마가 없음 (2) max_tokens 700으로 한국어 JSON이 잘려 파싱 실패 (3) 1B 모델 (4) 전체 evidence를 그대로 전달. → 8B 모델 체인, 스키마 명시, 1800 토큰, 잘린 JSON 복구, 압축 evidence, 실패 시 규칙 기반 요약으로 대체.
- Added: 보고서 모달의 "AI 요약 재생성" 버튼, `GET /api/ai/test` 진단 엔드포인트, 보고서 숫자 포맷팅/수식 정리, 요약 생성 방식 표기.


## v0.3.1 — Free-plan resource fixes
- Measure no longer builds the full ~34,560-point design grid; `sampleDesign` draws a deterministic pool and does incremental maximin (~1 ms instead of seconds of CPU).
- Candidate seeding is its own job (`seed_candidates`); measure only measures.
- Compute jobs are inserted with one D1 batch and chunked `sendBatch` (Free-plan subrequest limit).
- Jobs stuck in `running` (Worker killed by a resource limit) are recovered automatically after 8 minutes.
- `advanceProject` no longer re-creates `define_project` while setup jobs are queued/running (this caused duplicate `measure_project` rows).

## v0.3.0 — Empirical calibration layer
- Added current user-supplied CBDC paper n=81 published empirical anchor.
- Added provenance-separated parameter registry: estimated / estimated_inconclusive / literature_bounded / author_calibrated / design.
- Added empirical episode import and local OLS refit pipeline; partial imports cannot silently replace the published profile.
- CDRS scenarios now use the published concentration×shock channel and the paper's ±40% robustness envelope.
- Added empirical readiness to dashboard, approvals and generated reports.
- Evidence Level A now requires a locally complete episode panel plus human validation; published-anchor-only runs are capped below A.
- Added migration 0005 and deterministic empirical regression tests.


## 0.2.0 — 2026-09-30

### UI / UX
- Design C visual system
- Bootstrap 5.3.8 navbar + hamburger offcanvas
- Responsive research dashboard
- Live CDRS evidence and feasible-region canvas
- Approval workflow and minimax-regret panels

### Compute
- Replaced simple simulator with CDRS v2
- Maximin initial design
- EMA / Kalman / Change-point / Adaptive estimators
- Wilson/mean CI constraint gates
- Boundary-focused sequential simulation
- Deterministic independent confirmation seeds
- Historical / Synthetic / Adversarial robust scenarios
- Scenario-wise Minimax Regret
- Human reviewer empirical recomputation

### Platform
- Added `candidate_evidence`
- Added CDRS candidate metadata columns
- Added Cloudflare Queues compute transport with D1 durable fallback
- Added unit tests and GitHub Actions test step

## 0.5.7 — Project Persistence Guard
- 기존 D1 프로젝트가 최신 schema 컬럼 부재 때문에 목록에서 사라져 보이지 않도록 `/api/projects`를 legacy-schema compatible 조회로 변경.
- D1 `storage_lineage_id`를 도입하여 DB binding이 바뀌면 UI가 즉시 경고하고, 빈 목록을 삭제로 오인하지 않도록 함.
- 마지막 선택 프로젝트를 localStorage에 기억하여 새 배포/새로고침 후에도 같은 프로젝트를 복원.
- GitHub Actions에 `DCV_EXPECTED_D1_DATABASE_ID` 검증, migration 전후 프로젝트 수 감소 차단 guard 추가.
- critical migration safety test: `projects` table DROP/DELETE 금지.

## 0.5.8
- Added Case A official connector layer: BIS CPMI cashless payments, ECB Supervisory Banking Statistics (LCR/CET1), Bank of Korea ECOS.
- Added Case B layer for Open Fiscal Data and e나라도움 with configurable endpoint/row/value/time mappings and secret-based authentication.
- Added normalized `official_observations`, sync audit trail, Case A/B layer status, CSV exports and thesis report section 3.7.
- Preserved incremental DCV revalidation: only changed observations count as new evidence.

## v0.5.9 — BIS/ECB CDRS mapping + D1 read optimization
- BIS CPMI total cashless/fast-payment observations are converted to an external `D_CPMI` validation proxy using a historical-level percentile and fast-payment share; panel `digital_adoption` is never overwritten.
- ECB LCR/CET1 are converted to an external resilience index `R_ECB` from regulatory-minimum headroom and mapped only to the predeclared CDRS stability-threshold range; this is an external stress-validation mapping, not Korea calibration.
- Added `external_validation_metrics` and six explicit official-data CDRS stress scenarios (BIS level/fast/equal and ECB LCR/CET1/equal).
- Official-source ingestion no longer executes a D1 SELECT inside the observation loop: one source-wide prefetch plus `DB.batch()` writes only changed rows.
- Consolidated repeated project metadata reads, reduced project-list PRAGMA/COUNT reads, and added an in-flight-job guard before candidate aggregate scans during Cron advancement.
- Added supporting indexes and D1 profiling documentation. Existing project rows remain non-destructively preserved.

## v0.5.10 — External Validation Matrix
- Added candidate-level validation layers: Historical, Synthetic, Adversarial, BIS, ECB, Human.
- Stress simulations now retain subgroup evidence so BIS/ECB external validation is no longer collapsed into one aggregate stress result.
- Added persistent `candidate_validation_matrix`, dashboard matrix, current-cycle API and CSV export.
- Added automatic thesis Figure 6 and report section 5.1 with full candidate survival/hold/fail paths.
- Missing external or human evidence is represented as N/A, never as automatic failure.
- Matrix refreshes after robust validation and after human recomputation.


## v0.5.11 — Delegation Evidence Funnel
- Added Figure 7 `fig7_delegation_evidence_funnel`.
- Added strict cumulative survival funnel to thesis JSON (`survival_funnel`).
- Added report §5.2 and Table 9C.
- Added compact dashboard funnel below External Validation Matrix.
- Whole-layer N/A is carried forward and explicitly labeled; HOLD/candidate-level N/A do not count as confirmed survival.


## v0.5.12 — Figure 7 Current-Project Provenance
- Figure 7에 프로젝트명, Research Cycle, Evidence Revision, 생성시각을 표시.
- Dashboard funnel에 ‘현재 프로젝트 실제 결과 / 예시값 없음’ 메타 라벨 추가.
- Report 5.2/표 9C에 현재 snapshot의 실제 계산값만 사용함을 명시.
- Validation Matrix API가 project_name/generated_at/basis=CURRENT_PROJECT_ONLY를 반환.

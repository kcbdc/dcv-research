# DCV Research Platform v0.5.21

> Defense Rigor release: frozen protocol, simultaneous inference, calibration uncertainty propagation, participant-cluster human validation, and human scientific sign-off.

## v0.5.15 Light Research Console UI

- `cbdc-research-client.pages.dev`의 밝은 연구도구 UI 계열을 참고해 전체 화면을 white/light-blue 연구 콘솔로 재설계했습니다.
- 장식형 dark hero를 compact research header로 축소하고 카드/입력/테이블/모달/Workbench를 일관된 white surface로 통일했습니다.
- compute/project/detail 영역의 강제 높이와 stretch를 제거해 과도한 공백을 줄였습니다.
- External Data 영역은 desktop에서 1.65fr + 0.67fr + 0.67fr compact grid로 배치해 긴 왼쪽 패널과 빈 오른쪽 패널 문제를 완화했습니다.

## v0.5.14 Figure 7 layout fix
- Figure 7의 Human 단계와 최종 strict survivor/주석 영역을 분리해 글자 겹침을 제거했습니다.
- 단계 수에 따라 SVG 높이를 자동 계산하고, 하단 요약은 별도 footer 영역에 배치합니다.

## v0.5.13 Validation/Regret UX clarity

대시보드에서 G3/G5/G6의 의미를 분리해 표시합니다. External Validation Matrix/Funnel은 G3 완료 후 생성되고 G5 완료 시 Human 열까지 확정됩니다. `Robust Minimax Regret`은 Historical + Stress(Adversarial + BIS + ECB) 기준이며 Human Recompute는 별도 후보 재판정 단계로 표시됩니다. Regret 화면에는 현재 Cycle/Evidence Revision, 사용 시나리오 수, 마지막 갱신시각이 함께 표시됩니다.


## v0.5.6 Episode Reverification Workbench

CRITICAL/HIGH FDIC discrepancy episode를 클릭하면 한 화면에서 원 논문 값, FDIC CERT 연결, Financials 분기 예금 시계열, SOD branch 원자료, discrepancy 원인 후보, 8개 재검증 체크리스트와 인간 검토 결론을 처리할 수 있습니다. Workbench는 원 데이터를 자동 대체하지 않으며, `RESOLVED`는 모든 체크리스트 완료 + reviewer note를 요구합니다. 최초 완료 시 `REVERIFICATION_REVIEW` evidence revision을 생성하여 이전 승인/보고서를 stale 처리하고 검증 단계부터 다시 평가합니다.

# DCV Research Platform v0.2

**Define → Measure → Compute → Validate → Recompute → Approve** 전 과정을 Cloudflare에서 자동 실행하는 박사논문 연구 플랫폼입니다.

## v0.2 핵심 변경

### Design C UI/UX
- Bootstrap 5.3.8 기반 responsive layout
- 상단 햄버거 + Offcanvas navigation
- Midnight navy / holographic cyan / teal / amber Design C theme
- D1 실제 데이터를 이용한 KPI, CDRS evidence, Minimax Regret, approval workflow
- Canvas 기반 `σ × α` 위임 가능 영역 시각화

### CDRS v2 compute engine
`src/lib/compute.js`는 단순 후보 시뮬레이션이 아니라 다음 연구 절차를 직접 수행합니다.

1. Maximin space-filling initial design
2. EMA / Kalman / Change-point / Adaptive estimator benchmark
3. Exploration simulation
4. Wilson / mean confidence intervals로 제약 증거 판정
5. `FEASIBLE / INFEASIBLE / UNRESOLVED` 3분류
6. UNRESOLVED 경계 후보에 simulation budget 집중
7. deterministic independent confirmation seeds
8. Historical / Synthetic / Adversarial scenario validation
9. scenario-wise objective 계산
10. robust feasible 후보 간 Minimax Regret 계산
11. empirical human reviewer model을 투입한 Recompute
12. Safety-first / Regret-second 최종 승인

`UNRESOLVED ≠ INFEASIBLE` 원칙은 코드 수준에서 유지됩니다.

## Cloudflare 구성

- **Workers**: API / orchestration
- **D1**: 모든 연구 상태, 원천 데이터, 후보, evidence, simulation, audit trail
- **Queues**: 계산 job 실행 transport
- **Workers AI**: 정의 검토 및 evidence-only 연구결과 요약
- **Static Assets**: Design C dashboard
- **Cron**: 외부데이터 재수집과 workflow wake-up

Cloudflare Queues는 2026년부터 Workers Free에서도 사용 가능하므로, HTTP Worker의 짧은 CPU 제한을 피해 CDRS 계산을 queue consumer에서 처리합니다. D1 `jobs` 테이블은 durable source-of-truth와 fallback queue로 유지됩니다.

## 최초 배포

```bash
npm install
npx wrangler login
npx wrangler d1 create dcv-research
npx wrangler queues create dcv-cdrs
```

D1 생성 결과의 `database_id`를 `wrangler.jsonc`에 입력합니다.

```bash
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

로컬 DB:

```bash
npm run db:migrate:local
npm run dev
```

## GitHub Actions

Repository secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

기존 workflow는 D1 migration 후 Worker를 배포합니다. 최초 1회 `dcv-cdrs` queue는 위 명령으로 만들어 두어야 합니다.

## 핵심 연구 변수

```text
x = (σ, τ, α, K, d, W, m, estimator)
```

- σ: information noise
- τ: information lag
- α: information-processing intensity
- K: delegation authority
- d: approval delay
- W: recovery margin
- m: adjustment trigger
- estimator: EMA / Kalman / Change-point / Adaptive

## 통계적 Gate

각 후보는 확률 제약에 Wilson CI, 연속 제약에 mean CI를 계산합니다.

- CI upper ≤ limit for all constraints → `FEASIBLE`
- any CI lower > limit → `INFEASIBLE`
- 그 외 → `UNRESOLVED`

UNRESOLVED 후보는 `boundary_score`에 따라 추가 simulation을 받습니다.

## Minimax Regret

Historical/Stress scenario 각각에서 후보별 objective를 구한 후 같은 scenario의 best objective와 비교합니다.

```text
regret(x,s) = objective(x,s) - min_x objective(x,s)
max_regret(x) = max_s regret(x,s)
```

제약을 통과한 후보만 regret ranking 대상입니다.

## 중요한 연구상 주의

현재 구조적 simulation model은 **81개 위기 사례 패널로 실증 보정된 연구 엔진**입니다. FP(정지 오판)·FN(정지 누락)의 비용 proxy는 실패/비실패 집단의 peak_outflow로 보정되며, 검토·재조정 비용도 동일 손실 단위로 스케일링됩니다. 다만 이는 실제 국고금 지급정지의 회계적 손실을 직접 관측한 값이 아니라 역사적 위기자료를 이용한 경험적 proxy이므로, 제3편의 실제 지급결제 사례에서 추가 외적 보정이 필요합니다.

## Empirical calibration (v0.3)

The platform ships with a **published empirical anchor** transcribed from the current user-supplied CBDC paper: n=81 historical crisis episodes (15 verified, 66 reconstructed), Specification-I reduced-form coefficients `kappa=-0.0683`, `theta1=0.0597`, `theta2=0.2466`, `RMSE=0.030`, and the paper's literature-bounded simulation ranges.

This is intentionally **not** represented as a locally reconstructed 81-row dataset. The PDF does not embed the authoritative machine-readable `crisis_episodes` archive. Until those episode rows are imported through `/api/projects/:id/empirical/episodes`, the dashboard reports `PUBLISHED_SUMMARY_ANCHOR`. A local OLS refit can be run at any time, but a partial import cannot automatically replace the published calibration; promotion requires the full target panel.

Parameter provenance is explicit:
- `estimated`: directly estimated panel coefficients;
- `estimated_inconclusive`: empirical coefficient with insufficient conventional significance (e.g. digital adoption);
- `literature_bounded`: simulation coefficients bounded by cited ranges;
- `author_calibrated` / `model_architecture`: structural simulation settings;
- `design` / `tuned`: DCV delegation and estimator choices.

This distinction is critical for the dissertation: `K`, `W`, `m` remain design variables; `alpha` is tuned; operational `tau` and approval delay `d` require timestamp/log data rather than being mislabeled as empirical estimates.

## 논문 도구 (v0.4.1)
프로젝트를 연 뒤 상세 패널의 **논문 도구** 버튼에서 다음을 내려받을 수 있습니다.

| 항목 | 형식 | 용도 |
|---|---|---|
| 논문 패키지 | ZIP | 아래 전부 + README |
| 보고서 | **Word(.docx)** / Markdown+그림(ZIP) / HTML | .docx는 표·그림 포함 편집 가능. HTML은 인쇄(Ctrl+P)로 PDF 저장 |
| 그림 5종 | PNG(×2~×4) / SVG | 본문 삽입, SVG는 Illustrator·Inkscape에서 편집 |
| 표·원자료 | CSV (Excel 호환) | 부록·재분석 |
| 전체 집계 | JSON | 보고서 수치의 원천 |

자세한 사용법과 논문 각 장에 대응시키는 방법은 `docs/THESIS_GUIDE.md`를 참고하세요.



## 보고서의 연구모형 절 (v0.4.3)
보고서 **1절**에 박사논문 전체 연구모형(연구대상·연구질문·연구설계·명제·변수·계산 산식·그림 M1~M3)이 자동 포함됩니다. 구현은 `public/model.js`(내용), `public/mathtext.js`(수식 파서), `public/figures.js`(그림 M1~M3)입니다. 수식은 Markdown에서 `$$ \\sigma\\le c_{j} $$ (n)` 형태로 쓰며 HTML·Word에서 모두 렌더링됩니다. 기존에 생성해 둔 보고서는 열 때 자동으로 이 절이 추가되고, 새로 생성하려면 "AI 요약 재생성"을 누르세요.
## Incremental DCV revalidation (v0.5.4)

Every new evidence item is versioned and classified by its earliest affected DCV stage. The platform re-runs only downstream dependencies and automatically marks older approvals/reports as stale.

- Human review trial → VALIDATE → RECOMPUTE → APPROVE
- External/raw/empirical data → MEASURE → COMPUTE → VALIDATE → RECOMPUTE → APPROVE
- Scenario/benchmark update → COMPUTE → VALIDATE → RECOMPUTE → APPROVE
- Design/constraint/RQ change → DEFINE → MEASURE → COMPUTE → VALIDATE → RECOMPUTE → APPROVE

The approval donut now reflects six evidence gates, not a UI stage counter. Scientific approval is bound to a specific `(research_cycle, evidence_revision)` and becomes stale as soon as new downstream-relevant evidence is registered.



## FDIC reverification priority (v0.5.5)
After FDIC Financials/SOD collection, the platform automatically builds a diagnostic reverification queue for CERT-linked episodes. It compares (1) thesis-panel concentration with FDIC state-market HHI and (2) panel peak_outflow with the maximum quarterly peak-to-trough FDIC deposit drawdown over episode year-1 through episode year. Each absolute gap is converted to an empirical percentile among comparable linked episodes; the mean of available percentiles is the discrepancy score. This is a workflow-priority diagnostic, not an outlier test and not an automatic data-correction rule.

Use **External Data → FDIC Episode Connector → 재검증 우선순위** or call `POST /api/projects/:id/fdic/reverification`. Rankings are also available by GET and in the generated thesis report / `fdic_reverification.csv`.

### 기존 연구프로젝트가 보이지 않을 때 (v0.5.7+)
프로젝트가 빈 목록으로 보이더라도 데이터 삭제로 단정하지 마십시오. 플랫폼은 D1 저장소 lineage를 브라우저에 기억하고, binding 변경 또는 schema migration 누락을 감지해 상단 경고를 표시합니다. 먼저 `wrangler.jsonc`의 `database_id`가 기존 운영 D1과 같은지 확인하고 `npm run db:migrate:remote`를 실행하십시오. CI에서는 `DCV_EXPECTED_D1_DATABASE_ID` secret을 등록하면 다른 D1으로의 실수 배포가 차단됩니다. migration은 프로젝트 수를 줄이면 배포 전에 실패합니다.

## v0.5.8 official data layers
- Case A: BIS CPMI Red Book (SDMX) → ECB SUP (SDMX) → Bank of Korea ECOS (API key).
- Case B: Open Fiscal Data + e나라도움/보조금통합포털. Case B is isolated from Case A and requires dataset-specific endpoint/mapping configuration plus Cloudflare secrets.
- Secrets: `ECOS_API_KEY`, `OPENFISCAL_API_KEY`, `BOJO_API_KEY`.
- New/changed official observations create external evidence; unchanged scheduled refreshes do not create a new research cycle.

### v0.5.9: official-data validation mapping
BIS CPMI and ECB supervisory observations now enter CDRS as **independent external validation scenarios**, not as silent replacements for the historical panel variables. `D_CPMI` combines the percentile of log cashless-payment volume with the fast-payment share when both are available. `R_ECB` combines LCR and CET1 regulatory-headroom scores and maps the result only inside the predeclared stability-threshold range. The report exposes component-only sensitivity variants.

D1 reads were also profiled and reduced: official observation ingestion now performs one indexed prefetch per source and batch-writes changed rows; the orchestrator avoids candidate-status aggregate scans while compute/validate/recompute jobs are already in flight.


### v0.5.10: External Validation Matrix
Each candidate is tracked across six independent evidence layers: `Synthetic`, `Historical`, `Adversarial`, `BIS`, `ECB`, and `Human`. The dashboard shows PASS/HOLD/FAIL/N/A for every candidate; the same evidence is exported as `validation_matrix.csv` and rendered automatically as thesis Figure 6. BIS/ECB are evaluated as separate official-data stress subsets and missing evidence remains N/A rather than being treated as failure.


### v0.5.12: Delegation Evidence Funnel (Figure 7)
- External Validation Matrix를 순차 검증 게이트로 재구성한 strict cumulative PASS 퍼널을 추가했습니다.
- Candidate pool → Synthetic → Historical → Adversarial → BIS → ECB → Human 순으로 누적 생존 후보를 계산합니다.
- HOLD 및 candidate-level N/A는 strict survivor로 계산하지 않으며, 특정 검증층 전체가 N/A이면 해당 층을 미검증으로 표시하고 직전 생존수를 이월합니다.
- 논문 보고서 Figure 7 및 표 9C, 대시보드의 compact funnel을 동일 데이터에서 자동 생성합니다.


### v0.5.12: Figure 7 current-project provenance labels
- Figure 7과 대시보드 funnel은 현재 프로젝트의 Project / Research Cycle / Evidence Revision / 생성시각을 명시합니다.
- 보고서의 표 9C와 Figure 7은 `candidate_validation_matrix` 현재 snapshot의 실제 계산값만 사용하며 설명용 예시 survivor count를 삽입하지 않습니다.
- 전체 validation layer가 N/A이면 이전 count를 이월하되 N/A로 명시하는 기존 원칙은 유지합니다.


### v0.5.17 UI recovery
- 청와대형 공공 연구포털 레이아웃, 강제 2행 제목/설명 구조
- RESEARCH BRIEFING에 현재 연구상태 상시 표시
- 마지막 프로젝트 직접조회 복구 경로로 연구내용 공백 상태 방지


### v0.5.18 UI / D1 optimization
Primary dashboard panels now use exact grid geometry, auxiliary data panels load after the critical research snapshot, and high-frequency D1 status/compute reads are batched or memoized. The included `scripts/profile-d1.mjs` can be used to re-check the read profile after deployment.


### v0.5.19 refresh/report recovery
Browser reload now waits until all project loaders are registered; the main analysis deck uses three independent columns, and the report modal defaults to rendered HTML with tables and figures instead of raw Markdown.


### v0.5.20 reload / report recovery
Browser reloads use no-store API reads, dashboard cards synchronize to the rendered right-side reference height on desktop, and report figures are hydrated independently so one rendering error cannot hide the complete figure set.


### v0.5.21 live-load / interaction recovery
Initial project data retries automatically, thesis/report controls resolve the DCV core dynamically, desktop cards synchronize to the right-side rendered reference height, and report figures hydrate independently with fallback rendering.


## v0.7.4 Aggressive Hybrid Fast Path
Cloudflare Worker now handles measure/seed and short state-transition chains every minute; heavy simulation/validation/collection/report jobs remain on GitHub Actions. Shared transition jobs can be claimed by either runtime, so a running Actions job can continue directly into the next gate instead of waiting for the next Worker Cron. The dashboard labels each recent job as WORKER FAST, SHARED FAST, or GITHUB HEAVY.

## Event-driven GitHub Actions wake-up (v0.7.6)

Heavy research jobs no longer depend on the GitHub scheduler as the primary trigger. In hybrid mode the Worker dispatches `dcv-research.yml` when heavy work enters D1, while the 1-minute Worker Cron recovers any pre-existing backlog. GitHub's 5-minute cron is retained only as fallback.

Cloudflare Worker must have this secret:

```bash
npx wrangler secret put GITHUB_ACTIONS_TOKEN
```

Use a GitHub token that can dispatch Actions for `kcbcdc/dcv-research-platform`. Non-secret routing values are already in `wrangler.jsonc`: `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_WORKFLOW`, `GITHUB_REF`.

Runtime diagnostics:

```js
fetch('/api/runner/status',{cache:'no-store'}).then(r=>r.json()).then(console.log)
```

`configured:true` and `heavy_due>0` should be followed by `dispatch_cooldown_active:true`, then `runner_active:true` or a newer `last_completed_at`.

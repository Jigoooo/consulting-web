# 판단 정량 도구 3종 (MCDA 민감도 · 몬테카를로) — 실측 (read-only, W3-analytics)

작성일: 2026-07-12 · 상태: **순수 계산 코어 구현·검증 완료. DB write/배포 없음.**
근거 로드맵: `docs/plans/2026-07-10-roadmap-gap-audit-and-methodology-plan.md` §3.5

## 구현
- `apps/api/src/consulting/decision-analytics.ts` — 의존성 0, 결정론적(seeded mulberry32 PRNG).
  - `analyzeWeightSensitivity()`: MCDA 가중치 ±p(기본 20%) 순위 안정성(몬테카를로) + 축별 one-at-a-time 임계 판정.
  - `estimateImpactInterval()`: 삼각분포 드라이버 → 파급액 구간(p10/p50/p90/mean/min/max).
  - 기존 `buildDecisionScorecard` MCDA 엔진 위에 얹는 분석층(재구현 아님).
- 유닛테스트 `test/decision-analytics.test.ts` **11/11 통과**(결정성·안정성·임계축·삼각분포 경계·분위수 정렬·구간 이동).

## 실측 데모 (창원 실수요, `scripts/decision_analytics_demo.ts`)
5축(법적정합·재정부담·형평성·운영난이도·수용성) × 3안(수당신설·기존확대·현행유지), seed=2026:
- **민감도**: baselineWinner=`status_quo`(현행 유지), winnerStability=**1.0**, 임계축 없음
  — 주어진 가중치(재정부담 0.25, lower-is-better)에서 현행 유지가 ±20% 섭동에도 100% 1위 유지.
- **통상임금 파급액 90% 구간**(대상인원 820~1010 × 월추가 9~16만 × 12 × 소급 1.0~1.6, 20k iter):
  - p10 **13.7억원** · p50 **16.8억원** · p90 **20.7억원** · mean 17.1억원
  - seed 고정으로 완전 재현 가능(감사 대응).

## 검증
- API `typecheck`·`lint`·`build` 그린. Web 회귀 무영향.
- 결정성: 동일 (입력, seed, iterations) → 동일 구간/안정성(테스트로 고정).

## 남은 배선 (후속, 선택)
- 결정표 UI에 민감도 안정성 배지 + 임계축 하이라이트, 파급액 p10/p50/p90 구간 표.
- `decision_scorecards.score_summary`에 sensitivity/interval JSON 병기(계약 확장 시).
- 인과추론(12.1)은 처치효과 데이터 부재로 보류 — `claim_type='causal'` 라벨만 추후.

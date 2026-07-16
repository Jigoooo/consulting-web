# 레버 A — Rubric-as-Verdict 판정 설계안 (v1 초안, 승인 전)

- 작성: 2026-07-15
- 성격: **설계 명세만.** 코드 미변경. 승인 후 TDD로 구현.
- 근거: Rubrics as Rewards (arXiv, Gunjal et al., 인용 203) / Rubrics Survey (RUC-NLPIR) / Deliberative Alignment (arXiv 2412.16339, category-spec) / Abstention Survey (TACL 2025)
- 목표: 현재 **이분법 게이트(PASS/BLOCKED)** 를 **구조화된 rubric 스코어(다축 0~1)** 로 확장해, 답변 차단 대신 "어느 축이 약한지" 피드백 → self-revise 정밀화 + 과잉거부 감소.

## 0. 왜 rubric인가 (한 줄)
이분법 게이트는 "통과/차단"만 알려줘 모델이 **무엇을 고쳐야 할지 모른 채 통째로 hedge**한다. Rubric은 판단을 축별로 분해해 **약한 축만 국소 보정**하게 한다 → alignment tax↓ + 정확도↑ (reward hacking도 축 교차검증으로 감소).

## 1. 현재 구조 (실측)
- `verifier-gate-policy.service.ts`: `VerifierGateInput{mode, exactnessStatus, citationIssueCount, verdicts, judgmentIssues}` → `VerifierGateResult{decision: PASS|PASS_WITH_WARNINGS|BLOCKED, blockers[], warnings[]}`
- `ClaimVerdict`: `{verdict, confidence(0~1), decisionImpact(0~1), matchedTerms, contradictedTerms, rationale}`
- `judgment-guard`: 8개 issue code (source_intake / stale_source / applicability / decision_gate / latest_authority / comparator / counterargument / overclaim)
- 임계 상수: `HIGH_IMPACT_THRESHOLD = 0.8` (verifier), `HIGH_IMPACT_HEDGE_THRESHOLD = 0.8` (claim-verifier)

## 2. Rubric 5축 정의 (컨설팅 도메인 매핑)

각 축 0~1 연속 스코어. 기존 신호를 재사용해 **새 LLM 호출 없이** 계산(결정론적).

| 축 | 정의 | 입력 신호(기존) | 계산식(초안) |
|---|---|---|---|
| **R1 evidence_sufficiency** | 주장에 직접 근거가 충분한가 | CRAG decision.status + verdict.verdict | supports=1.0 / not_enough_info=0.3 / refutes=0.0; insufficient CRAG면 ×0.5 |
| **R2 applicability** | 근거가 현재 범위에 직접 적용되나 | judgment-guard applicability_map + sourceRelation | directly_applicable=1.0 / analogical=0.5 / cross_project=0.3 / background=0.2 |
| **R3 citation_integrity** | 인용이 실제 검색근거와 일치하나 | citationIssueCount + matchedTerms | 1 - min(1, citationIssueCount×0.34); term overlap 보정 |
| **R4 conclusion_calibration** | 결론 강도가 근거·confidence에 맞나 | verdict.confidence × decisionImpact + overclaim issue | overclaim이면 penalty; confidence×(1-impact 편차) |
| **R5 exactness** | 수치·계산·법령이 검증됐나 | exactnessStatus | passed=1.0 / skipped=0.7(N/A) / blocked=0.0 **(하드 유지 축)** |

**중요**: R5(exactness)는 rubric화해도 **게이팅은 하드 유지** — blocked면 report/export 차단. 나머지 R1~R4는 **soft(피드백)**.

## 3. Rubric → decision 매핑 (mode별 임계, category-spec 반영)

기존 이분법을 **가중 스코어 + 축별 임계**로 대체. mode별로 임계를 다르게(deliberative의 category-spec 아이디어).

```
rubricScore = weighted_mean(R1..R5)  // 가중치는 mode별
weights(general_chat)   = R1:.2 R2:.2 R3:.2 R4:.2 R5:.2   // 균등, 관대
weights(analysis_draft) = R1:.25 R2:.25 R3:.2 R4:.15 R5:.15
weights(report_decision)= R1:.25 R2:.2 R3:.2 R4:.15 R5:.2  // 근거+exactness 무겁게
weights(final_export)   = R1:.2 R2:.2 R3:.25 R4:.1 R5:.25  // 인용+exactness 최우선

decision 규칙:
  - R5(exactness)=0 AND mode∈{report_decision,final_export} → BLOCKED (하드, 불변)
  - 그 외 축은 blocking 아님. 대신:
    · 축<0.4 인 R1~R4가 있으면 → PASS_WITH_WARNINGS + 그 축의 targeted self-revise 힌트
    · 전 축≥0.6 → PASS
  - final_export에서 R1<0.3 AND decisionImpact≥0.8 → BLOCKED (고위험 무근거만 차단, 기존 유지)
```

핵심: **일반/분석 경로는 절대 하드블록 안 함**(현재 계약 유지). rubric은 "차단"이 아니라 **"약한 축 → self-revise 지시"** 로 작동.

## 4. self-revise 연결 (레버 A + 기존 P2)

현재 `applyTargetedRepair`는 verdict별 단일 액션(remove/mark_insufficient/qualify_conditional). rubric을 얹으면:

```
for 약한 축 (score < 0.4):
  R1 낮음 → "이 주장은 근거가 부족합니다. 근거를 보강하거나 '자료 기준'으로 표현" (기존 qualify_conditional 재사용)
  R2 낮음 → "이 근거는 현재 범위에 직접 적용되지 않습니다. analogical 라벨 부착"
  R3 낮음 → "인용 N건이 검색근거와 불일치. 해당 문장 인용 재확인"
  R4 낮음 → "결론 강도가 근거보다 강합니다. 조건부/재설계 필요로 낮춤"
```
→ 모델은 **통째 hedge 대신 약한 축만 국소 수정**. 이게 alignment tax 감소의 핵심 메커니즘.

## 5. 구현 계획 (TDD, repo 내부, 배포 별도)
1. `RubricScore` 타입 + `computeRubric(input): {R1..R5, weighted, weakAxes[]}` 순수함수 (결정론적, 새 LLM 호출 0).
2. `verifier-gate-policy`에 rubric 필드 **추가**(기존 decision 계약은 유지 — 하위호환). RED 테스트: 동일 입력에 기존 decision 불변 + rubric 필드 채워짐.
3. self-revise에 weakAxes 힌트 연결. RED: R2 낮은 claim이 remove가 아니라 analogical 라벨.
4. exactness 하드 축 회귀 0 검증(기존 42 테스트 유지).
5. **A/B 지표셋(별도 문서)으로 rubric on/off 효과 측정** 후에만 배포.

## 6. 리스크 / 경계
- **reward hacking**: rubric 축을 모델이 게이밍할 수 있음(Rubrics Survey 지적). → 축을 **결정론적 신호**로만 계산(모델 자기채점 아님). LLM-as-judge 채점은 도입 안 함(비용+편향).
- **exactness 불변**: R5는 rubric 표기만, 게이팅은 하드.
- **하위호환**: `VerifierGateResult`에 rubric은 optional 추가. 기존 소비자 무영향.
- **측정 없이 배포 금지**: §5-5 A/B 필수.

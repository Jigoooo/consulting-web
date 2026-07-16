# 정밀 진단 리포트 — 하드게이트 vs 자율형 구조, "답답한 답변" 원인 분류

- 작성: 2026-07-15
- 대상: `consulting`(공유 두뇌) + `consulting-web`(웹/API) chat 경로
- 성격: **읽기전용 진단 + 설계 제안**. 구현·배포·프롬프트 수정은 별도 승인 후.
- 요청: "같은 모델인데 ChatGPT/Claude보다 답답한 이유가 게이트가 너무 타이트해서인가? 모델이 좋아질수록 정보만 주고 게이트는 자율형으로 열어야 하나? 방법론/논문 근거와 함께."

---

## 0. 결론 (먼저)

1. **모델 문제 아님.** 같은 gpt-5.5/claude라도 우리 하네스가 **alignment tax + over-refusal**을 스스로 부과 중.
2. 진짜 주범은 **후처리 게이트가 아니라 "프롬프트 방어지시 중복 주입"**. verifier-gate는 이미 티어 설계가 잘 되어 있어 일반 채팅을 막지 않는다. 문제는 **judgment-guard + memory-context가 매 턴 "단정하지 마"류를 10~20회 중복 주입**해 모델이 hedging(유보·양비론)으로 회귀하는 것.
3. 방향("정보 제공 + 자율형 게이트")은 **프런티어 정답**이며 Deliberative Alignment / Constitutional AI / Bitter-Lesson-for-agents가 뒷받침. 단 **exactness(수치·법령·DB)는 하드 유지** — 여기 자율화는 컨설팅 신뢰도 붕괴.

---

## 1. 실측한 게이트 6개 — 분류표

측정 위치: `apps/api/src/consulting/`, 프롬프트 밀도: `~/.hermes/config.yaml` 창원 채널 방어지시 **126회**(단정/금지/필수/반드시/검증/자가검증/중립/실증).

| # | 가드 | 실제 동작(코드 실측) | "답답함" 기여 | 분류 |
|---|---|---|---|---|
| 1 | **exactness-gate** | Decimal `sum_equals_total/percentage_change/ratio_percent`만 트리거. 수치 불일치→blocked (`:197`). general noun으로는 발동 안 함 | 낮음(정당한 정확성) | **하드 유지** |
| 2 | **verifier-gate-policy** | `general_chat`/`analysis_draft`는 `structuralBlocksEnabled=false`(`:52`)라 **전부 warning, 하드블록 없음**. 블록은 `report_decision`/`final_export`만 | **낮음** (이미 티어 설계 양호) | **하드 유지(리포트/수출만)** |
| 3 | **claim-verifier** | NLI verdict(refutes/mixed/not_enough_info) 생성. 하드블록은 verifier-gate가 판단 | 중간(과탐 시 warning 다수) | **소프트 전환** |
| 4 | **consulting-judgment-guard** | ★핵심 문제. `renderPromptContract`가 **issue 감지 여부와 무관하게 12개 규칙을 매 턴 주입**(`:160-176`). 그중 "단정하지 않는다/낮춘다"류 5회+ | **높음** | **소프트 전환(조건부 주입)** |
| 5 | **consulting-memory-context** | 검색 hit 블록마다 "확실한 근거처럼 단정하지 말고"(`:444`), CRAG 애매시 "단정하지 않는다"(`:424`), Evidence-to-Decision "단정 금지"(`:524`), 격리 안내 "단정하지 않는다"(`:111`) | **높음** (중복 누적) | **소프트 전환(중복 제거)** |
| 6 | **verification-quality-metrics** | 측정·집계용(NLI 정확도, false-block rate). 답변 경로 비차단 | 없음 | **유지(계측)** |

### 핵심 발견 — 게이트가 아니라 "프롬프트 오염"
한 턴 프롬프트에 "단정하지 마"류가 **최소 10~20회 중복**된다:
- judgment-guard 상시 12규칙(감지 0건이어도 주입) → ~5회
- memory-context 검색 hit N개 × "단정 말라" 라벨 → N회
- Evidence-to-Decision + CRAG + 범위격리 블록 → 3~4회
- config.yaml 창원 프롬프트 방어지시 → 배경 126회

→ 모델은 "안전하게 유보하라"는 신호를 압도적으로 받아 **강한 결론·직접 단정을 회피**. 이것이 "답답함"의 기계적 원인.

---

## 2. 왜 이런 구조가 품질을 떨어뜨리나 — 논문 근거

전부 1차 출처 확인(arXiv/ACL/OpenReview, 2026-07-15 실측).

| 현상 | 우리 증상 | 근거 |
|---|---|---|
| **Alignment Tax** | 방어지시↑ → 창의·강결론↓ | *Mitigating the Alignment Tax*(arXiv 2602.07892): "safety guardrails inhibit exploration of unconventional solution paths; tasks requiring creativity" 손상. Emergentmind "Alignment Tax" 정의 = 안전정렬 시 핵심역량 측정가능 하락 |
| **Over-refusal / Exaggerated Safety** | 무난·유보·양비론 | XSTest(NAACL 2024, 인용 752): "too safe and too harmless" 진단 표준. arXiv 2510.08158: 과잉거부 완화가 benign 유용성↑ |
| **Reward Model Overoptimization (Goodhart)** | "게이트는 통과하나 사람이 보기엔 나쁜 답" | arXiv 2210.10760: 프록시(검증기/게이트) 과최적화 시 ground-truth 품질 하락(Goodhart's law), 스케일링 법칙으로 측정 |
| **Scaffolding as debt** | 모델 강해질수록 하네스가 부채 | Bitter Lesson for Agents(context-engineering): "As models improve, rigid scaffolding becomes a liability; thin harness + strong model wins". Context Confusion: 지시·도구 과다 → 오작동 |

---

## 3. 자율형(deliberative) 전환 — 방법론

| 방법론 | 출처 | 핵심 | 우리 적용 |
|---|---|---|---|
| **Deliberative Alignment** ★ | OpenAI, arXiv 2412.16339 | 하드코딩 금지목록 대신 **모델에게 원칙(spec)을 주고 답변 전 명시적으로 recall·reason**. 견고성↑ + 과잉거부↓ 동시(파레토 프론티어 push) | judgment-guard를 "12개 명령"에서 "원칙 + 스스로 판단하라"로 |
| **Constitutional AI** | Anthropic, arXiv 2212.08073 | 규칙 목록 + **모델 자기비판·자기수정(self-revise)**. 하드 게이트 아님 | 답을 먼저 내고, 원칙 위반 의심 시 self-revise 1회 |
| **Bitter Lesson for Agents** | Sutton 계열 | 얇은 하네스 + 강한 모델 | 게이트를 걷어내는 쪽이 시간이 갈수록 유리 |

### 원리 한 줄
> **모델 역량이 오를수록 "제약(constraint)"의 한계효용은 음수로 간다.** 약한 모델엔 게이트가 하한을 올리지만(도움), 강한 모델엔 상한을 누른다(alignment tax). → 게이트를 **hard block → soft guidance(원칙+사후검증)로** 이관.

---

## 4. 병목(latency) 감소 — 구조

과거 CRR(Consulting Response Runtime): 41회 호출 → 3~5회. 그 위에:

| 기법 | 출처 | 효과 |
|---|---|---|
| Speculative / parallel tool exec | SPAgent(arXiv 2511.20048) | 추론시간 −23.8%, 미중첩 실행시간 −29.4% |
| Pattern-aware speculative tool exec | PASTE(Microsoft Research) | tool latency 은닉 |
| SSE delta 선전송 | (이미 채택) | 첫 토큰 조기 표시, 검증은 후단 durable 정착 |
| 게이트 blocking→non-blocking | 본 리포트 §5 | 답 먼저 → 사후 flag/자가수정 |

---

## 5. 실행 제안 (설계까지만 — 구현은 승인 후)

### A. 프롬프트 다이어트
- config.yaml 창원 프롬프트 126개 방어지시 → **원칙 5~7개 + "판단하라"** 로 압축.
- "단정금지" 반복 → "근거 있으면 단정하고 근거를 붙여라(기관근거→메커니즘→So What→행동)".
- judgment-guard `renderPromptContract`: **상시 12규칙 → 감지된 issue의 required_action만 조건부 주입**. 감지 0건이면 규칙 블록 생략.

### B. 게이트 2계층 재배치
- **하드 유지**: exactness-gate(수치·계산·법령·DB), verifier-gate의 `report_decision`/`final_export`. 여기는 틀리면 안 되는 영역 → 정당한 게이트.
- **소프트 전환**: judgment-guard + claim-verifier의 일반 채팅/분석 경로 → 답변 차단이 아니라 **사후 플래그 + self-revise 1회**.

### C. 자율형(deliberative) 게이트
- 검증기를 "통과/차단 스위치"에서 **"원칙 상기 + 모델 자기재검토 프롬프트"** 로. 실패 시에만 targeted repair(기존 draft→verify→repair→re-verify 루프 재사용).
- memory-context: 검색 hit별 중복 "단정 말라"를 **블록당 1회**로 통합. 라벨은 유지하되 반복 제거.

### D. Latency
- CRR 병렬화 + speculative verification(생성과 검증 겹침). 게이트 non-blocking 전환과 결합.

---

## 6. 리스크 / 경계

- **exactness 자율화 금지.** 수치·법령·DB는 하드 유지. 자율화는 표현·판단·유보 영역에 한정.
- **컨설팅 신뢰도 계약 유지**: 기관근거→메커니즘→So What→행동, 재정수치 표시값/원계수/반올림/제외비용/한계. 다이어트는 "방어지시 중복 제거"지 "근거 규율 제거"가 아니다.
- **A/B 필요**: 프롬프트 다이어트 전후를 XSTest류(과잉거부) + 자체 컨설팅 품질 eval로 측정. 결론보존 편법 금지 → 실측.
- **Telegram/Web 공통 두뇌**: 프롬프트 변경은 config.yaml(Telegram/Discord)과 web 양쪽에 영향. 두 surface 동시 고려.

---

## 7. 근거 출처 (1차 확인)
- Deliberative Alignment — arXiv 2412.16339 (OpenAI o-series)
- Constitutional AI — arXiv 2212.08073 (Anthropic)
- Reward Model Overoptimization — arXiv 2210.10760
- Learning to summarize from human feedback — arXiv 2009.01325
- XSTest (exaggerated safety) — ACL/NAACL 2024, aclanthology 2024.naacl-long.301
- Alignment Tax mitigation — arXiv 2602.07892 / OpenReview GFyVxtyMvq
- Over-refusal diagnostics — arXiv 2510.08158
- SPAgent latency — arXiv 2511.20048 / PASTE (Microsoft Research)
- Bitter Lesson for agents — context-engineering (philschmid, hugobowne)

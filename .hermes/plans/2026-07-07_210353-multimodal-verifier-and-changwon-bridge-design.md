# Multimodal Verifier + Changwon Bridge Hardening Design Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 현재 Evidence-to-Decision v1의 한계(local visual hash, deterministic verifier)를 외부 multimodal embedding과 real verifier로 확장하고, 새 consulting-web 프로젝트가 창원시처럼 기본 채널/토픽/shared brain link를 자동으로 갖도록 프로젝트 프로비저닝을 정비한다.

**Architecture:** `consulting-web`는 웹/API 인터페이스이고 `/home/jigoo/.hermes/workspace/consulting/db/consulting.db`가 Telegram/문서/Web 공용 consulting brain이다. 새 consulting project는 `consulting_default` 템플릿을 기본 자동 적용하고, project slug 기반 brain slug/link를 자동 생성한다. Visual retrieval은 `document_retrieval_units`를 확장해 Voyage multimodal을 1차 provider로 붙이고, ColPali/ColQwen은 GPU/로컬 옵션으로 provider 추상화한다. Verifier는 deterministic prefilter → NLI cross-encoder → LLM strict JSON judge의 캐스케이드로 구성한다. LangGraph는 즉시 전면 도입하지 않고, 검증→수정→재검증 루프가 필요한 report/decision workflow에 한정해 spike한다.

**Tech Stack:** NestJS, Drizzle/Postgres, shared consulting SQLite brain, Python workers, Voyage multimodal embeddings, optional ColQwen2/ColPali, SentenceTransformers NLI CrossEncoder, Hermes/LLM strict JSON judge, optional `@langchain/langgraph` spike for durable verification/repair workflows.

---

## 0. 리서치 요약

### 0.1 Visual document retrieval

- ColPali 계열은 PDF를 OCR 텍스트 조각으로만 보지 않고 **페이지 이미지를 직접 임베딩**한다.
- 핵심은 ColBERT식 **late interaction**: query token embedding과 page patch embedding을 multi-vector로 비교한다.
- Hugging Face ColPali 글/ColQwen2 문서 기준:
  - page screenshot/image 기반 retrieval
  - layout, table, chart, font, visual cue를 보존
  - embedding dimension은 ColQwen/ColPali multi-vector patch 단위에서 보통 128차 projection 계열
- Voyage AI 문서 기준:
  - `voyage-multimodal-3.5`는 text + image + video interleaved input을 같은 backbone으로 embedding
  - PDF screenshot, slide, table, figure 같은 content-rich image 지원
  - REST endpoint: `POST https://api.voyageai.com/v1/multimodalembeddings`
  - model: `voyage-multimodal-3.5` 권장, `voyage-multimodal-3` legacy
  - default embedding dimension 1024, 256/512/2048 선택 가능

**판단:** 우리 현재 `page_visual` local visual hash는 "페이지 이미지 unit 존재"까지는 맞지만 semantic retrieval은 아니다. 빠른 실용 경로는 Voyage multimodal provider. ColPali/ColQwen은 고품질/온프레미스 옵션이지만 multi-vector 저장/검색 설계와 GPU 비용이 필요하다.

### 0.2 Real verifier

- SentenceTransformers/HF NLI cross-encoder는 premise/evidence와 hypothesis/claim 쌍을 `contradiction / entailment / neutral`로 분류한다.
- 예: `cross-encoder/nli-deberta-v3-small`, `cross-encoder/nli-distilroberta-base`는 SNLI/MultiNLI 학습, 세 label score 출력.
- FEVER 8 2025 우승권 fact-checking pipeline은 retrieval + reranking + LLM evidence/label generation + JSON parsing 구조를 사용했고, verdict class는 Supported/Refuted/Not Enough Evidence류다.

**판단:** Evidence-to-Decision의 현재 verdict contract(`supports/refutes/not_enough_info`)와 잘 맞는다. 단 한국어 행정 문서 claim은 영문 NLI보다 LLM judge가 더 잘 맞을 가능성이 있어, 비용/정확도 균형상 NLI는 빠른 1차, LLM strict JSON은 최종/충돌/고위험 claim에 쓰는 캐스케이드가 적절하다.

### 0.3 LangGraph orchestration 검토

- 공식 JS 문서 기준 LangGraph는 low-level orchestration runtime이다.
- 핵심 기능은 durable execution, persistence/checkpointer, event streaming, human-in-the-loop interrupt/resume.
- JS 설치 패키지는 `@langchain/langgraph` + `@langchain/core`.
- 현재 `consulting-web` monorepo에는 `@langchain/langgraph` 의존성이 없다.
- interrupt는 상태를 저장하고 외부 입력을 기다릴 수 있지만, production에서는 durable checkpointer가 필요하다. 메모리 saver는 재시작 시 상태를 잃는다.
- LangGraph는 “검증 한 번”에는 과하다. 하지만 `draft → verify → repair/rewrite → re-verify → publish`처럼 조건부 루프/중단/재개가 생기면 가치가 있다.

**판단:** 지금 Evidence-to-Decision v1의 inline badge/우측패널 검증은 기존 Nest service + DB row로 충분하다. LangGraph는 답변을 다시 실행하거나 사용자의 승인/수정을 기다리는 **report/decision quality-gate workflow**에 제한 도입한다.

---

## 1. 현재 창원 연결 상태 — 운영 DB/brain 실측

### 1.1 결론

창원시 컨설팅은 **Telegram과 consulting-web이 둘 다 shared consulting brain의 같은 slug에 연결되어 있다.**

공용 brain slug:

```text
changwon-org-mgmt-diagnosis
```

추가 확인 결과, 운영 `consulting-web`에는 사용자가 만든 별도 테스트 프로젝트 `TEST`도 존재한다. `TEST`는 현재 기본 채널/토픽은 일부 있으나 `consulting_topic_links`가 0개라 shared consulting brain과 자동 연결되지 않는다. 즉 핵심 이슈는 "창원 중복 정리"가 아니라 **새 프로젝트 생성 시 창원시 컨설팅처럼 기본 구조와 brain link가 자동 생성되지 않는 것**이다.

### 1.2 운영 Postgres 실측

`consulting-web` prod DB:

| project_id | 역할 | channels | topics | messages | link |
|---|---:|---:|---:|---:|---|
| `699404ea-4186-4ed2-9f56-c86b66c19076` | 창원시 컨설팅 구조화 프로젝트: 자료수집/분석/보고서/질의응답 | 4 | 7 | 0 | `changwon-org-mgmt-diagnosis` active |
| `01fba1a5-7b16-4267-93df-f9ca6cf0462f` | 창원시 컨설팅 실대화 프로젝트: 텔레그램/test | 2 | 2 | 247 | `changwon-org-mgmt-diagnosis` active |
| `61f95d26-33e7-47ea-a374-7b19da02c39a` | TEST — 사용자가 만든 테스트 프로젝트 | 1 | 1 | 10 | 없음 |

활성 web topics 중 Telegram topic:

```text
project: 창원시 컨설팅
channel: 텔레그램
web topic: 대화 / default-chat
memory_topic_id: consulting:changwon-org-mgmt-diagnosis#telegram/default-chat
messages: 243
```

구조화 topics도 모두 같은 brain slug prefix를 갖는다.

```text
consulting:changwon-org-mgmt-diagnosis#source-collection/facility-baseline
consulting:changwon-org-mgmt-diagnosis#source-collection/meeting-requests
consulting:changwon-org-mgmt-diagnosis#analysis/facility-adequacy
consulting:changwon-org-mgmt-diagnosis#analysis/transfer-integration
consulting:changwon-org-mgmt-diagnosis#reports/interim-report
consulting:changwon-org-mgmt-diagnosis#reports/final-report
consulting:changwon-org-mgmt-diagnosis#qna/practitioner-questions
```

### 1.3 Shared consulting brain 실측

`/home/jigoo/.hermes/workspace/consulting/db/consulting.db`:

- `topics.slug = changwon-org-mgmt-diagnosis`
- title: `창원시설공단 조직 및 경영 진단 연구용역`
- workspace path: `/home/jigoo/.hermes/workspace/consulting/changwon`
- `dialogue_chunks` changwon-like matches: 109
- `file_chunks`: 602 chunks, 55 docs
- sources:
  - `telegram`: 다수 세션
  - `consulting-web`: 최소 1 chunk 확인
- `dialogue_session_scopes`에 `consulting-web-thread:*` scope binding 존재

### 1.4 연결 상태 판정

```text
Telegram 대화 ─┐
               ├─ shared consulting brain: changwon-org-mgmt-diagnosis ── consulting-web GraphRAG recall
Web 대화 ──────┘
```

즉 창원 연결은 되어 있다. TEST는 별도 테스트 프로젝트로 보아야 하며, TEST가 창원시처럼 자동 구조화/brain link를 갖지 못한 것이 다음 설계 과제다. 현재 `CreateProjectUseCase`는 project row와 선택 tag만 만들고, 기본 channel/topic/thread/consulting_topic_links는 만들지 않는다.

### 1.5 Telegram forum topic audit — 2026-07-07 재측정

Hermes Telegram config 기준:

```text
allowed_chats = -1004453868195
free_response_chats = -1004453868195
allowed_topics = null  # 모든 토픽에서 응답 가능
channel_prompts = 1개
  - key: -1004453868195:12
  - prompt topic: changwon-org-mgmt-diagnosis
```

즉 명시 프롬프트가 걸린 토픽은 기존 `12` 하나뿐이다. 그러나 `state.db.sessions`에는 같은 group 안에 추가 thread들이 기록되어 있다.

| Telegram thread_id | 추정/사용자 확인 토픽 | 세션 수 | session message_count | consulting dialogue chunks | 현재 연결 상태 | 문제 |
|---:|---|---:|---:|---:|---|---|
| `12` | 기존 `창원-컨설팅` | 1 | 45 | 10 | channel_prompt 있음, 창원 brain에 ingest됨 | 정상에 가장 가까움 |
| `524` | `창원_보수체계` 추정 | 4 | 62 | 15 | 창원 brain에 ingest됨 | channel_prompt 없음, web topic 분리 없음 |
| `533` | `창원_근속승진` 추정 | 2 | 141 | 18 | 창원 brain에 ingest됨 | channel_prompt 없음, web topic 분리 없음 |
| `356` | `창원_대행사업` 추정 | 1 | 119 | 37 | 창원 brain에 ingest됨 | channel_prompt 없음, web topic 분리 없음 |
| `1` | Telegram General/기타 창원 대화 | 2 | 20 | 3 | 창원 brain에 ingest됨 | 목적 불명, 별도 처리 필요 |
| `null` | 초기 pre-topic/legacy 세션 | 5 | 92 | 29 | 창원 brain에 ingest됨 | 과거 호환용 |

근거 키워드:

- `524`: 보수/보수체계/직급/호봉/지연계수/근속승진이 강함 → `창원_보수체계`에 대응 가능성이 높다.
- `533`: 근속승진/승진/직급/호봉이 강함 → `창원_근속승진`에 대응 가능성이 높다.
- `356`: 대행사업/위탁/이관/레포츠파크가 강함 → `창원_대행사업`에 대응 가능성이 높다.
- `1`: 과업지시서/공무직 승진체계 일부. Telegram General topic 가능성이 있으므로 자동 확정하지 말고 `general` 또는 `검토필요`로 둔다.

현재 `consulting.db.dialogue_topic_telegram` 상태:

```text
topic_id=5(changwon-org-mgmt-diagnosis), telegram_user_id=5557055657, thread_id=NULL
```

의미:

- 현재는 같은 사용자의 Telegram 세션을 thread 구분 없이 전부 창원 topic에 auto-bind한다.
- 그래서 추가 토픽들도 창원 brain에는 들어오고 있다.
- 하지만 토픽별 목적/프롬프트/웹 topic/recall scope가 분리되지 않는다.
- 과거 single-topic 시절에는 안전했지만, 지금처럼 여러 Telegram forum topic이 생기면 `thread_id=NULL` 전역 바인딩은 “같은 창원 프로젝트 내부 혼합”을 만든다.

consulting-web mirror 상태:

- web에는 `창원시 컨설팅 / 텔레그램 / 대화(default-chat)` 하나만 있고 messages 249개가 여기에 모인다.
- `창원_보수체계`, `창원_근속승진`, `창원_대행사업`에 대응하는 web topic은 아직 없다.
- 따라서 web에서 Telegram 토픽별 맥락을 따로 볼 수 없고, 채널 profile도 하나로만 주입된다.

---

## 2. 핵심 설계 결정

### 2.0 주인님 확정 결정 — 2026-07-07

| 항목 | 결정 | 구현 의미 |
|---|---|---|
| 새 프로젝트 기본값 | **A. 기본 자동 세팅** | consulting project 생성 시 `consulting_default` 템플릿을 자동 적용한다. 빈 프로젝트가 기본이 아니다. |
| brain slug | **자동 생성 + 고급설정 수정 가능** | 기본은 project slug 기반 자동 생성. UI/API에는 advanced override를 둔다. |
| TEST | **소급 세팅한다** | 기존 TEST 프로젝트에 기본 channel/topic/thread/brain link를 backfill한다. 단, dry-run 결과를 먼저 출력하고 기존 메시지는 보존한다. |
| 창원자료 외부 노출 | **Voyage 전송 허용** | 창원 PDF page image/text를 Voyage multimodal embedding API에 보낼 수 있다. 단, API key는 서버 env로만 관리하고 브라우저에 노출하지 않는다. |
| Voyage API key | **필요함** | Voyage 공식 문서 기준 `VOYAGE_API_KEY`가 필요하다. 키가 없으면 provider는 실패하지 않고 local fallback으로 내려간다. |
| LLM verifier 적용 범위 | **전체 claim 기본 적용** | 시간이 길지 않으면 모든 claim에 LLM strict JSON verifier를 적용한다. latency budget 초과/장애 시에만 risky claim 우선으로 downgrade한다. |
| LLM verifier 시간계측 | **필수** | claim별/answer별 verifier duration, p50/p95, LLM coverage ratio, fallback reason을 저장/노출한다. |
| LangGraph | **제한 spike** | 단순 검증에는 미도입. 자동 repair/rewrite/re-verify나 human interrupt가 필요한 report/decision workflow에만 `@langchain/langgraph`를 검토한다. |
| Telegram 추가 토픽 | **토픽별 registry/bridge/profile 생성** | `창원_보수체계`, `창원_근속승진`, `창원_대행사업`을 각각 web topic + internal profile + thread-specific binding으로 분리한다. |
| 계산/정확성 요청 | **도구 기반 Exactness Gate** | 계산·수치·날짜·법령·파일·URL·DB row 등 정확성이 필요한 답변은 Python/SQL/원문조회로 검증하고, 반복 검산 로그를 남긴 뒤 답한다. |

### Decision A — 프로젝트 생성 시 자동 프로비저닝 범위를 정한다

문제 정의:

```text
현재: 프로젝트 생성 → project row만 생성 → 사용자가 채널/토픽/스레드/brain link를 따로 만들어야 함
목표: 프로젝트 생성 → 컨설팅 기본 구조 + shared brain slug/link + 기본 대화 thread가 자동 생성됨
```

확정 기본값:

```text
template = consulting_default
자동 생성 채널 = 자료수집 / 분석 / 보고서 / 질의응답 / 대화
자동 생성 토픽 = 공공시설 기초자료, 회의·요청사항, 시설 적정성 진단, 이관·통합 검토, 중간보고서, 최종보고서, 실무자 질문, 기본 대화
shared brain slug = project slug 기반 자동 생성; 고급설정에서 수정 가능
```

TEST에 적용해야 할 것:

- TEST는 별도 프로젝트로 유지한다.
- TEST에도 창원시 컨설팅처럼 기본 채널/토픽/thread를 소급 생성한다.
- TEST용 brain slug는 project slug 기반 자동값(`test`)을 기본으로 하되, 충돌/가독성 문제가 있으면 `test-consulting`으로 고급설정에서 수정 가능하게 한다.
- 창원 brain `changwon-org-mgmt-diagnosis`와 TEST brain을 섞으면 안 된다. 필요하면 cross-project reference는 라벨을 붙여 참조만 허용한다.

결정 결과:

- 프로젝트 생성 순간에 자동으로 컨설팅 템플릿을 적용한다.
- shared brain slug는 자동 생성한다.
- 고급 설정에서 brain slug 수정 기능을 제공한다.
- 기존 TEST에는 retroactive backfill을 수행한다. 단, 운영 mutation이므로 dry-run → 승인 → commit 순서를 지킨다.

### Decision B — visual embedding provider는 2단계

1차: Voyage multimodal provider

- 장점: API 기반, GPU/torch 이미지 의존성 없음, 빠른 운영 반영 가능.
- 대상: PDF page image + OCR/text snippet interleaved input.
- 저장: single-vector `embedding_float[]` 또는 base64-encoded vector; provider metadata 저장.
- 창원자료 외부 전송은 허용된다.
- 실제 사용에는 `VOYAGE_API_KEY`가 필요하다.
- 2026-07-07 확인: `/home/jigoo/.hermes/.env`에 `VOYAGE_API_KEY` 존재. 값은 출력/기록하지 않았다.
- 키는 서버/worker env에만 둔다. 브라우저/API 응답/로그/DB metadata에 원문 key를 남기지 않는다.
- `VOYAGE_API_KEY`가 없으면 Voyage provider는 disabled로 보고 `local_visual_hash_v1` fallback을 사용한다.

2차: ColQwen2/ColPali provider

- 장점: page layout/table/chart에 강한 multi-vector late interaction.
- 단점: GPU/torch/transformers/quantization/runtime 부담, multi-vector index 필요.
- 처리: 바로 main path에 넣지 말고 `provider='colqwen2_local'` experimental worker로 둔다.

### Decision C — verifier는 cascade

```text
claim + evidence
→ deterministic prefilter
→ NLI cross-encoder if text evidence is enough
→ LLM strict JSON judge for all claims when latency budget allows
→ persisted verdict + UI badge
```

- deterministic: 싸고 빠른 guard, 현재 fixture 유지.
- NLI: support/refute/neutral score를 claim/evidence pair에 부여.
- LLM strict JSON: 기본적으로 전체 claim 최종판정 담당. latency budget 초과, API 장애, quota/rate-limit 상황에서만 고위험 claim 우선 모드로 축소한다.
- 최종 verdict는 기존 API/UI contract 유지: `supports | refutes | not_enough_info`.

### Decision D — 검증 실패 후 재실행/재작성 루프

기본 원칙:

- 일반 채팅 모드에서는 답변을 먼저 보여주고, verifier 결과를 inline badge/우측 패널/rewrite button으로 붙인다.
- 일반 채팅 모드에서 verifier가 refute/unsupported를 찾았다고 자동으로 전체 질문을 다시 실행하지는 않는다. 무한 루프·응답 지연·사용자 의도 왜곡 위험이 크다.
- 대신 현재 구현처럼 사용자가 `근거 보강 후 재작성`, `해당 문장 제거`, `추가 자료 요청`을 눌러 명시적으로 repair를 실행한다.

자동 repair가 필요한 모드:

- 보고서/추천/의사결정 답변처럼 “최종 산출물” 성격인 경우.
- 답변 공개 전에 품질 gate를 거쳐야 하는 경우.
- 이 경우 workflow는 `draft → verify → targeted repair → re-verify → publish`로 간다.
- repair는 전체 재실행보다 **문제 claim 중심 targeted rewrite**가 기본이다.
- max repair round는 1회, 강한 운영 모드에서도 2회를 넘기지 않는다.
- re-verify 후에도 unsupported/refuted가 남으면 해당 문장을 제거하거나 “자료 부족”으로 명시하고, 최종 결과에 warning을 붙인다.

LangGraph 도입 기준:

- `draft → verify` 한 번이면 기존 Nest service와 DB transaction/outbox로 충분하다.
- `draft → verify → repair → verify` 조건부 루프가 실제로 필요해지고, 중간 상태를 저장/재개하거나 human interrupt가 필요할 때 LangGraph spike를 시작한다.
- LangGraph를 쓰더라도 write side effect는 idempotent하게 만들어야 한다. interrupt 전후 side effect 중복 실행을 막기 위해 state에는 draft/verdict/repair plan만 저장하고, publish DB write는 마지막 node에서 한 번만 수행한다.

### Decision E — 채널별 역할/목적 프로필을 prompt context로 주입

문제 정의:

```text
현재: 채널은 이름/slug만 있고, “이 채널은 무엇을 하는 곳인가”가 모델 context에 고정 주입되지 않음
목표: 사용자가 직접 적거나 대화에서 자동 제안된 채널 목적/역할/작업방식을 저장하고, 해당 채널의 모든 답변에서 계속 참조
```

권장 설계:

- `channels` 테이블을 바로 비대하게 만들지 말고 별도 `channel_profiles` 또는 `scope_profiles` 테이블을 둔다.
- profile은 사용자 직접 입력을 canonical로 보고, 자동 요약은 `suggestion`으로 만든 뒤 사용자가 승인/수정하면 canonical에 반영한다.
- 채널 profile은 그 채널에서 가장 강한 app-level context다.
- 다른 채널/프로젝트 참조는 계속 허용하되 `다른 채널 참고`로 라벨링하고 weight를 낮춘다.
- channel profile은 안전/system 정책을 override하지 못한다. 즉 “프롬프트”가 아니라 **채널 운영지침 데이터**로 주입한다.

Profile fields v1:

```text
purpose: 이 채널의 목적
role: 모델이 이 채널에서 맡을 역할
audience: 주 독자/사용자
output_style: 답변 형식/톤/표/요약 수준
default_sources: 우선 참조할 자료/brain scope
avoid: 이 채널에서 피해야 할 것
decision_rules: 판단/추천 시 기준
auto_summary: 최근 대화에서 추출한 목적 후보
source: manual | auto_suggested | merged
confidence: 0..1
version
```

Prompt injection order:

```text
1. global consulting response format
2. workspace/project policy
3. current channel profile ← 항상 주입
4. current topic/thread context
5. same-project evidence/GraphRAG
6. other-channel/project references ← 라벨 + 감쇠
7. user message
```

자동 생성/갱신 규칙:

- 사용자가 “이 채널은 …”, “여기서는 …”, “이 채널 목적은 …”처럼 말하면 profile suggestion 생성.
- 일정 대화량 이후 background summarizer가 channel purpose 후보를 생성.
- 자동 suggestion은 바로 canonical profile을 덮어쓰지 않는다.
- UI에서 “채널 역할 제안”으로 보여주고 사용자가 승인/수정한다.
- 단, 빈 채널은 `consulting_default` 템플릿의 기본 profile을 canonical 초기값으로 넣는다.

Telegram/internal channel profile:

- Telegram은 web UI처럼 profile editor를 노출하지 않는 경우가 많으므로 내부 자동 profile을 허용한다.
- 입력 신호:
  - Telegram channel/topic name (`텔레그램`, `default-chat`, Telegram topic title)
  - web `memory_topic_id` (`consulting:changwon-org-mgmt-diagnosis#telegram/default-chat`)
  - shared brain topic title (`창원시설공단 조직 및 경영 진단 연구용역`)
  - 최근 Telegram dialogue chunks
  - file/dialogue keyword distribution
- 예: 창원 Telegram 대화에서 `보수체계`, `근속승진`, `승진`, `공무직` 키워드가 다수 확인되면 내부 profile에 “창원시설공단 공무직 보수체계/근속승진/승진체계 질의응답 맥락”을 넣는다.
- Telegram profile은 사용자에게 직접 보이지 않아도 Hermes prompt 내부에는 `Current Telegram topic profile`로 주입한다.
- 단, 추론된 profile은 `source='auto_suggested'`, `confidence`, `evidence_keywords`, `sample_message_ids/chunk_ids`를 남겨야 한다.
- web의 창원 구조화 채널 profile과 Telegram profile은 같은 brain slug로 연결되지만, profile 목적은 각각 분리한다.

### Decision F — Telegram forum topic registry/bridge를 별도 계층으로 만든다

문제 정의:

```text
현재: Telegram thread들은 모두 같은 창원 brain에는 들어오지만, thread별 목적·web topic·channel_prompt가 분리되지 않음
목표: Telegram topic 하나가 consulting-web topic/profile/ingest scope 하나에 대응되게 만든다
```

확정 매핑 v1:

| Telegram thread_id | Telegram topic name | web channel/topic | memory topic id | profile purpose |
|---:|---|---|---|---|
| `12` | 창원-컨설팅 | 텔레그램 / 창원-컨설팅 | `consulting:changwon-org-mgmt-diagnosis#telegram/changwon-consulting` | 창원 컨설팅 일반/초기 질의 |
| `524` | 창원_보수체계 | 텔레그램 / 창원_보수체계 | `consulting:changwon-org-mgmt-diagnosis#telegram/changwon-pay-system` | 보수수준·직급·호봉·보수체계 비교 |
| `533` | 창원_근속승진 | 텔레그램 / 창원_근속승진 | `consulting:changwon-org-mgmt-diagnosis#telegram/changwon-tenure-promotion` | 근속승진·직급체계·승진효과 검토 |
| `356` | 창원_대행사업 | 텔레그램 / 창원_대행사업 | `consulting:changwon-org-mgmt-diagnosis#telegram/changwon-agency-business` | 대행사업·위탁·이관·레포츠파크 검토 |
| `1` | General/검토필요 | 텔레그램 / 일반 | `consulting:changwon-org-mgmt-diagnosis#telegram/general` | 과업지시서/기타 창원 질의. 자동 확정 금지 |

설계 원칙:

- brain slug는 하나(`changwon-org-mgmt-diagnosis`)로 유지한다. 같은 창원 프로젝트 지식자산이기 때문이다.
- 하지만 Telegram thread별 web topic/profile/recall scope는 분리한다.
- 기존 `dialogue_topic_telegram`의 `thread_id=NULL` 전역 바인딩은 legacy fallback으로만 둔다.
- 신규 multi-topic 운영은 `chat_id + thread_id` 정확 매칭으로만 바인딩한다.
- `dialogue_topic_telegram`의 현재 PK `(topic_id, telegram_user_id)`는 여러 thread row를 표현하기 어렵다. 새 테이블을 추가하거나 PK를 `(topic_id, telegram_user_id, chat_id, thread_id)` 계열로 바꿔야 한다.
- web mirror는 더 이상 모든 Telegram 메시지를 `default-chat` 하나로 합치지 않고, thread_id에 맞는 web topic/thread로 import한다.
- Hermes `telegram.channel_prompts`도 thread별로 생성한다. 단, config 수동 편집은 위험하므로 registry에서 prompt를 생성하고 gateway config는 최소 참조만 하거나, 안전한 텍스트 치환/검증 절차를 둔다.

Target architecture:

```text
Telegram group -1004453868195
  ├─ thread 12  창원-컨설팅   ─┐
  ├─ thread 524 창원_보수체계  ├─ consulting brain: changwon-org-mgmt-diagnosis
  ├─ thread 533 창원_근속승진  ┤
  ├─ thread 356 창원_대행사업  ┘
  └─ thread 1   General/검토필요

각 thread
  → web topic
  → channel profile
  → thread-specific ingest binding
  → same brain slug, different sub-scope
```

### Decision G — 계산/정확성 요청은 Exactness Gate로 라우팅한다

문제 정의:

```text
현재 위험: 사용자가 계산·정확한 검토를 요구해도 LLM이 머릿속 추론/그럴듯한 산식으로 답할 수 있음
목표: 계산·정량·날짜·법령·파일·URL·DB row처럼 정확성이 중요한 답변은 도구 실행과 반복 검산을 통과해야 최종 답변 가능
```

Trigger examples:

- 계산: `계산해줘`, `산정`, `비율`, `증감률`, `총액`, `평균`, `중위값`, `가중치`, `지연계수`, `인건비 영향`, `승진 TO 영향`.
- 표/데이터: Excel/PDF table에서 합계·비교·정렬·그룹별 집계.
- 날짜/기간: 근속연수, 기준일, 기간 차이, 유효기간, 최신 기준연도.
- 법령/조항/출처: 조례 제N조, 공문 번호, 보고서 페이지, URL 존재, 파일 존재, 원문 locator.
- DB/시스템 사실: row count, thread_id, topic link, migration 상태, ingestion count.
- 고위험 산출물: 보고서 본문, 의사결정 권고, 비용/정원/보수체계 결론.

Core rule:

```text
LLM mental math 금지.
정확성 claim은 tool-backed result 없이는 final로 말하지 않는다.
```

Exactness workflow:

```text
user request
  → exactness intent classifier
  → extract required inputs and cite evidence refs
  → choose checker
      ├─ Python/Decimal runner for arithmetic/statistics
      ├─ SQL read-only query for DB counts/state
      ├─ document/page/table locator check for source claims
      ├─ web/direct fetch for current external facts
      └─ date/time calculator for period logic
  → run primary check
  → run independent recompute or invariant check
  → if mismatch: repair inputs/formula once, rerun
  → if still mismatch: answer with “검산 불일치/자료 부족” not a fake final number
  → persist exactness run ledger
  → final answer includes compact calculation basis and caveats
```

Repeated verification policy:

- 기본 2-pass: primary calculation + independent recompute/invariant.
- 금액/정원/보수/승진효과 등 의사결정 수치는 최소 2-pass 필수.
- 단순 산술도 Python/Decimal로 1-pass 이상 실행한다.
- 불일치가 나면 자동으로 1회만 입력/산식 재점검 후 재실행한다.
- 2회 후에도 불일치하면 최종 수치 단정 금지. Review Queue로 보낸다.

Invariant catalog v1:

| 작업 | 검산 불변식 |
|---|---|
| 합계/부분합 | `sum(parts) == total ± tolerance` |
| 비율/퍼센트 | 분모 0 금지, 단위 `%`/소수 구분, 0~100 범위 또는 사유 기록 |
| 증감률 | `(new-old)/old`; old=0이면 별도 처리 |
| 평균/가중평균 | weight 합 >0, group별 row 중복 없음 |
| 기간/근속연수 | 기준일 명시, inclusive/exclusive rule 기록 |
| 금액/인건비 | 원/천원/백만원 단위 변환 기록, 반올림 규칙 기록 |
| 순위/비교 | 정렬 기준과 tie-breaker 기록 |
| 법령/조항 | 원문 locator/page/조항 번호 확인 전 단정 금지 |
| DB row count | read-only SQL 결과와 query hash 저장 |

Output behavior:

- 비개발자 Telegram 답변에서는 내부 코드/경로를 숨기고 `계산 기준`, `검산 결과`, `주의점`만 짧게 보여준다.
- consulting-web에서는 우측 패널/근거검증 탭에 `Exactness run`을 표시할 수 있다.
- 보고서/의사결정 모드에서는 exactness 실패 claim은 verifier에서 `not_enough_info` 또는 `review_required`로 취급한다.

LangGraph relation:

- 단순 계산 1~2회 검산에는 LangGraph를 쓰지 않는다.
- 여러 단계 산출물에서 `compute → verify → repair inputs/formula → recompute → publish/interrupt`가 필요해지면 report/decision LangGraph spike의 한 node로 붙인다.

---
## 3. 구현 계획

### Phase 0 — 새 프로젝트 자동 프로비저닝 + TEST backfill

**Objective:** 사용자가 `TEST` 같은 새 프로젝트를 만들 때 창원시 컨설팅처럼 기본 컨설팅 구조와 shared brain link가 자동 생성되게 한다.

**Files likely to change:**

- `apps/api/src/spaces/*`
- `apps/api/src/spaces/create-project.usecase.ts`
- `apps/api/src/spaces/project-template.service.ts` 신규
- `apps/api/src/consulting/consulting-topic-resolver.service.ts`
- `packages/db-schema/src/schema/consulting-bridge.ts`
- migration under `packages/db-schema/drizzle/00xx_*`
- tests under `apps/api/test/*`

**Tasks:**

1. Read-only project provisioning report 추가
   - 모든 active project의 channels/topics/threads/messages/consulting_links를 출력.
   - `TEST`처럼 consulting_links=0인 프로젝트를 `unprovisioned`로 표시.
   - 창원 brain slug와 TEST brain slug가 섞이지 않았는지 확인.

2. `ProjectTemplateService` 추가
   - `consulting_default` 템플릿 정의: 자료수집/분석/보고서/질의응답/대화 채널과 기본 토픽/thread.
   - slug 생성 규칙: project slug 기반 `consulting:<projectSlug>#...` memory topic id.
   - idempotent upsert: 이미 존재하는 channel/topic/thread는 재생성하지 않음.

3. `CreateProjectUseCase` 통합
   - 프로젝트 생성 요청에 template 옵션을 받거나, consulting workspace에서는 기본값으로 `consulting_default` 적용.
   - project row 생성 후 같은 transaction에서 기본 channel/topic/thread와 `consulting_topic_links` 생성.
   - 실패 시 project만 반쯤 생기지 않도록 transaction 전체 rollback.

4. TEST backfill dry-run/commit 추가
   - 기존 `TEST` 프로젝트(`61f95d26-33e7-47ea-a374-7b19da02c39a`)에 누락된 기본 채널/토픽/thread/link를 preview로 산출.
   - commit은 별도 승인 후 실행.
   - 기존 TEST messages 10건은 보존하고, 창원 brain과 섞지 않음.

5. Regression tests
   - 새 프로젝트 생성 → 기본 channels/topics/threads/link가 생김.
   - 템플릿 재실행 → 중복 row 0개.
   - TEST backfill preview → DB mutation 0개.
   - TEST backfill commit → 기존 messages 보존, consulting_links > 0.

**Validation:**

```bash
pnpm --filter @consulting/api exec vitest run test/project-template-provisioning.test.ts --reporter=dot
pnpm --filter @consulting/api typecheck
```

**Operational proof:**

- Before/after SQL:
  - TEST channels/topics/threads/messages count
  - TEST consulting_topic_links count/status
  - TEST memory_topic_id prefix
  - 창원 `changwon-org-mgmt-diagnosis` brain counts unchanged

---

### Phase 0.5 — channel profile / channel role prompt layer

**Objective:** 채널별 목적·역할·작업방식을 저장하고, 해당 채널의 모든 Hermes run에 안정적으로 주입한다.

**Files likely to change:**

- `packages/db-schema/src/schema/space.ts` or new `scope-profile.ts`
- migration under `packages/db-schema/drizzle/00xx_channel_profiles.sql`
- `packages/contracts/src/spaces.ts`
- `apps/api/src/spaces/channel-profile.service.ts` 신규
- `apps/api/src/spaces/spaces.controller.ts`
- `apps/api/src/consulting/consulting-memory-context.builder.ts`
- `apps/api/src/chat/hermes-runs-client.ts`
- `apps/api/scripts/infer_channel_profiles.py` or TS worker 신규
- `apps/web/src/widgets/*` channel settings/profile editor
- tests under `apps/api/test/channel-profile*.test.ts`

**Schema proposal:**

```sql
CREATE TABLE channel_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  audience text NOT NULL DEFAULT '',
  output_style text NOT NULL DEFAULT '',
  default_sources jsonb NOT NULL DEFAULT '[]',
  avoid text NOT NULL DEFAULT '',
  decision_rules text NOT NULL DEFAULT '',
  auto_summary text,
  source text NOT NULL DEFAULT 'manual',
  evidence_keywords jsonb NOT NULL DEFAULT '[]',
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  confidence numeric,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_profiles_channel_unique ON channel_profiles(channel_id);
```

**Tasks:**

1. Add schema + migration + contracts.
2. Add `ChannelProfileService.getEffectiveProfile(channelId)`.
3. Seed default profiles from `consulting_default` template.
4. Add edit/read API for manual profile.
5. Add auto-suggestion path:
   - detect explicit user statements about channel purpose;
   - or run summarizer after threshold N messages;
   - write suggestion, not canonical overwrite.
6. Add Telegram/internal profile inference:
   - resolve `memory_topic_id` → shared brain topic slug;
   - collect topic title + channel/topic names + recent dialogue/file chunks;
   - extract top keywords/entities such as `보수체계`, `근속승진`, `승진`, `공무직`;
   - write internal `auto_suggested` profile with evidence refs.
7. Inject effective profile into Hermes instructions before GraphRAG memory context.
8. Add web UI in channel settings: purpose/role/style/rules + suggestion approve/edit/reject.

**Validation:**

- new channel from template has default profile.
- manual profile edit appears in next Hermes run instructions.
- auto suggestion does not overwrite manual canonical without approval.
- Telegram/internal profile can be generated without UI exposure and is injected into Telegram-backed thread runs.
- 창원 Telegram profile includes inferred 보수체계/근속승진 context when keyword evidence is present.
- cross-channel GraphRAG context remains labeled as “다른 채널 참고” and lower priority than current channel profile.
- malicious profile text cannot override system/safety policy; it is wrapped as data/instructions for the channel only.

---

### Phase 0.6 — Telegram forum topic registry + per-thread bridge/backfill

**Objective:** 사용자가 추가한 Telegram forum topic들을 창원 shared brain에는 유지하되, web topic/profile/ingest scope는 thread별로 분리한다.

**Files likely to change:**

- `packages/db-schema/src/schema/telegram-bridge.ts` 신규 또는 `consulting-bridge.ts` 확장
- migration under `packages/db-schema/drizzle/00xx_telegram_topic_links.sql`
- `apps/api/src/consulting/telegram-topic-registry.service.ts` 신규
- `apps/api/src/consulting/consulting-memory-context.builder.ts`
- `apps/api/src/chat/hermes-runs-client.ts`
- `apps/api/scripts/sync_telegram_topics_to_web.ts` 신규
- shared brain: `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/store.py`
- shared brain: `/home/jigoo/.hermes/workspace/consulting/scripts/dialogue_memory/ingest.py`

**Schema proposal in consulting-web Postgres:**

```sql
CREATE TABLE telegram_topic_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  web_topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  telegram_chat_id text NOT NULL,
  telegram_thread_id text NOT NULL,
  telegram_topic_name text NOT NULL,
  consulting_topic_slug text NOT NULL,
  memory_topic_id text NOT NULL,
  profile_source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX telegram_topic_links_unique
  ON telegram_topic_links(telegram_chat_id, telegram_thread_id);
```

**Shared brain binding change:**

기존:

```text
dialogue_topic_telegram(topic_id, telegram_user_id) PRIMARY KEY
thread_id = NULL  # all sessions of that user
```

권장:

```text
dialogue_telegram_thread_bindings(
  topic_id,
  telegram_user_id,
  chat_id,
  thread_id,
  web_memory_topic_id,
  purpose,
  status,
  bound_at,
  PRIMARY KEY(topic_id, telegram_user_id, chat_id, thread_id)
)
```

Tasks:

1. Read-only Telegram topic audit script:
   - config `channel_prompts` keys;
   - `state.db.sessions` grouped by `chat_id/thread_id/user_id`;
   - `consulting.db.dialogue_topic_telegram` and chunk counts by thread;
   - `consulting-web` Telegram topics/messages.
2. Backfill web topics under `창원시 컨설팅 / 텔레그램`:
   - `창원-컨설팅` for thread `12`;
   - `창원_보수체계` for thread `524`;
   - `창원_근속승진` for thread `533`;
   - `창원_대행사업` for thread `356`;
   - `일반/검토필요` for thread `1` unless manually reassigned.
3. Backfill `telegram_topic_links` rows with `memory_topic_id` values from Decision F.
4. Create channel/topic profiles for each Telegram topic using keyword evidence.
5. Replace or supersede the legacy `thread_id=NULL` mapping:
   - keep it only for old `NULL` sessions;
   - new auto-bind uses exact `chat_id + thread_id`;
   - no content-LIKE fallback.
6. Update ingest/recall context assembly:
   - current Telegram thread first;
   - same 창원 brain fallback second;
   - other Telegram topics labeled `같은 창원 프로젝트의 다른 텔레그램 토픽 참고` with dampening.
7. Generate or load thread-specific prompt/profile:
   - thread `524` answers as 보수체계 analyst;
   - thread `533` answers as 근속승진 analyst;
   - thread `356` answers as 대행사업/위탁/이관 analyst;
   - keep Telegram no-markdown output rule for every thread.
8. Dry-run before any mutation:
   - show exact rows to create/update;
   - prove existing 249 web messages and 112 telegram chunks are preserved.

Validation:

- `channel_prompts` or generated prompt registry covers thread `12/524/533/356`.
- `telegram_topic_links` has one active row per mapped thread.
- `dialogue_telegram_thread_bindings` has exact thread rows; no new topic relies on `thread_id=NULL`.
- A query in `창원_보수체계` gets 보수/직급/호봉 profile first.
- A query in `창원_근속승진` gets 근속승진 profile first.
- A query in `창원_대행사업` gets 대행사업/위탁/이관 profile first.
- Cross-topic recall still works but is visibly labeled/dampened.
- Thread `1` remains `검토필요` until manually classified.

---

### Phase 0.7 — Exactness Gate + calculation/source verification runner

**Objective:** 계산·정량·날짜·법령·출처·DB 상태처럼 “정확한 답”이 필요한 요청을 LLM 추정이 아니라 도구 실행/반복 검산으로 처리한다.

**Status 2026-07-08:** ✅ implemented as a minimum safe vertical slice.

- Deterministic `ExactnessGateService` added under `apps/api/src/consulting/`.
- Percentage/sum/ratio checks use string-backed Decimal arithmetic, not LLM mental math.
- Exactness-triggered requests with no tool-backed checks return `blocked`/`자료 부족`.
- Post-answer path now passes the user prompt into the verifier and attempts to persist an `exactness_runs` ledger.
- `exactness_runs` Drizzle schema + `0018_exactness_runs.sql` migration file added, but **live DB apply remains approval-gated**.
- Until the migration is applied, missing `exactness_runs` relation is safely ignored so existing chat/summary paths do not crash.
- Evidence right panel response now includes `exactness.latestRun/blockedCount`; web panel shows latest exactness status.
- Verified: contracts/db-schema/api/web typecheck, lint, focused tests, and package builds passed.

**Files likely to change:**

- `packages/db-schema/src/schema/exactness.ts` 신규
- migration under `packages/db-schema/drizzle/00xx_exactness_runs.sql`
- `packages/contracts/src/exactness.ts` 신규
- `apps/api/src/exactness/exactness-intent.service.ts` 신규
- `apps/api/src/exactness/exactness-runner.service.ts` 신규
- `apps/api/src/exactness/calculation-runner.service.ts` 신규
- `apps/api/scripts/exactness_runner.py` 신규
- `apps/api/src/consulting/evidence-to-decision.service.ts`
- `apps/api/src/chat/chat-stream.usecase.ts`
- `apps/api/src/chat/hermes-runs-client.ts`
- `apps/web/src/widgets/evidence/ExactnessRunPanel.tsx` optional

**Schema proposal:**

```sql
CREATE TABLE exactness_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  topic_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  message_id uuid,
  run_type text NOT NULL, -- calculation | sql_check | source_locator | date_time | web_fact
  trigger_text text NOT NULL DEFAULT '',
  input_refs jsonb NOT NULL DEFAULT '[]',
  normalized_inputs jsonb NOT NULL DEFAULT '{}',
  formula_or_query text NOT NULL DEFAULT '',
  code_hash text,
  result_json jsonb NOT NULL DEFAULT '{}',
  primary_result text,
  recompute_result text,
  invariant_results jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL, -- passed | warning | failed | review_required | skipped
  failure_reason text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exactness_runs_scope_idx ON exactness_runs(workspace_id, project_id, channel_id, topic_id, thread_id);
```

**Intent classifier v1:**

- deterministic regex/keyword first:
  - calculation terms: `계산`, `산정`, `비율`, `증감률`, `총액`, `평균`, `가중`, `비교`, `몇 %`, `얼마`;
  - exactness terms: `정확히`, `맞는지`, `검증`, `원문`, `조항`, `페이지`, `파일`, `URL`, `row`, `count`;
  - domain terms: `보수`, `호봉`, `직급`, `근속`, `승진`, `정원`, `인건비`, `대행사업`.
- LLM classifier는 fallback only; deterministic high-confidence trigger가 있으면 바로 gate.
- 사용자가 “대략”이라고 해도 금액/정원/법령/보고서 산출물은 gate 적용.

**Runner behavior:**

1. Extract inputs with evidence refs:
   - user-provided table/message;
   - retrieved document chunks;
   - uploaded Excel/PDF table extraction;
   - read-only DB query result;
   - official web/source locator.
2. Normalize units:
   - 원/천원/백만원;
   - `%` vs decimal;
   - 기준일/기간 rule;
   - row grouping keys.
3. Execute Python sandbox:
   - use stdlib `decimal.Decimal` for money/percent by default;
   - use `fractions`/`statistics` where useful;
   - use pandas/openpyxl only when already available or explicitly added for table workloads.
4. Recompute independently:
   - formula-based result vs row aggregation;
   - Python result vs SQL aggregation where data is in DB;
   - total vs sum(parts);
   - locator value vs extracted table value.
5. Record exactness run ledger.
6. Return compact verified result to answer generator.

**Guardrails:**

- No network or file writes from the Python runner unless explicitly needed and sandboxed.
- No secrets in stdout/result_json.
- Read-only SQL only; mutation queries rejected.
- Timeout per exactness run, suggested 10~30s.
- If input evidence is missing, ask for the missing file/data or mark `review_required`; do not invent.

**Integration points:**

- Chat pre-answer:
  - if exactness trigger → run Exactness Gate before final answer.
- Post-answer verifier:
  - any numeric/date/legal/source claim without exactness ledger is downgraded to `not_enough_info` or queued for review.
- Rewrite loop:
  - if unsupported claim is numeric/source-exact → run exactness repair, not pure LLM rewrite.
- Telegram:
  - hide code/path; show only `계산 기준`, `검산 결과`, `주의점`.
- Web:
  - expose ledger in Evidence/Exactness panel.

**Validation:**

- A simple percentage question does not answer until Python result exists.
- A money/unit example catches 원/천원 mismatch.
- A sum table example catches `sum(parts) != total`.
- A duplicated-row aggregation test catches double counting.
- A law/source locator question requires original locator before final claim.
- A DB count question executes read-only SQL and stores query hash/result.
- If recompute mismatch persists, final answer says `검산 불일치` and creates review queue item.
- Telegram answer hides code/internal path but includes verified basis.

---

### Phase 1 — multimodal embedding schema/provider abstraction

**Objective:** `local_visual_hash_v1`를 provider fallback으로 낮추고, real multimodal embeddings를 저장/검색할 수 있게 한다.

**Files likely to change:**

- `packages/db-schema/src/schema/evidence-decision.ts`
- `packages/db-schema/drizzle/00xx_multimodal_document_embeddings.sql`
- `apps/api/src/chat/document-extraction.worker.ts`
- `apps/api/src/consulting/document-embedding.provider.ts` 신규
- `apps/api/src/consulting/voyage-multimodal.provider.ts` 신규
- `apps/api/src/consulting/local-visual-hash.provider.ts` 신규
- `apps/api/test/document-visual-embedding.test.ts`

**Schema proposal:**

Add table rather than overloading `metadata` only:

```sql
CREATE TABLE document_unit_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_unit_id uuid NOT NULL REFERENCES document_retrieval_units(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  modality text NOT NULL,
  embedding_dim integer NOT NULL,
  embedding jsonb NOT NULL,
  input_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_unit_embeddings_unique
ON document_unit_embeddings(document_unit_id, provider, model, input_sha256);
```

Reason:

- Postgres pgvector may be a later optimization, but JSON/vector-as-array is easiest for first correctness pass.
- ColPali/ColQwen multi-vector needs `jsonb`/external index anyway.
- Later add pgvector column for Voyage single-vector.

**Provider interface:**

```ts
export interface MultimodalEmbeddingInput {
  unitId: string;
  modality: 'page_visual' | 'table' | 'text';
  text?: string;
  imageBase64?: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  locator: string;
}

export interface MultimodalEmbeddingResult {
  provider: 'voyage' | 'colqwen2_local' | 'local_visual_hash';
  model: string;
  embeddingDim: number;
  vectors: number[] | number[][];
  inputSha256: string;
  metadata: Record<string, unknown>;
}
```

**Voyage input:**

```json
{
  "model": "voyage-multimodal-3.5",
  "input_type": "document",
  "inputs": [
    {
      "content": [
        { "type": "text", "text": "PDF filename + page label + OCR snippet" },
        { "type": "image_base64", "image_base64": "data:image/png;base64,..." }
      ]
    }
  ]
}
```

**Fallback rules:**

- No `VOYAGE_API_KEY` → do not fail extraction; write `local_visual_hash_v1` and `embedding_status='fallback'`.
- `VOYAGE_API_KEY` present + `VOYAGE_MULTIMODAL_ENABLED=true` → use Voyage for allowed workspaces/projects, including Changwon.
- Store only `provider`, `model`, `embedding_dim`, `input_sha256`, token/request metadata. Never store the raw API key or full outbound payload in DB/logs.
- Voyage 429/5xx → retry bounded, then fallback.
- Missing page image → text/table units still indexed.

**Validation:**

- provider fake test: deterministic vector persisted.
- no-key test: local visual hash fallback persists with warning.
- idempotency test: same file/page rerun does not duplicate embedding row.
- API search test: query can hit `page_visual` unit by semantic provider score.

---

### Phase 2 — multimodal search/ranking

**Objective:** `searchFiles`와 GraphRAG context에서 page visual semantic score를 실제 ranking signal로 사용한다.

**Files likely to change:**

- `apps/api/src/chat/chat-message.store.ts`
- `apps/api/src/consulting/consulting-memory-context.builder.ts`
- `apps/api/src/consulting/visual-document-search.service.ts` 신규
- `packages/contracts/src/spaces.ts`
- `apps/web/src/widgets/*` if showing visual match badges

**Ranking formula v1:**

```text
final_score = text_rrf * 0.45
            + visual_embedding_similarity * 0.35
            + quality_score * 0.10
            + scope_weight/diffusion * 0.10
```

**UI additions:**

- Search result badge: `page visual · Voyage` or `page visual · fallback`.
- Locator display: `page:3`.
- If thumbnail/file preview exists, open exact page preview.

**Validation:**

- PDF with table image and weak OCR: text-only misses, visual provider hit appears.
- If provider unavailable, search still returns existing text/file hits.
- Browser QA through 8088: upload sample PDF → ask table/chart question → page visual result visible.

---

### Phase 3 — NLI verifier provider

**Objective:** deterministic verifier를 real NLI provider로 보강한다.

**Files likely to change:**

- `apps/api/src/consulting/evidence-to-decision.service.ts`
- `apps/api/src/consulting/verifier/nli-verifier.provider.ts` 신규
- `apps/api/scripts/verify_claims_nli.py` 신규
- `apps/api/test/evidence-to-decision-nli.test.ts`
- Dockerfile if adding Python deps, subject to approval

**Provider interface:**

```ts
export interface ClaimEvidencePair {
  claimId: string;
  claimText: string;
  evidenceId: string;
  evidenceText: string;
  languageHint?: 'ko' | 'en' | 'mixed';
}

export interface ClaimVerifierResult {
  verifier: string;
  verdict: 'supports' | 'refutes' | 'not_enough_info';
  confidence: number;
  scores: {
    entailment?: number;
    contradiction?: number;
    neutral?: number;
  };
  rationale: string;
}
```

**Mapping:**

```text
entailment >= 0.70 and contradiction < 0.30 → supports
contradiction >= 0.65 → refutes
otherwise → not_enough_info
```

**Korean caution:**

- English NLI models may underperform on Korean admin prose.
- First pass can translate claim/evidence to English using LLM only in eval mode, but production should avoid hidden translation unless explicitly logged.
- Better production cascade: NLI only for high lexical overlap/simple factual claims; complex Korean claims escalate to LLM strict JSON.

**Validation metrics:**

Keep existing metrics and add provider dimension:

- `evidence_supported_rate >= 0.95`
- `refute_detection_rate >= 0.90`
- `unsupported_deferral_rate >= 0.95`
- Korean fixture set: 창원 공무직 승진체계/대행사업/레포츠파크 claims.

---

### Phase 4 — LLM strict JSON verifier provider + timing metrics

**Objective:** 모든 claim을 LLM judge로 검증하되, claim별/answer별 시간을 계측하고 latency budget 초과 시 안전하게 fallback한다.

**Files likely to change:**

- `apps/api/src/consulting/verifier/llm-strict-json-verifier.provider.ts` 신규
- `apps/api/src/consulting/verifier/claim-verification-orchestrator.service.ts` 신규 또는 기존 service 확장
- `apps/api/src/hermes/*` or existing Hermes client path
- `packages/db-schema/src/schema/evidence-decision.ts`
- migration under `packages/db-schema/drizzle/00xx_claim_verification_metrics.sql`
- `apps/api/test/evidence-to-decision-llm-verifier.test.ts`

**Prompt contract:**

```json
{
  "claim_id": "string",
  "verdict": "supports | refutes | not_enough_info",
  "confidence": 0.0,
  "evidence_refs": ["hit-1"],
  "reason": "짧은 한국어 근거",
  "missing_evidence": ["필요한 자료"],
  "must_not_assert": true
}
```

**Hard rules:**

- The LLM may only use provided evidence snippets/page metadata.
- If evidence is insufficient, it must return `not_enough_info`.
- It must cite evidence ids; uncited support is downgraded.
- JSON schema parse failure → no retry more than 1; fallback to NLI/deterministic and mark `verifier_error`.

**Execution policy:**

Default:

- 모든 extracted claim에 LLM strict JSON verifier를 적용한다.
- deterministic/NLI 결과는 LLM 입력 feature이자 fallback으로 사용한다.
- LLM이 빠르게 끝나면 LLM verdict를 최종 verdict로 저장한다.
- claim별 start/end/duration, answer-level total duration을 저장한다.
- LLM judge 호출은 가능하면 claim batch 단위로 묶어 latency를 줄인다. 단 JSON schema failure가 batch 전체를 망치면 claim 단위 fallback으로 재시도한다.

Latency/rate-limit fallback:

- per-answer verifier budget 예: 6~10초.
- claim 수가 많거나 LLM 응답이 느리면 아래 risky 조건에 해당하는 claim만 LLM에 보낸다.
- 나머지는 NLI/deterministic 결과를 저장하되 `verifier='nli_or_deterministic_fallback'`처럼 출처를 명확히 남긴다.
- `fallback_reason`은 `timeout | rate_limited | provider_error | schema_error | budget_exceeded` 중 하나로 저장한다.

Timing fields:

```text
answer_verification_started_at
answer_verification_completed_at
answer_verification_duration_ms
claim_verification_duration_ms
llm_claims_attempted
llm_claims_succeeded
llm_claims_fallback
llm_coverage_ratio
fallback_reason
```

Metrics acceptance:

- API response/debug endpoint에서 average/p50/p95 verifier duration 확인 가능.
- eval harness가 `llm_coverage_ratio`, `p95_verifier_ms`, `fallback_count`를 출력.
- 운영 smoke는 “전체 claim LLM attempted” 또는 fallback reason을 명시해야 한다.

Risky claim 조건:

- deterministic says refute/not enough info and decision impact >= 0.7
- NLI confidence margin < 0.15
- evidence modality includes `page_visual`
- claim has Korean numeric/legal/admin terms
- answer will be shown as recommendation/decision, not casual explanation

---

### Phase 4.5 — LangGraph spike for gated report/decision workflow

**Objective:** 자동 `verify → repair → re-verify`가 필요한 최종 산출물 모드에 LangGraph가 실제 이득이 있는지 작은 spike로 검증한다.

**Do not use LangGraph for:**

- 일반 채팅 inline badge만 붙이는 흐름.
- 단순 verifier provider 호출.
- Nest service + DB transaction으로 충분한 one-shot workflow.

**Use LangGraph only if spike proves:**

- report/decision answer를 publish 전 gate해야 한다.
- verify 결과에 따라 targeted repair/rewrite를 자동 실행해야 한다.
- repair 후 re-verify loop를 명시적 state machine으로 보존해야 한다.
- user approval/interrupt/resume이 필요하다.

**Proposed graph:**

```text
START
  → retrieve_context
  → draft_answer
  → extract_claims
  → verify_claims_all_llm
  → route_verdicts
      ├─ all_supported_or_nei_ok → publish
      ├─ repairable_refute_or_unsupported → targeted_repair
      ├─ needs_human_approval → interrupt_review
      └─ max_round_exceeded → publish_with_warning
  → reverify_repaired_claims
  → publish
END
```

**Spike constraints:**

- Add dependency only in spike branch/task: `@langchain/langgraph`, `@langchain/core`.
- Use in-memory checkpointer only for local spike; production requires Postgres-backed durable checkpoint or existing DB-backed run state.
- No side-effect before interrupt unless idempotent.
- Do not write final chat message until `publish` node.
- Persist every state transition to existing audit/verification tables or a small `verification_workflow_runs` table.

**Spike acceptance:**

- One fixture where initial draft has a refuted claim.
- Graph repairs only the bad claim, not the whole answer.
- Re-verification passes or publishes warning after max 1 repair round.
- Timing metrics include graph node durations.
- If spike adds more complexity than value, keep the plain Nest orchestrator.

---

### Phase 5 — end-to-end eval + operational deployment

**Objective:** 품질 개선을 숫자와 브라우저 QA로 증명한다.

**Eval sets:**

1. Existing synthetic fixtures.
2. Changwon real fixtures:
   - 공무직 승진체계 신설 요구
   - 창원시 본청 공무직 승진체계 유무
   - 레포츠파크 이관 가능성
   - 지방공기업 설립기준/조례 근거
   - 시설별 수지율/인력/비용 표 질의
3. Visual PDF fixtures:
   - table-only answer
   - chart/figure answer
   - scanned page answer

**Commands:**

```bash
pnpm --filter @consulting/contracts build
pnpm --filter @consulting/db-schema build
pnpm --filter @consulting/api exec vitest run test/evidence-to-decision.service.test.ts test/evidence-decision-api.test.ts --reporter=dot
pnpm --filter @consulting/api exec tsx scripts/evidence_to_decision_v1_eval.ts
pnpm --filter @consulting/api typecheck
pnpm --filter @consulting/web typecheck
pnpm --filter @consulting/api test
pnpm --filter @consulting/api build
pnpm --filter @consulting/web build
```

**Operational smoke:**

- deploy 8088 with docker compose prod
- health/readiness
- create marker account/thread
- upload or seed visual PDF
- ask query requiring table/page visual
- verify inline badge and right panel verdicts
- cleanup marker account and prove zero residual rows

---

## 4. Risk / tradeoff matrix

| Risk | Impact | Mitigation |
|---|---:|---|
| 새 프로젝트가 빈 껍데기로 생성되어 shared brain에 연결되지 않음 | High | `consulting_default` 템플릿 자동 프로비저닝 + TEST backfill dry-run |
| TEST와 창원 brain slug가 섞임 | High | project slug 기반 brain slug, cross-project 참조는 라벨/감쇠만 허용 |
| Telegram 추가 토픽이 `thread_id=NULL` 전역 바인딩으로 한 덩어리 처리됨 | High | thread별 `telegram_topic_links` + exact `chat_id/thread_id` binding으로 전환 |
| Telegram topic별 prompt가 없어 보수체계/근속승진/대행사업 맥락이 섞임 | High | thread별 channel profile + no-markdown Telegram prompt 생성 |
| 채널별 목적이 없어서 모든 채널이 같은 톤/맥락으로 답함 | High | `channel_profiles`를 현재 채널 최우선 app-context로 주입 |
| 자동 추론 profile이 잘못 굳어짐 | Medium | auto는 suggestion/internal로 시작; evidence keywords/refs 저장; manual canonical 우선 |
| 계산/정확성 요청을 LLM이 암산/추정으로 답함 | High | Exactness Gate: Python/SQL/원문조회 실행 없이는 final numeric/exact claim 금지 |
| Python runner가 보안/성능 리스크가 됨 | High | sandbox, timeout, no secrets, no write by default, read-only SQL, code hash/audit |
| Exactness Gate 과발동으로 답변이 느려짐 | Medium | deterministic high-confidence trigger 우선, trivial calc fast path, duration metric/p95 관리 |
| Voyage API key/cost/rate limits | Medium | provider flag, bounded retry, local fallback, per-page idempotency hash |
| ColPali/ColQwen GPU dependency bloats API image | High | separate worker/provider, do not block main API, approve heavy deps separately |
| NLI model weak on Korean | High | Korean fixture eval, LLM escalation for Korean/legal/numeric claims |
| LLM judge hallucinates | High | strict JSON schema, evidence-id citation requirement, parser failure = downgrade, no uncited support |
| 전체 claim LLM verifier가 답변 지연을 크게 늘림 | Medium | claim batching, per-answer timer, p95 metric, budget 초과 시 risky-only fallback |
| verifier 실패 후 자동 재실행이 무한루프/왜곡을 만든다 | High | 일반 채팅은 자동 rerun 금지; report/decision mode만 max 1 repair round 후 re-verify |
| LangGraph 도입으로 런타임 복잡도 증가 | Medium | spike 한정; one-shot 검증은 Nest service 유지; production checkpointer 없으면 배포 금지 |
| page images leak sensitive docs to external provider | High | provider disabled by default unless explicit config; per-workspace allowlist; metadata audit |
| Search improves recall but worsens precision | Medium | RRF weights behind config; eval requires context precision/citation correctness, not only hit rate |

---

## 5. Acceptance criteria

### Project provisioning / bridge state

- 새 consulting project 생성 시 기본 channel/topic/thread가 자동 생성된다.
- 새 project에는 project slug 기반 shared brain slug/link가 자동 생성된다.
- 기존 TEST 프로젝트는 backfill 후 consulting link가 생기고, 기존 messages 10건이 보존된다.
- TEST brain과 창원 brain `changwon-org-mgmt-diagnosis`가 섞이지 않는다.
- 창원 Telegram/default-chat messages는 기존처럼 shared brain recall 대상이다.
- Shared brain `dialogue_chunks/file_chunks` counts are unchanged unless an explicit ingest job runs.

### Telegram forum topic bridge

- Telegram threads `12/524/533/356` are all represented as separate web topics under `창원시 컨설팅 / 텔레그램`.
- Thread `524` maps to `창원_보수체계`; thread `533` maps to `창원_근속승진`; thread `356` maps to `창원_대행사업`.
- Thread `1` is imported as `일반/검토필요` and is not auto-finalized without manual classification.
- Each Telegram topic has an active `telegram_topic_links` row and a current channel/topic profile.
- New Telegram sessions bind by exact `chat_id + thread_id`, not by `thread_id=NULL` broad sweep.
- Legacy `NULL` sessions remain readable but do not define the behavior for new multi-topic sessions.
- Web mirror no longer collapses all Telegram topic messages into only `default-chat`.

### Channel profile / prompt context

- 새 channel은 template 기반 default profile을 가진다.
- 사용자가 channel purpose/role/style을 수정하면 다음 답변부터 current channel profile로 주입된다.
- Telegram/default-chat처럼 UI 노출이 없는 채널도 내부 auto profile을 생성하고 prompt에 주입한다.
- 창원 Telegram profile은 보수체계/근속승진/승진/공무직 같은 실제 대화·문서 키워드를 evidence_refs와 함께 보존한다.
- 현재 채널 profile은 다른 채널 참조보다 높은 우선순위를 가진다.
- 다른 채널 참조는 계속 허용하되 `다른 채널 참고` 라벨과 감쇠가 붙는다.

### Exactness Gate / calculation verification

- 계산·비율·총액·기간·법령/조항·파일/URL/DB 상태 요청은 Exactness Gate를 통과해야 한다.
- 단순 산술도 LLM mental math로 답하지 않고 Python/Decimal 결과를 가진다.
- 금액/정원/보수/승진효과 등 의사결정 수치는 primary + recompute/invariant 2-pass를 가진다.
- `exactness_runs` ledger에는 input refs, formula/query, result_json, invariant results, status, duration이 저장된다.
- mismatch가 2회 이상이면 final number를 단정하지 않고 `검산 불일치/자료 부족`으로 표시한다.
- post-answer verifier는 numeric/date/legal/source claim에 exactness ledger가 없으면 `not_enough_info` 또는 review queue로 내린다.
- Telegram 답변은 내부 코드/경로 없이 `계산 기준/검산 결과/주의점`만 보여준다.

### Multimodal

- PDF page image extraction creates `page_visual` units.
- When Voyage is configured, semantic vector row persists with provider/model/input hash.
- When Voyage is not configured, local fallback persists and system does not fail.
- Search result can show `page_visual` semantic hit with locator.

### Verifier

- Existing deterministic eval remains green.
- NLI provider fixture passes support/refute/NEI thresholds.
- LLM strict JSON provider handles Korean complex claims and visual evidence cases.
- LLM strict JSON is attempted for every claim when latency budget allows.
- claim/answer verification durations are persisted and visible in eval/debug output.
- If fallback happens, fallback reason and LLM coverage ratio are visible.
- General chat does not auto-rerun on verifier failure; it exposes badges/actions.
- Report/decision workflow can perform max 1 targeted repair + re-verify before publish/warning.
- UI still shows the same badges/actions without contract churn.

### LangGraph spike

- No production dependency unless spike proves value.
- Spike fixture demonstrates draft → verify → targeted repair → re-verify → publish.
- Side effects are idempotent and final message write happens only at publish node.
- Durable checkpoint strategy is defined before any production rollout.

---

## 6. Recommended implementation order

1. **Do not mutate prod yet.** First build read-only project provisioning report, including TEST.
2. Add `consulting_default` project template service with tests.
3. Wire template into new project creation behind a safe default/config flag.
4. Add TEST backfill preview; run preview and show exact rows that would be added.
5. After approval, run TEST backfill commit and prove counts/messages preserved.
6. Add channel profile schema/service/API and seed template defaults.
7. Add read-only Telegram topic audit script and keep it as a regression probe.
8. Add Telegram topic registry schema/service and dry-run backfill for threads `12/524/533/356/1`.
9. After approval, create web topics + `telegram_topic_links` + per-thread profiles; preserve existing messages/chunks.
10. Replace broad `thread_id=NULL` auto-bind behavior for new sessions with exact `chat_id/thread_id` binding.
11. Inject channel/topic profile into Hermes instructions and browser-QA one run per Telegram topic.
12. Add Exactness Gate schema/service + Python/Decimal runner and read-only SQL/source-check adapters.
13. Add exactness regression fixtures for percentage, unit mismatch, duplicate rows, law/source locator, DB count.
14. Wire exactness results into verifier/rewrite loop and Telegram/web output.
15. Add embedding provider abstraction + fake provider tests.
16. Add Voyage provider behind env flag.
17. Add document unit embedding persistence and search scoring.
18. Add NLI provider behind env flag.
19. Add LLM strict JSON provider with default all-claim verification and latency-budget downgrade.
20. Add latency metrics: average verifier time, p95 verifier time, fallback count, LLM-covered claim ratio, exactness duration p95.
21. Add report/decision repair policy without LangGraph first: targeted repair max 1 round, re-verify, warning fallback.
22. Run LangGraph spike only if step 21 becomes hard to maintain with plain Nest orchestration.
23. Expand eval fixtures with Changwon Korean claims, exactness tasks, and visual PDF cases.

---

## 7. 남은 구현 전제

확정된 결정:

1. 새 consulting project는 `consulting_default` 템플릿을 기본 자동 적용한다.
2. brain slug는 자동 생성하고, 고급설정에서 수정 가능하게 한다.
3. 기존 TEST 프로젝트는 dry-run 확인 후 소급 세팅한다.
4. 창원자료는 Voyage 외부 전송을 허용한다.
5. Voyage 사용에는 `VOYAGE_API_KEY`가 필요하다. `/home/jigoo/.hermes/.env`에 존재 확인됨. 키는 서버 env로만 관리한다.
6. LLM verifier는 기본 전체 claim 적용, latency budget 초과 시 risky claim 우선 fallback으로 운영한다.
7. 일반 채팅은 자동 rerun하지 않고 badge/action을 붙인다. report/decision workflow만 targeted repair + re-verify를 자동 수행한다.
8. LangGraph는 제한 spike 대상이다. 단순 검증에는 쓰지 않는다.
9. 채널별 목적/역할 profile은 current channel의 최우선 app-context로 항상 주입한다.
10. Telegram 채널은 UI 노출 없이 내부 auto profile을 생성해 주입할 수 있다.
11. Telegram 추가 토픽 3개는 같은 창원 brain을 쓰되 thread별 web topic/profile/binding으로 분리한다.
12. 현재 확인된 매핑은 `524=창원_보수체계`, `533=창원_근속승진`, `356=창원_대행사업`; `1=General/검토필요`, `12=기존 창원-컨설팅`이다.
13. 계산/정확성 요청은 Exactness Gate로 라우팅하고, Python/SQL/원문조회 검산 없이는 final numeric/exact claim을 내지 않는다.

실행 전에 필요한 것:

- 운영 Docker/API/worker가 `/home/jigoo/.hermes/.env`의 `VOYAGE_API_KEY`를 실제 env로 읽도록 mount/env wiring 확인.
- TEST backfill dry-run 결과 확인 후 commit 승인.
- Telegram topic backfill dry-run 결과 확인 후 commit 승인. 특히 `thread_id=NULL` broad binding 제거/대체는 운영 메모리 경로 변경이므로 별도 승인.
- Exactness Gate는 보안 sandbox/timeout/read-only SQL 정책을 먼저 구현한 뒤 chat 경로에 연결한다.
- LLM verifier latency budget 초기값: 제안값은 per-answer 6~10초. 실제 구현 후 p95를 보고 조정.

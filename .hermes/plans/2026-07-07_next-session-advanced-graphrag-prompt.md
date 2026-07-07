# Next Session Prompt — consulting-web Advanced GraphRAG 7개 고도화

아래 프롬프트를 새 Hermes 세션 첫 메시지로 그대로 붙여넣는다.

---

## 통합 로드맵 (2026-07-07 개정) — 구현 순서 한눈에

> **주인님 지침: 축소 없이 구멍 13개 전부 해결하고 간다.** 로드맵을 먼저 확인·승인한 뒤 구현 착수. 아래 Phase는 위→아래 순서. 각 Phase는 이전 Phase의 게이트가 GREEN이어야 진입.

```text
┌─ P0. 재측정 게이트 ───────────────────────────────────────────┐
│  pnpm test/typecheck/build + compose config + DB ghost probe   │
│  + 런타임 프로브(H1 MISSING / H2 llm-fallback / H3 2s vs 5s)     │
│  산출: baseline 리포트                                          │
└───────────────────────────────────────────────────────────────┘
        ↓
┌─ P1. 인제스트·결정성 (H5·H9·H8·H10) — §0 평가셋의 선행조건 ────┐
│  H5+H9  ingest → outbox/queue 이관, 컨트롤러 void 제거, 워커 소비 │
│  H8     Gemini 임베딩 재시도 + 2단계(chunk 먼저 / embed 백필)     │
│  H10    recorded-embedding 골든 픽스처(라이브 API 없이 결정적)    │
│  게이트: turn 유실 0 · 결정적 재현 · RED→GREEN                    │
└───────────────────────────────────────────────────────────────┘
        ↓
┌─ P2. 평가 기반 §0 ────────────────────────────────────────────┐
│  40+문항 질문셋 · hit@k/precision/groundedness/citation/latency  │
│  baseline run 저장(P1 픽스처로 재현) · pnpm smoke 결정적          │
│  게이트: 이후 §1~7의 회귀 gate로 동작                            │
└───────────────────────────────────────────────────────────────┘
        ↓
┌─ P3. 검색 품질 §1~§3 ─────────────────────────────────────────┐
│  §1  Hybrid RRF+reranker 복원                                   │
│      선행: H1(이미지에 numpy+onnxruntime 추가·빌드승인) ·         │
│            H2(cross-encoder 관측) · H3(타임아웃 설정화) ·         │
│            H7(신호 normalize) · H13(recall status 관측)          │
│  §2  CRAG/Self-RAG evaluator  ← 선행 H4(다중 topic fan-out)      │
│  §3  Citation/evidence post-check (CiteFix류)                   │
│  → 재평가 (P2 harness로 §1~3 전후 diff)                          │
└───────────────────────────────────────────────────────────────┘
        ↓
┌─ P4. 심화 §4~§7 ──────────────────────────────────────────────┐
│  §4  RAGAS/STaRK 평가셋 고도화                                   │
│  §5  RAPTOR 계층 요약        ← 선행 H6(SoT write additive)       │
│  §6  Leiden community        ← 선행 H6 + H11(graph edge 백필) +   │
│                                 leidenalg/igraph 의존성 승인      │
│  §7  ToG-2 KG×Text deep mode ← 선행 H11 + H3(deep 예산 분리)     │
└───────────────────────────────────────────────────────────────┘

전 구간: H12 Gemini 키/비용/레이트/degradation 정책 상시 적용.

★ 사전 승인 필요(빌드/의존성):
   - H1  API 이미지에 numpy + onnxruntime (+옵션 google-generativeai) → 이미지 크기 증가
   - H6  §6용 leidenalg / igraph (또는 대체 community detection lib)
```

상세 구멍 정의는 아래 **§선결 구멍 (P-1)** 표, 각 고도화 상세는 **§구현 순서**를 본다.

---

## 새 세션 프롬프트

주인님 요청: `consulting-web`의 기존 GraphRAG bridge/lifecycle 안정화 위에 **7개 고급 고도화**를 순서대로 진행해줘. 단, 구현 전에 반드시 현 상태 재측정과 평가셋/품질게이트부터 만들고, 새 store/pgvector를 먼저 만들지 말고 기존 `/home/jigoo/.hermes/workspace/consulting/db/consulting.db` GraphRAG 자산을 우선 활용해.

### 반드시 먼저 로드할 skill

- `consulting-web-architecture`
- `systematic-debugging`
- `test-driven-development`
- `consulting-evidence-production-system`
- `statistics-evidence-planning`
- 필요 시 `database-store-migration`, `long-task-orchestration`, `saas-ui-ux-redesign-planning`

### 작업 repo

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
```

### 시작 전 반드시 읽을 문서

1. `.hermes/plans/2026-07-07_final-audit-bugfix-and-advanced-graphrag-handoff.md`
2. `.hermes/plans/2026-07-06_D-search-graphrag-vector-audit.md`
3. `plans/consulting-web-roadmap.md`
4. skill `consulting-web-architecture`의 references:
   - `web-graphrag-bridge-2026-07.md`
   - `web-graphrag-bridge-runtime-2026-07.md`
   - `cross-reference-and-lifecycle-design.md`

### 시작 전 재측정 게이트

아래를 먼저 실행하고 결과를 보고한 뒤 진행해.

```bash
pnpm test -- --reporter=dot
pnpm typecheck
pnpm build
docker compose --env-file .env.docker -f docker-compose.prod.yml config --quiet
```

DB ghost reference도 재확인:

```bash
docker exec consulting-web-pg-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "select count(*) as live_edges_to_deleted from context_edges e where e.deleted_at is null and ((e.from_scope_type='"'"'project'"'"' and exists(select 1 from projects s where s.id=e.from_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.to_scope_type='"'"'project'"'"' and exists(select 1 from projects s where s.id=e.to_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.from_scope_type='"'"'channel'"'"' and exists(select 1 from channels s where s.id=e.from_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.to_scope_type='"'"'channel'"'"' and exists(select 1 from channels s where s.id=e.to_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.from_scope_type='"'"'topic'"'"' and exists(select 1 from topics s where s.id=e.from_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.to_scope_type='"'"'topic'"'"' and exists(select 1 from topics s where s.id=e.to_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.from_scope_type='"'"'thread'"'"' and exists(select 1 from threads s where s.id=e.from_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))) or (e.to_scope_type='"'"'thread'"'"' and exists(select 1 from threads s where s.id=e.to_scope_id and (s.deleted_at is not null or s.status='"'"'deleted_soft'"'"'))));"'
```

기대값: `0`.

### 시작 전 런타임 프로브 게이트 (2026-07-07 추가 — 필수)

아래를 실행해 **shared consulting brain GraphRAG 런타임이 API 컨테이너 안에서 실제로 동작하는지** 먼저 확정한다. 이 프로브 결과가 §P-1 구멍 H1~H3의 baseline이다.

```bash
# H1: dense/rerank 런타임 의존성 존재 여부 (현재 전부 없음이 확인됨)
docker exec consulting-web-api-1 sh -lc 'for m in numpy onnxruntime sentence_transformers google.generativeai; do python3 -c "import $m" 2>/dev/null && echo "$m OK" || echo "$m MISSING"; done'

# H2: --rerank 켰을 때 실제 rerank_method (cross-encoder 여야 정상; llm/rrf면 fallback = 미작동)
docker exec consulting-web-api-1 sh -lc 'cd /brain/consulting && python3 scripts/dialogue_memory_cli.py recall --topic changwon-org-mgmt-diagnosis --q "핵심 리스크" --top-k 3 --format json --rerank 2>/dev/null | python3 -c "import sys,json; print(\"rerank_method=\", json.load(sys.stdin).get(\"rerank\"))"'

# H3: no-rerank recall latency (Gemini embed API 왕복 포함) vs bridge 5초 타임아웃
docker exec consulting-web-api-1 sh -lc 'cd /brain/consulting && s=$(date +%s.%N); python3 scripts/dialogue_memory_cli.py recall --topic changwon-org-mgmt-diagnosis --q "핵심 리스크" --top-k 3 --format json --no-rerank >/dev/null 2>&1; e=$(date +%s.%N); echo "no_rerank_latency=$(echo "$e-$s"|bc)s"'
```

2026-07-07 실측 baseline (이 값에서 출발):
- H1: `numpy / onnxruntime / sentence_transformers / google.generativeai` **전부 MISSING**.
- H2: `--rerank` 켜도 `rerank_method=llm` (cross-encoder 미작동, 조용한 fallback).
- H3: no-rerank recall ≈ **2s** (Gemini embed 1회 왕복 포함), bridge 타임아웃은 **5s** 하드코딩.

### 절대 지킬 것

- 7개 고도화는 **평가셋/품질 게이트 먼저** 만든 뒤 구현한다.
- 기존 `consulting.db`가 GraphRAG SoT다. 새 pgvector/store부터 만들지 않는다.
- cross-workspace는 hard block.
- cross-project는 같은 workspace 안에서만 허용, confidence ×0.6, UI/프롬프트에 `다른 프로젝트` 라벨.
- archived 자료는 referenceable할 수 있지만 active 자료와 섞어 단정하지 말고 `보관됨` 라벨을 붙인다.
- 근거가 부족하면 답변을 생성하지 말고 `기존 자료상 근거 부족`을 명시한다.
- 금융/운영/인프라 위험 변경은 명시 승인 없이는 하지 않는다.
- 테스트는 RED→GREEN 원칙을 지킨다.

---

## 선결 구멍 (P-1) — 7개 고도화 착수 전 반드시 닫는다

> 2026-07-07 실물 코드/DB/컨테이너 교차검증에서 발견. **주인님 지침(2026-07-07): 축소 없이 13개 구멍 전부 해결하고 간다.** §0 평가셋을 잠그기 **전에** H5·H8·H9·H10(인제스트 유실·결정성)을 닫아야 baseline이 새는 코퍼스를 재지 않는다. H1~H3·H7·H13은 §1 착수 직전에, H4는 §2 착수 직전에, H6·H11은 §5·§6·§7 착수 직전에 닫는다. 각 구멍은 착수 게이트다.

| ID | 구멍 | 실측 근거 | 닫는 시점 | 필요 조치 |
|---|---|---|---|---|
| **H5** | GraphRAG ingest가 fire-and-forget `try/catch{}`로 실패를 삼킴 → web 대화 turn 유실 | `consulting-web-ingest.service.ts:46` 빈 catch, `spawn` best-effort | **§0 이전** | 이미 있는 `outbox-relay.service.ts` + `queues.module.ts` 재사용해 ingest를 outbox/queue로 이관, 실패 시 재시도·dead-letter. RED 테스트: ingest 스크립트 실패 시 이벤트가 유실되지 않고 재시도 큐에 남는다. |
| **H9** | 컨트롤러가 ingest를 `void`로 호출(await 안 됨) + 서비스 빈 catch = **이중 삼킴**, turn당 python 프로세스 fork | `chat-stream.controller.ts:245` `void this.webIngest.ingestCompletedTurn(...)` | **§0 이전** | H5 outbox 이관과 함께 처리: 컨트롤러는 outbox row만 트랜잭션 커밋, 실제 인제스트는 워커가 소비. 동시성 상한·프로세스 재사용 고려. |
| **H8** | web ingest가 turn마다 Gemini 동기 임베딩(`E.embed_one`, 60s 타임아웃) → 인제스트 신뢰성이 외부 API에 결합 | `ingest_web_dialogue.py:117` `E.embed_one(context_text)` | **§0 이전** | 워커 내 재시도+backoff. `--no-embed` 경로로 우선 저장 후 임베딩 백필하는 2단계 옵션 설계(임베딩 실패해도 chunk/FTS는 남게). vector parity 회귀 테스트. |
| **H10** | 오프라인 임베딩 캐시/픽스처 전무 → §0 평가 harness가 라이브 Gemini 의존(비결정적·과금·flaky) | `embeddings.py`에 cache/fixture/record 코드 없음 | **§0 이전(핵심)** | recorded-embedding golden 픽스처 레이어 구축(질의→벡터 스냅샷). CI/pnpm smoke는 라이브 API 없이 결정적으로 돈다. baseline run도 이 픽스처로 재현. |
| **H1** | API 컨테이너에 dense/rerank 런타임 의존성 전무 → **결정: 이미지에 의존성 추가(축소 없음)** | `import numpy/onnxruntime/sentence_transformers/google.generativeai` 전부 MISSING. 완화: 호스트 47GB RAM/26GB avail·컨테이너 메모리 무제한 → 570MB onnx 로드 OOM 위험 낮음 | **§1 이전** | API 이미지에 `numpy`+`onnxruntime`(+필요 시 google-generativeai) 추가. onnx 모델(570MB)은 마운트 유지. **빌드 승인 항목**: 이미지 크기 증가. reranker는 lazy-load+finally-unload라 상주 안 함. 동시 recall 시 N×570MB이므로 rerank 경로 동시성 상한 설정. |
| **H2** | `--rerank` 켜도 프로덕션에서 cross-encoder 미작동, `rerank_method=llm`으로 조용히 fallback | `--rerank` 실측 결과 `rerank_method=llm` (H1 의존성 부재 때문) | **§1 이전** | H1 해결로 실제 cross-encoder 작동. §1 완료 조건에 "`rerank_method=cross-encoder`가 **관측된다**" 추가. 조용한 fallback을 harness가 실패로 잡게 한다. |
| **H3** | query 임베딩이 Gemini API 실시간 urllib 왕복 → bridge 5초 타임아웃 안에서 flaky, 초과 시 조용히 `empty()`(근거 0건) | recall ≈2s(정상 네트워크), bridge `timeout: 5_000` 하드코딩(`consulting-graphrag-bridge.service.ts:59`) | **§1 이전** | 타임아웃을 설정화, 채팅경로 예산과 §5·6·7 deep-mode 예산을 **분리**. harness가 latency를 경로별로 분리 측정하고 `empty()` 폴백을 "근거 없음"과 구분해 로깅(H13과 함께). |
| **H13** | bridge가 어떤 에러(타임아웃/JSON깨짐/키부재)든 `empty()` → "근거 0건"과 "recall 실패"를 구분 못 함(관측성 부재) | `consulting-graphrag-bridge.service.ts:70-72,90-98` catch→empty | **§1 이전** | recall 결과에 `status`(ok/empty/timeout/error) + 구조화 로그/메트릭. H2 silent fallback·H3 타임아웃이 이 로그로 보이게. harness가 이 status를 회귀 신호로 사용. |
| **H7** | recall 출력이 상위 `signals` count만 노출, hit별 dense/lexical/graph subscore는 없음. `graph=0` 관측 | recall json `signals` 블록엔 count만, hit엔 `fused_score/score`만 | **§1 이전** | §1 step3 "신호 normalize"는 shared brain `dialogue_memory/search.py` **출력 수정**(=cross-workspace 자산 편집). "brain CLI 확장 vs bridge 파생" 택1 명시. `graph=0` 원인은 H11로 규명. |
| **H4** | `bridge.recall`이 단일 `topicSlug` 스코프 전용 → cross-project fan-out 불가 | `recall(input: { topicSlug ... })` 시그니처, CLI도 `--topic` 단일 | **§2 이전** | §2 ambiguous→cross-project 확장(workspace 내 ×0.6 감쇠)은 workspace→projects→topics fan-out recall 필요. CLI/bridge에 다중 topic 스코프 경로 먼저 설계. |
| **H11** | graph 신호 substrate 빈약 — changwon `dialogue_edges` 그래프쿼리 **0건**, `cross_topic_links` 전역 **0건** (단 `claim_evidence_links=137` 존재) | recall `graph:0`·`file_graph:0`, DB row count 실측 | **§6·§7 이전(§1 규명)** | §1에서 `graph=0` 원인 진단(edge 부재 vs 매칭 실패). §6 community·§7 ToG-2는 graph edge에 의존하므로 착수 전 dialogue/cross-topic edge 감사·백필(additive) 필요. 없으면 빈 신호 위에 구축. |
| **H6** | §5(RAPTOR)·§6(Leiden)이 SoT(`consulting.db`)에 WRITE | 요약/커뮤니티 노드를 shared brain DB에 신규 적재 | **§5·§6 이전** | (a) additive-only·멱등·원문 `chunk_id` 추적·`source` 라벨 필수(H5 인제스트와 동급 위험). (b) Leiden은 `leidenalg`/`igraph` 등 **신규 의존성** → 착수 전 별도 빌드 승인. |
| **H12** | Gemini가 recall+ingest+eval 공통 **하드 의존**(키/비용/레이트) | `embeddings.py`가 모든 임베딩을 Gemini로, 키는 `/brain/hermes.env`(존재 확인) | **전 구간(§0에서 정책화)** | 키-존재 프로브(완료), eval 반복 실행(40문항×N)용 비용/레이트 예산 가드, 키/네트워크 부재 시 graceful degradation 정책 문서화. |

**P-1 완료 게이트:**

```text
[§0 이전 · 인제스트·결정성]
  H5+H9 outbox/queue 이관 (컨트롤러 void 제거, 트랜잭션 outbox, 워커 소비)
  H8 임베딩 재시도 + 2단계(chunk 먼저/embed 백필) 경로
  H10 recorded-embedding 골든 픽스처 → 그 다음에만 §0 baseline 저장(결정적)
  → 유실 0 · 결정적 재현 증명

[§1 이전 · 하이브리드/리랭커/관측성]
  H1 이미지 의존성 추가(빌드 승인) + rerank 동시성 상한
  H2 rerank_method=cross-encoder 관측
  H3 타임아웃 설정화 + 경로별 예산 분리
  H13 recall status(ok/empty/timeout/error) 구조화
  H7 신호 normalize 범위(legacy 수정 vs bridge 파생) 확정

[§2 이전]  H4 다중 topic fan-out recall 설계
[§6·§7 이전]  H11 graph edge 감사·백필,  H6 SoT write additive·의존성 승인
[전 구간]  H12 Gemini 비용/레이트/degradation 정책
```

**2026-07-07 실행 결과(현 작업 세션):**

- 완료: H5·H9(outbox/queue ingest, controller fire-and-forget 제거), H8(fail-open 저장 + missing embedding backfill), H10(fake deterministic embedding + eval smoke), H1(Debian bookworm 이미지 + numpy/onnxruntime/sentence-transformers/google-generativeai/torch), H2(`rerank=cross-encoder` 컨테이너 실측), H3(60s recall timeout + 최소 45s guard), H7(hit별 `signal_breakdown`), H13(`status` ok/empty/timeout/error + `rerank_error` 관측).
- §0 baseline 완료: `pnpm --filter @consulting/api test:graphrag` → 45문항, hit@k 0.8889, p95 5.7821s, failures 0, warning 0, rerank mode `cross-encoder`.
- 반복 검증 완료: `pnpm --filter @consulting/api test:ralph` → 3회 반복 GREEN, static failures 0, failed consulting-web embeddings 0, dialogue FTS orphans 0, context_only cross-topic links 2, 컨테이너 runtime cross-encoder probe GREEN.
- 추가 완료: H4 다중 topic fan-out recall 지원. `ConsultingTopicResolver.resolveThreadFanout()`가 workspace 내 active project links를 후보로 만들고, `ConsultingGraphRagBridge.recallMany()`가 중복 topic 제거·cross-project confidence ×0.6 감쇠·`다른 프로젝트` 라벨을 보존한다. ralph 3회 반복에 H4 context-builder 테스트와 single-topic recall 금지 static check를 추가했다.
- 추가 완료: H11. 실측 결과 `dialogue_edges=339`, `file_edges=1931`로 edge substrate는 존재했고, `graph=0` 원인은 한국어 어미/조사 미정규화(`수익구조` ↔ `수익구조는`, `취약` ↔ `취약하다`)였다. legacy `dialogue_memory/search.py`에 deterministic `_term_set()` 정규화를 추가했고, `수익구조 경륜 취약` recall에서 `graph=1`, `file_graph=16`, `claim:CL-D4-01` hit를 확인했다. 또한 `cross_topic_suggest()`가 파일만 쓰고 DB `cross_topic_links`를 남기지 않던 구멍을 idempotent insert 코드 + `/tmp` DB 테스트로 닫았다. 승인 후 live `consulting.db`에 양방향 2건(`road-traffic-conditions-outlook` ↔ `changwon-org-mgmt-diagnosis`)을 `context_only/pending`으로 적용했고, 재실행 count=2로 멱등 검증했다.
- 추가 완료: H12. `E.embed_query()`/`E.embed_file_query()` 실패가 recall 전체를 죽이지 않도록 shared brain recall을 signal-level degradation으로 격리했다. Gemini quota/key/network 장애 시 `semantic`/`file_semantic`은 0으로 degrade되고 lexical/graph/file_lexical/file_graph는 계속 실행되며, 결과 JSON에 `degraded_signals`/`degraded_errors`가 붙는다. `/tmp` in-memory regression test와 `test:graphrag` GREEN.
- 추가 완료: H6. `scripts/advanced_graphrag_write_guard.py`를 추가해 RAPTOR/Leiden/ToG류 SoT write가 `CONSULTING_ADVANCED_GRAPHRAG_WRITE_APPROVED=YES` 없이는 차단되도록 했다. derived row는 `source`와 non-empty `source_chunk_ids`를 강제하고, Leiden류 신규 의존성은 별도 `CONSULTING_ADVANCED_GRAPHRAG_DEPS_APPROVED=YES` + import probe를 통과해야 한다. ralph brain tests에 H6 guard를 포함해 GREEN.
- P-1 현재 상태: 13개 선결 구멍은 코드/DB/문서/ralph 기준 모두 닫힘. 이제 7개 고도화(§1~§7) 착수 가능. 단, §6 Leiden에서 실제 `igraph/leidenalg` 설치·이미지 변경이 필요해질 경우에는 별도 승인 후 진행한다.

---

## 구현 순서 — 7개 고도화

> 순서 조정(2026-07-07): **H5(인제스트 안정화) → §0 평가셋 → §1~3 → 재평가 → §4~7.** §0 앞에 H5를 넣는 이유는 유실되는 코퍼스 위에서 baseline을 재면 이후 모든 회귀 판정이 오염되기 때문이다.

### 0. 평가 기반부터 만들기 — 모든 고도화의 선행조건

목표: “검색이 좋아졌다”를 감이 아니라 수치로 판단한다.

해야 할 일:

1. `apps/api/test/fixtures/graphrag-eval/*.json` 또는 유사 위치에 consulting 전용 질문셋 생성.
2. 최소 40문항으로 시작:
   - 단일 문서 수치 질문
   - 특정 claim/evidence 질문
   - 긴 대화 기억 질문
   - multi-hop 관계 질문
   - cross-project 참조 질문
   - archived 자료 라벨링 질문
   - 근거 부족/거절 질문
3. 평가 harness 작성:
   - retrieval hit@k
   - context precision
   - answer groundedness/unsupported claim count
   - citation correctness
   - latency
4. 이 harness가 이후 1~7의 regression gate가 되게 한다.

완료 조건:

```text
baseline run 저장
평가 결과 JSON/Markdown 리포트 생성
CI 또는 pnpm test에서 최소 smoke 실행 가능
```

---

### 1. Hybrid RRF + reranker 복원

> **착수 게이트: P-1의 H1·H2·H3·H7·H13을 먼저 닫는다.** rerank는 플래그가 아니라 런타임(numpy/onnxruntime) 부재 문제(H1, 이미지 추가로 해결)이고, cross-encoder는 지금 조용히 llm으로 fallback(H2)한다. 신호 normalize는 legacy `search.py` 출력 수정이 필요(H7)하며, recall 실패/타임아웃/빈결과를 구분하는 status 관측(H13)이 함께 들어가야 harness가 회귀를 잡는다.

목표: 기존 consulting GraphRAG의 장점인 vector + FTS + graph + rerank를 web bridge에서도 제대로 사용.

현재 문제:

- `ConsultingGraphRagBridge`가 `dialogue_memory_cli.py recall --no-rerank`로 호출되는 상태.

해야 할 일:

1. 기존 `dialogue_memory_cli.py recall` 옵션/출력 구조 확인.
2. `--no-rerank` 제거 또는 설정화.
3. Dense/lexical/graph 신호가 결과 metadata에 남도록 normalize.
4. `sourceTier`, `score`, `rerankScore`, `graphPath`를 prompt context로 넘길 수 있게 DTO 정리.
5. baseline 평가셋에서 hit@k/context precision 비교.

완료 조건:

```text
same query baseline 대비 hit/context precision 하락 없음
latency 허용 범위 문서화
```

---

### 2. CRAG/Self-RAG식 retrieval evaluator

> **착수 게이트: P-1의 H4를 먼저 닫는다.** `bridge.recall`은 단일 topicSlug 전용이라 cross-project fan-out 경로가 아직 없다. ambiguous→cross-project 확장 전에 다중 topic 스코프 recall을 설계한다.

목표: 검색 결과가 질문에 충분한지 판단한 뒤 답변/재검색/거절을 분기.

해야 할 일:

1. `EvidenceSufficiencyEvaluator` 같은 내부 service 추가.
2. 입력: user query + retrieved contexts.
3. 출력:
   - `sufficient`
   - `ambiguous`
   - `insufficient`
   - 이유/부족한 근거 타입
4. `ambiguous`면 same workspace cross-project dampened recall 허용.
5. `insufficient`면 prompt에 근거 부족을 강제하고 unsupported answer 금지.
6. evaluator 자체 테스트는 작은 deterministic fixture로 시작.

완료 조건:

```text
근거 부족 질문에서 hallucinated answer 감소
cross-project가 필요한 질문만 확장 검색
```

---

### 3. Citation/evidence post-check / CiteFix류 검증

목표: 답변의 문장/claim이 실제 retrieved chunk와 맞는지 후검증.

해야 할 일:

1. 답변 내 factual claim segment 추출.
2. 각 claim이 어느 evidence chunk로 지지되는지 lexical+semantic matching.
3. citation mismatch/unsupported claim을 표시.
4. 불일치가 높으면:
   - 답변 수정 재요청
   - 또는 UI에 `근거 확인 필요` 표시
5. CiteFix류 light-weight matching부터 구현하고, LLM verifier는 옵션화.

완료 조건:

```text
citation correctness metric 추가
의도적으로 잘못 붙인 citation fixture를 잡아냄
```

---

### 4. RAGAS/STaRK식 자체 평가셋 고도화

목표: consulting의 text+relationship graph 특성을 평가할 수 있는 지속 벤치마크.

해야 할 일:

1. STaRK 스타일로 structured relation target 포함.
2. 질문마다 expected evidence id/chunk/claim path 기록.
3. archived/cross-project/insufficient 케이스를 반드시 포함.
4. RAGAS 유사 metric을 내부 lightweight 구현 또는 별도 script로 작성.
5. 결과 리포트를 `.hermes/reports/` 또는 `reports/`에 저장.

완료 조건:

```text
새 retrieval 변경 전후 diff가 한눈에 보임
회귀 기준선 문서화
```

---

### 5. RAPTOR 계층 요약 검색

> **착수 게이트: P-1의 H6을 먼저 닫는다.** summary node는 SoT(`consulting.db`)에 WRITE다 → additive-only·멱등·원문 `chunk_id` 추적·`source` 라벨 필수. H5 인제스트 안정화와 동급 위험으로 다룬다.

목표: 긴 문서/긴 대화의 큰 그림 질문에 대응.

해야 할 일:

1. 기존 `dialogue_chunks`/`file_chunks`를 대상으로 recursive summary node 설계.
2. summary는 별도 table 또는 기존 SQLite side table에 저장하되, 원문 chunk ids를 추적.
3. query classifier: 세부 질문은 raw chunk, 큰그림 질문은 summary 우선.
4. summary가 답변에 쓰이면 원문 근거까지 drill-down citation 연결.

완료 조건:

```text
전체 요약/흐름 질문에서 context recall 개선
summary-only hallucination 방지를 위해 원문 evidence 연결 확인
```

---

### 6. Microsoft GraphRAG Leiden community summary

> **착수 게이트: P-1의 H6·H11을 먼저 닫는다.** community report도 SoT에 WRITE(additive-only·멱등·label). Leiden(`leidenalg`/`igraph`)은 **신규 의존성** → 착수 전 별도 빌드 승인. 또한 community detection은 graph edge에 의존하는데 changwon `dialogue_edges` 그래프신호가 0건(H11)이므로, edge 감사·백필이 선행돼야 빈 그래프 위에 커뮤니티를 만들지 않는다.

목표: 프로젝트/컨설팅 전체의 구조적 이슈, recurring theme, global question에 답변.

해야 할 일:

1. 기존 dialogue/file graph edges를 이용해 community clustering 설계.
2. Leiden 또는 대체 community detection library 사용 가능성 검토.
3. community report 생성:
   - 주요 entities
   - claims
   - risks
   - evidence ids
   - conflicts/gaps
4. global query classifier 추가.
5. local query에는 community summary를 과도하게 주입하지 않는다.

완료 조건:

```text
전반적/전체적/반복되는 리스크 질문에서 evidence-backed global answer 가능
```

---

### 7. ToG-2식 KG×Text iterative deep mode

> **착수 게이트: P-1의 H11·H3을 먼저 닫는다.** graph hop은 dialogue/cross-topic edge에 의존하는데 현재 그래프신호 0건(H11) → edge 감사·백필 선행 필수. round loop는 다회 recall을 하므로 채팅경로와 분리된 deep-mode latency 예산(H3)이 필요하다.

목표: deep research 질문에서 graph hop과 text retrieval을 반복하며 깊게 탐색.

해야 할 일:

1. deep mode trigger 정의:
   - “왜 연결돼?”
   - “근거 경로 보여줘”
   - “반대 근거까지”
   - “여러 단계로 추적”
2. round loop:
   - topic entity 추출
   - graph neighbor 탐색
   - 관련 text recall
   - sufficiency judge
   - 부족하면 다음 hop
3. max round/latency/cost guard 필수.
4. path explanation을 UI evidence panel에 넘길 수 있게 구조화.

완료 조건:

```text
multi-hop 질문에서 path + evidence + uncertainty가 같이 출력
일반 채팅 latency에는 영향 없음
```

---

## 완료 보고 형식

최종 답변은 반드시 아래 형식으로만 보고해.

```text
완료한 것
- ...

검증 결과
- 명령: ...
- 결과: ...

판단
- ...

다음 할 일
- ...
```

7개 전부를 한 세션에 끝내려 하지 말고, **P-1(H5 인제스트 안정화) → 평가셋(§0) → §1~3 → 재평가 → §4~7** 순으로 안정적으로 진행해. 각 고도화는 해당 착수 게이트(H1~H7)를 먼저 닫은 뒤 시작한다.

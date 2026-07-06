# A. 채널 상호참조 그래프(Context Reference Graph) 활성화 설계

> **For Hermes:** 구현 시 subagent-driven-development 스킬로 task 단위 실행. 이 문서는 설계/계획 전용, 실행 아님.

**Goal:** 이미 존재하는 `context_edges` 그래프 레이어에 `related_to`/`references`/`shares_memory_with` 엣지의 **쓰기(수동+자동추론)와 읽기(채팅 컨텍스트 주입)** 를 얹어, 같은 프로젝트 안의 채널들이 서로를 참조·인지하게 만든다.

**Architecture:** 신규 테이블 없음. `edge_type` enum(`related_to`/`references`/`derived_from`/`shares_memory_with`/`supersedes`)과 `context_edges` 테이블은 이미 있으나 현재 `parent_of`만 쓰인다(실측 42/42). (1) 엣지 쓰기 유스케이스·API, (2) 태그 겹침 기반 자동추론 잡, (3) 채팅 스트림 시작 시 1-hop traverse로 연관 채널의 요약/아티팩트를 프롬프트에 주입하는 리더를 추가한다. 프로젝트 경계는 넘지 않으며(기본), 명시 엣지가 있을 때만 참조한다.

**Tech Stack:** NestJS(useCase/controller) · Drizzle ORM · PostgreSQL · Vitest(`DATABASE_URL` 있을 때만 실행되는 통합테스트 컨벤션) · 기존 outbox/audit 패턴.

---

## 0. 현재 상태 (실측 2026-07-06, `consulting-web-pg-1`)

| 항목 | 값 | 의미 |
|---|---|---|
| context_edges | 42건, 전부 `parent_of/system` | 상호참조(related_to 등) 0건 |
| projects/channels/topics/threads | 6 / 12 / 15 / 15 | 소규모, 마이그레이션 부담 낮음 |
| 채팅 컨텍스트 조립 | `chat-stream.usecase.ts`는 `projectId`만 추출→접근검사 | 그래프 traverse 없음 = 옆 채널 못 봄 |
| memory_topic_id | 15/15 전부 null | dialogue_memory 연동 미배선(문서 B/C에서 다룸) |

**결론:** 뼈대는 완비, "쓰기+읽기"만 없다. 신규 스키마 최소.

---

## 0.5 확정 결정 (2026-07-06, 주인님 승인)

| # | 결정 | 값 |
|---|---|---|
| D1 | **경계** | **워크스페이스 = 하드 경계.** cross-workspace 참조는 절대 자동 안 함(다른 사람/고객사 = 기밀). |
| D2 | **연결 범위** | **같은 워크스페이스 안이면 프로젝트가 달라도 전부 자동 연결.** ("다 내 지식" — cross-project 자동 허용) |
| D3 | **연결 세기** | 같은 프로젝트 채널끼리=강, **다른 프로젝트끼리=약 + "다른 프로젝트" 라벨**(자동은 되되 출처표시로 오염 방지). |
| D4 | **자동연결 임계** | 태그 **2개 이상** 겹침 → `related_to/classifier`, `confidence=jaccard`. 약한추천 뱃지로 표시, 사용자가 확정/해제. |
| D5 | **cross-workspace 예외 경로** | 극히 예외적으로 다른 워크스페이스 참조가 필요하면 **2단계 확인 모달 + provenance 기록**(즉시연결, Approval Inbox 아님). 기본 UI엔 노출 안 함. |

## 1. 설계 원칙 (불변식)

1. **워크스페이스가 유일한 하드 경계.** 자동 발견·주입은 **같은 워크스페이스 안에서만**. cross-workspace는 D5 예외 경로로만.
2. **프로젝트 경계는 소프트.** 같은 워크스페이스면 프로젝트가 달라도 `related_to` 자동 생성. 단 **거리에 따라 결합 강도 등급화**(§1.5) — 무분별 동일세기 금지.
3. **provenance + 라벨 보존.** 엣지 origin은 `manual`/`classifier`/`system` 구분, cross-project 엣지는 `cross_project=true` 플래그. 주입 시 "다른 프로젝트" 라벨 강제.
4. **읽기는 예산 제한.** 컨텍스트 주입은 토큰 예산 안에서 상위 N개(기본 3) 엣지만, 요약/아티팩트 헤더만. 원문 통짜 주입 금지.
5. **역방향 안전.** 엣지 추가/삭제가 기존 트리 쿼리(`workspaceTree`, `listThreads`)에 영향 0.

## 1.5 결합 강도 등급 (과연결·오염 방지의 핵심)

거리별로 세 레벨의 결합을 다르게 적용한다:

| 레벨 | 무엇 | same-project (강) | cross-project·같은 WS (약) | cross-workspace |
|---|---|---|---|---|
| **L1 발견** | classifier 자동 엣지 생성(뱃지) | ✅ confidence 그대로 | ✅ confidence × 0.6 감쇠 | ❌ |
| **L2 주입** | 채팅에 연관 컨텍스트 주입 | 강하게 | 약하게 + "다른 프로젝트" 라벨 | ❌ |
| **L3 고정** | 메모리 풀 공유(`shares_memory_with`) | 수동 | 수동 + 확인모달 | D5 예외 모달 |

- L1/L2는 자동, L3만 수동. cross-project는 L1·L2까지 자동이되 **약하게(감쇠+라벨)**.
- confidence 감쇠 계수(0.6)·주입 상위 N(3)은 config로 분리해 튜닝.

---

## 2. 엣지 타입 시맨틱 확정

| edge_type | 방향성 | 의미 | 생성 주체 |
|---|---|---|---|
| `related_to` | 무향(양방향 취급) | "관련 있음" 일반 링크 | manual / classifier |
| `references` | 유향 A→B | A가 B를 근거/출처로 인용 | manual (아티팩트 저장 시 auto) |
| `derived_from` | 유향 A→B | A는 B에서 파생(복제/분기) | system (채널 복제 시) |
| `shares_memory_with` | 무향 | 대화 메모리 풀 공유(강한 결합) | manual only(고위험, 승인) |
| `supersedes` | 유향 A→B | A가 B를 대체(구버전 아카이브) | system (문서 B 연계) |

> `shares_memory_with`는 격리를 깨는 유일한 타입이라 **수동+승인**만. 나머지는 "인지"만 시키고 메모리 풀은 분리 유지.

---

## 3. 데이터 모델 보강 (최소 마이그레이션)

`context_edges`에 컬럼 2개만 추가. 신규 테이블 없음.

```
drizzle/0009_context_edge_refs.sql
  ALTER TABLE context_edges ADD COLUMN created_by_user_id uuid
    REFERENCES users(id) ON DELETE SET NULL;   -- manual/cross 엣지 감사(D5 provenance)
  ALTER TABLE context_edges ADD COLUMN deleted_at timestamptz;  -- tombstone(문서 B와 공유)
  ALTER TABLE context_edges ADD COLUMN note text NOT NULL DEFAULT '';  -- "왜 연결했나"
  ALTER TABLE context_edges ADD COLUMN cross_project boolean NOT NULL DEFAULT false;   -- D3 라벨 트리거
  ALTER TABLE context_edges ADD COLUMN cross_workspace boolean NOT NULL DEFAULT false; -- D5 예외 표식
  CREATE INDEX context_edges_to_idx ON context_edges(to_scope_type, to_scope_id);  -- 역방향 traverse
```

schema 파일: `packages/db-schema/src/schema/context-graph.ts`의 `contextEdges`에 `createdByUserId`, `deletedAt`, `note`, `crossProject`, `crossWorkspace` 추가 + `context_edges_to_idx` 인덱스(현재 from_idx만 존재).

---

## 4. 구현 태스크 (bite-sized, TDD)

### Task A1: 엣지 스키마 컬럼 추가
- **Files:** Modify `packages/db-schema/src/schema/context-graph.ts` · Create `packages/db-schema/drizzle/0009_context_edge_refs.sql`
- Step1: schema에 컬럼/인덱스 추가 → `pnpm --filter @consulting/db-schema drizzle:generate`로 SQL 생성 확인
- Step2: `packages/db-schema/scripts/migrate.ts` 경로로 적용, `\d context_edges`에 컬럼 존재 검증
- Step3: commit `feat(db): context_edges ref columns + reverse index`

### Task A2: 엣지 쓰기 유스케이스 (수동 링크)
- **Files:** Create `apps/api/src/spaces/link-scopes.usecase.ts` · Test `apps/api/test/link-scopes.test.ts`
- **입력:** `{workspaceId, fromScopeType, fromScopeId, toScopeType, toScopeId, edgeType, note?, actorUserId, confirmCrossWorkspace?}`
- **검증 규칙(트랜잭션 내) — D1/D2/D5 반영:**
  - 두 scope 모두 존재 + `deleted_at is null` (+ status가 live)
  - **같은 workspace면 project 달라도 허용**(cross-project OK). 두 노드 project_id가 다르면 엣지에 `cross_project=true` 플래그.
  - **다른 workspace면 기본 거부** → `confirmCrossWorkspace=true`(2단계 모달 통과)일 때만 허용, 엣지에 `cross_workspace=true` + `created_by_user_id` 필수(D5 provenance).
  - self-loop 금지, 중복은 `onConflictDoNothing`
  - `shares_memory_with`는 이 유스케이스에서 거부 → 별도 승인 경로(Task A7)
- outbox `ScopesLinked` + audit `scope.link`(cross 플래그 포함) 기록
- Step1(RED): "삭제 노드 링크→err(NOT_FOUND)", "**다른 프로젝트 related_to→ok + cross_project=true**", "다른 워크스페이스 confirm 없이→err(CROSS_WORKSPACE_CONFIRM_REQUIRED)", "confirm 있으면→ok + cross_workspace=true" 테스트 4종
- Step2~4: 최소 구현→GREEN→commit

### Task A3: 엣지 해제(soft) 유스케이스
- **Files:** `apps/api/src/spaces/unlink-scopes.usecase.ts` + test
- 물리삭제 아님 → `deleted_at=now()` 세팅(감사·복구용). audit `scope.unlink`.
- Step: "unlink 후 traverse에서 제외되나" 테스트.

### Task A4: 그래프 리더 (1-hop 연관 조회)
- **Files:** Create `apps/api/src/spaces/context-graph.reader.ts` + test
- **메서드:** `relatedScopes(scopeType, scopeId, {depth=1, types=['related_to','references','shares_memory_with']}) -> {scopeType,scopeId,edgeType,direction,confidence}[]`
- 양방향 조회: `from_scope_id=X OR to_scope_id=X`, `deleted_at is null`, 대상 노드도 `deleted_at is null`(유령 필터 — 문서 B 없이도 여기서 방어).
- `parent_of`/트리 엣지는 제외(연관≠부모).
- Step1(RED): 시드 엣지 심고 "related 2건 반환, 삭제된 대상은 제외" 검증.

### Task A5: 채팅 컨텍스트 주입 (읽기 통합 — 핵심)
- **Files:** Modify `apps/api/src/chat/chat-stream.usecase.ts` + `chat-stream.controller.ts` · new `apps/api/src/chat/related-context.builder.ts` + test
- **동작:** 스레드→topic→channel 해석 후, 그 **channel**에서 `relatedScopes` 1-hop 조회 → 각 연관 채널의 (a) 이름/경로, (b) 최신 아티팩트 head 제목·note, (c) 최근 요약 1줄을 모아 **컨텍스트 블록** 생성:
  ```
  [연관 채널 컨텍스트 — 참조용, 이 채널의 사실로 단정 금지]
  · <채널명> (related_to): 최신 산출물 "…" / 요약 …
  · <다른프로젝트>/<채널명> (related_to · 다른 프로젝트): 최신 산출물 "…" / 요약 …
  ```
- **예산 게이트:** 최대 3개 채널, 채널당 ≤400자. 초과 시 confidence(감쇠 반영)·recency 순 컷 → cross-project는 이미 confidence×0.6이라 자연스럽게 뒤로 밀림.
- **D3 라벨:** 엣지 `cross_project=true`면 라벨에 "· 다른 프로젝트" 명시(오염 방지).
- Hermes run 프롬프트에 system-context로 prepend(기존 `hermes-runs-client.ts` 주입 지점 재사용).
- **격리 라벨 필수:** 주입 블록에 "참조용/단정금지" 라벨 → 환각·교차오염 방지(consulting 스킬의 source-tier 원칙과 정합).
- Step1(RED): "연관엣지 있는 스레드→컨텍스트 블록에 옆 채널명 포함", "엣지 없으면 블록 비어있음", "4개 연관→3개로 컷" 테스트.

### Task A6: 태그 겹침 자동추론 잡 (classifier) — D2/D3 반영
- **Files:** Create `apps/api/src/spaces/infer-related.job.ts` + test · 트리거는 `ChannelCreated`/`ProjectCreated` outbox 소비 or 수동 CLI
- **로직:** 새 채널/프로젝트 생성 시, **같은 워크스페이스 내** 다른 채널들과 `scope_tags` 교집합 계산 → 공유 태그 ≥2개면 `related_to/classifier` 엣지 자동 생성.
  - `confidence = jaccard(tagsA, tagsB)` × **거리 계수**: same-project=1.0, **cross-project=0.6 감쇠**(§1.5 L1).
  - cross-project 엣지엔 `cross_project=true` 플래그 → 주입 시 "다른 프로젝트" 라벨 트리거.
- **범위:** 워크스페이스 경계 안에서만(D1). cross-workspace는 절대 자동 생성 안 함.
- **안전장치:** 자동 엣지는 `origin='classifier'` → 사용자가 언제든 unlink. 임계 미만은 생성 안 함(과연결 방지). 뱃지로 "약한 추천" 표시.
- **왜 자동인가:** 주인님 요구 "프로젝트 달라도 비슷한 것 자동 참조". 트리 부모연결(이미 자동)과 별개로 형제·타프로젝트 연관을 confidence 약하게 자동 후보 생성.
- Step1(RED): "같은프로젝트 태그3공유→confidence 그대로", "**다른프로젝트 태그3공유→엣지 생성+cross_project=true+confidence×0.6**", "다른 워크스페이스→엣지 없음", "태그1공유→엣지 없음".

### Task A7: shares_memory_with 승인 경로 (고위험)
- **Files:** `apps/api/src/spaces/request-memory-share.usecase.ts` (기존 approval inbox `approvalStatus` enum 재사용) + test
- 사용자가 두 채널 메모리 공유 요청 → approval pending → 승인 시에만 `shares_memory_with` 엣지 + (문서 B/C의 memory_topic 공유 배선).
- Step: "요청→pending, 승인→엣지 생성, 거부→엣지 없음".

### Task A8: 프론트 — 채널 연관 링크 UI
- **Files:** `apps/web/src/features/channel-links/*` · `apps/api` 컨트롤러에 `POST /scopes/:id/links`, `GET /scopes/:id/links`, `DELETE /links/:id`
- 채널 헤더/사이드에 "연관 채널" 섹션: 목록·추가(검색후 링크)·해제. classifier 자동 엣지는 "자동 추천(약한 연결)" 뱃지로 구분, 확정/해제 버튼.
- Step: 계약테스트(`contracts`) + 최소 UI. (UI 세부는 saas-ui-ux 스킬 라운드 규칙 따름 — 로딩/hover/다크/간격 전수)

---

## 5. 검증 / validation

```bash
# 통합테스트 (DATABASE_URL 세팅 필요)
DATABASE_URL=postgres://consulting_app:***@127.0.0.1:5434/consulting \
  pnpm --filter @consulting/api test link-scopes context-graph related-context infer-related
# 그래프 상태 재확인
docker exec consulting-web-pg-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select edge_type, origin, count(*) from context_edges where deleted_at is null group by 1,2"'
```
기대: `parent_of/system` + `related_to/classifier` + (수동) `related_to/manual` 공존, dead-target 엣지 traverse 제외.

---

## 6. 리스크 / 트레이드오프

- **과연결(graph noise):** 자동추론 임계가 낮으면 모든 채널이 서로 related. → jaccard 임계 + 상위 N 컷 + confidence 표시로 억제. 임계값은 config로 빼서 튜닝.
- **컨텍스트 오염:** 옆 채널 사실을 이 채널 답으로 단정. → 주입 블록 "참조용/단정금지" 라벨 + source-tier 유지(consulting 스킬 원칙).
- **토큰 비용:** 매 채팅마다 traverse+주입. → 예산 게이트(3채널×400자), 그리고 엣지 없으면 조회 스킵(대부분 채널은 엣지 0).
- **프로젝트 경계 누수:** cross-project는 **의도적으로 허용**(D2). 누수 리스크는 워크스페이스 경계에서 차단(D1) + cross-project 엣지 감쇠·"다른 프로젝트" 라벨(D3)로 관리.
- **워크스페이스 경계 누수(치명):** cross-workspace 자동 생성이 실수로 열리면 기밀 유출. → classifier·주입은 워크스페이스 필터 하드코딩, cross-workspace는 D5 명시 confirm 경로에서만. 테스트로 "다른 WS→엣지 없음" 회귀 고정.

---

## 7. 결정 완료 · 남은 튜닝 · 고도화 (주인님 요청)

### 결정 완료 (§0.5 D1~D5)
- ✅ 경계=워크스페이스, cross-project 자동 허용, cross-workspace 차단(D5 예외 모달만)
- ✅ 연결 세기=거리 등급화(same-project 강 / cross-project 약+라벨)
- ✅ 자동연결 임계=태그 2개↑, 약한추천 뱃지

### 남은 튜닝 파라미터 (config로 분리, 운영 중 조정)
1. **방향성 UI 표현** — `related_to`(무향) vs `references`(유향 A→B)를 UI에서 화살표로 구분할지. (제안: 목록은 통합, 상세는 방향 표시)
2. **cross-project 감쇠 계수** — 현재 0.6. 실사용 후 과/소 참조 보고 조정.
3. **주입 상위 N / 채널당 글자수** — 현재 3채널 × 400자. 토큰비용 vs 유용성 균형.
4. **참조 유용성 로깅** — 주입된 연관 채널이 실제 답변에 인용됐는지 기록 → confidence 사후 보정(G1로 연결).

### 고도화 로드맵 (선택)
- **G1. 엣지 신뢰도 학습 루프:** 채팅에서 실제 참조된 연관 채널을 outbox로 기록 → classifier confidence를 사후 보정(useful/ignored). gbrain volunteer_context "volunteered vs used" 정밀도 패턴과 동형.
- **G2. 임베딩 유사도 발견(강력):** 태그 겹침만으론 명시 메타에 갇힘. GBrain 임베딩 인프라 재활용해 **의미적 유사도**로 cross-project 연관을 발견(초기 태그 기반 → 이후 임베딩 확장). 단일자산·store 격리 원칙 유지.
- **G3. 자동 요약 캐시:** 연관 채널 "최근 요약 1줄"을 매번 계산하지 말고 채널별 rolling summary를 outbox 소비로 캐시(주입 지연 제거).
- **G4. 워크스페이스 지식그래프 뷰:** 노드=프로젝트/채널, 엣지=related/references, cross-project는 점선. d3/react-flow. 주인님이 원한 "전체 지식그래프 서로 참조" 시각화의 라이브 버전.
- **G5. 방향성 승계:** `derived_from`(채널/프로젝트 복제) 자동 생성 → 분기된 노드가 원본을 자동 참조.

---

## 8. 의존관계

- 문서 B(라이프사이클/tombstone)와 **`deleted_at` 컬럼·유령 필터를 공유**. B 먼저 하면 A의 §4 Task A4 유령필터가 더 깨끗. 권장 순서: **B의 Task B1~B3(tombstone 인프라) → A 전체.**
- A7(shares_memory_with)은 문서 C(memory_topic 배선)에 의존 → C 없으면 A7만 보류하고 A1~A6/A8 먼저.

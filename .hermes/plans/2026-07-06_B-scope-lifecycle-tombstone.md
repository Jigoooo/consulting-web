# B. 스코프 라이프사이클 & 그래프 Tombstone 정리 설계

> **For Hermes:** 구현 시 subagent-driven-development 스킬로 task 단위 실행. 설계 전용, 실행 아님.

**Goal:** 프로젝트/채널/토픽/스레드 삭제를 **완전삭제가 아닌 3-state 라이프사이클**(active → archived → deleted_soft)로 재정의하고, 삭제 시 그래프 엣지·태그의 **유령 참조(dangling edge)를 tombstone으로 정리**한다. 주인님 요구 "완전삭제 아니라 남기되, 흔적이 지저분하게 남지 않게".

**Architecture:** enum `entity_status`에 `archived`/`deleted_soft`가 이미 존재하나 미사용(현재 `deleted_at` 플래그만 씀). 이를 실제 사용해 (1) archived=트리 숨김+검색/참조 가능, (2) deleted_soft=전부 제외+복구창구, (3) 물리삭제=워크스페이스 cascade만. 삭제 캐스케이드 시 `context_edges`/`scope_tags`도 함께 tombstone. 신규 테이블 없음.

**Tech Stack:** 기존 NestJS 유스케이스(`space-mutate.service.ts`) 확장 · Drizzle · PostgreSQL · Vitest.

---

## 0. 현재 상태 (실측 2026-07-06)

| 항목 | 값 | 문제 |
|---|---|---|
| 삭제 방식 | `softDeleteNode`가 `deleted_at`만 세팅, 하향 cascade O | archived/deleted 구분 없음 (2-state) |
| status enum 사용 | `entity_status`에 archived/deleted_soft 있으나 코드는 `deleted_at`만 씀 | enum 死자산 |
| dead edges | 삭제채널行 엣지 1건 + 삭제토픽行 엣지 1건 (실측) | 삭제 시 엣지 미정리 → 유령 참조 축적 |
| dead scope_tags | 0건(우연히 없음) | 정리 로직 부재는 동일 리스크 |
| 복구 경로 | 없음(코드상 restore 미구현) | "남긴다"면서 되살릴 방법 없음 |

**핵심 결함:** 삭제해도 `context_edges`·`scope_tags`가 그대로 남아, 문서 A가 그래프를 읽기 시작하면 삭제된 노드를 가리키는 엣지가 유령으로 살아난다.

---

## 1. 라이프사이클 상태 정의 (불변식)

| status | 트리 표시 | 검색 | 참조(엣지 대상) | 채팅 | 복구 | 물리행 |
|---|---|---|---|---|---|---|
| `active` | O | O | O | O | — | 존재 |
| `archived` | 접힘/보관함 | O | O(약하게) | 읽기전용 | 즉시 | 존재 |
| `deleted_soft` | X | X | X(tombstone) | X | 복구창구(N일) | 존재 |
| (물리삭제) | — | — | — | — | 불가 | 워크스페이스 cascade만 |

**규칙:**
1. `archived` = "일 끝난 채널, 지식은 보존". 주인님의 "남아있어야 한다"에 정확히 대응. 검색·참조 가능, 트리에서만 접힘.
2. `deleted_soft` = "치우되 복구 가능". 트리/검색/참조 전부 제외, 복구 버튼·보관기간(config, 기본 30일).
3. 물리삭제는 **워크스페이스 통삭제 시 FK cascade로만** 발생. 개별 노드는 절대 물리삭제 안 함.
4. 아티팩트·evidence·chat_messages는 노드가 deleted_soft여도 **보존**(감사·재활용). deleted_at으로 숨김만.

---

## 2. 데이터 모델 (컬럼 재정의, 신규 테이블 0)

- 4개 space 테이블(`projects/channels/topics/threads`)은 이미 `status`(entity_status) + `deleted_at` 둘 다 보유.
- **status를 진짜로 쓴다:** `archived`/`deleted_soft` 세팅. `deleted_at`은 deleted_soft일 때만 채움(복구시각/보관만료 계산 기준).
- `context_edges`/`scope_tags`에 `deleted_at timestamptz` 추가(A 문서 0009 마이그레이션과 공유). tombstone 표식.
- **불변식 인덱스 겸 뷰(선택):** `active_scope` 판정을 한 곳에서 — 헬퍼 `isLive(status, deleted_at) = status='active' OR status='archived'` (archived는 참조 가능이므로).

```
drizzle/0009_context_edge_refs.sql  (A와 공유)
  ALTER TABLE context_edges ADD COLUMN deleted_at timestamptz;
  ALTER TABLE scope_tags   ADD COLUMN deleted_at timestamptz;
drizzle/0010_lifecycle_status.sql
  -- 기존 deleted_at IS NOT NULL 행을 status='deleted_soft'로 백필
  UPDATE projects SET status='deleted_soft' WHERE deleted_at IS NOT NULL;
  UPDATE channels SET status='deleted_soft' WHERE deleted_at IS NOT NULL;
  UPDATE topics   SET status='deleted_soft' WHERE deleted_at IS NOT NULL;
  UPDATE threads  SET status='deleted_soft' WHERE deleted_at IS NOT NULL;
```

---

## 3. 구현 태스크 (bite-sized, TDD)

### Task B1: tombstone 컬럼 + 백필 마이그레이션
- **Files:** Modify `packages/db-schema/src/schema/context-graph.ts`(edges/scope_tags에 deletedAt) · Create `drizzle/0009_*.sql`(A와 공유), `drizzle/0010_lifecycle_status.sql`
- Step1: schema 수정 → generate → 적용
- Step2: `select count(*) from context_edges where deleted_at is not null` = 0 (신규 컬럼 초기값), status 백필 검증
- Step3: commit `feat(db): edge/tag tombstone + lifecycle status backfill`

### Task B2: 통합 상태전이 유스케이스
- **Files:** Create `apps/api/src/spaces/lifecycle.service.ts` + test `apps/api/test/lifecycle.test.ts`
- **메서드 3종:**
  - `archiveNode(kind,id)` → status='archived'(deleted_at 안 건드림), 하향 cascade archived
  - `softDeleteNode(kind,id)` → status='deleted_soft' + deleted_at=now, 하향 cascade **+ Task B3 엣지/태그 tombstone 호출**
  - `restoreNode(kind,id)` → deleted_soft/archived → active, 상향 검증(부모가 deleted면 복구 거부 or 부모부터)
- 기존 `space-mutate.service.ts`의 `softDeleteNode`를 이 서비스로 이관(호출부 갱신).
- Step1(RED): "archive→트리 제외되나 검색O", "softDelete→검색X", "restore→active복귀", "부모 deleted 상태서 자식 restore→err" 테스트 4종.

### Task B3: 삭제 시 그래프 tombstone
- **Files:** `lifecycle.service.ts` 내부 `tombstoneScopeGraph(scopeType, scopeId, tx)` + test
- **로직:** 노드 softDelete 시 그 노드를 from/to로 가진 `context_edges`와 scope=노드인 `scope_tags`를 `deleted_at=now()`.
- **archived는 tombstone 안 함**(참조 가능해야 하므로). deleted_soft만.
- restore 시 **엣지/태그 tombstone 되돌리기**(deleted_at=null) — 단, 반대편 노드가 아직 살아있을 때만.
- Step1(RED): "채널 softDelete→그 채널 엣지 전부 deleted_at 세팅", "restore→반대편 살아있으면 엣지 부활, 죽어있으면 부활 안 함".

### Task B4: 모든 리더에 live 필터 일원화
- **Files:** Modify `apps/api/src/spaces/space-read.service.ts`, `space-mutate.service.ts`, `chat-stream.usecase.ts`, (A의)`context-graph.reader.ts`
- 현재 `isNull(deletedAt)` 산발 → `isLive` 헬퍼로 통일. **archived 노출 정책 분기:**
  - `workspaceTree`: active만 기본 + `?includeArchived=true`면 archived 포함(보관함 토글)
  - 검색/참조: active+archived
  - 채팅 접근: active만 쓰기, archived 읽기전용
- Step1(RED): "archived 채널은 기본 트리에서 빠지고 includeArchived로 나온다", "deleted_soft는 어느 쿼리에도 안 나온다".

### Task B5: 복구 창구 + 보관기간 만료 잡
- **Files:** `apps/api/src/spaces/restore.controller.ts`(`GET /trash`, `POST /trash/:id/restore`) · Create `apps/api/src/spaces/purge-expired.job.ts` + test
- `/trash`: deleted_soft이고 보관만료 전인 노드 목록(복구 가능).
- purge 잡: deleted_at + config(기본 30일) < now인 노드를 **물리삭제 후보**로 표기(자동 물리삭제는 기본 OFF — 주인님 "완전삭제 회피" 선호. 리스트만 뽑고 수동 승인).
- Step1(RED): "31일 지난 deleted_soft→purge후보 목록에 뜬다, 자동삭제는 안 된다".

### Task B6: 프론트 — 보관함/휴지통 UI
- **Files:** `apps/web/src/features/archive-trash/*` + 사이드바 토글
- 프로젝트/채널 우클릭·… 메뉴에 "보관(archive)" / "삭제(휴지통)" 분리. 사이드바 하단 "보관함"·"휴지통(복구)" 진입점.
- deleted_soft는 휴지통에서 복구/영구삭제(승인) 가능. archived는 보관함에서 되돌리기.
- Step: 계약테스트 + 최소 UI(saas-ui-ux 라운드 규칙: 확인 다이얼로그·로딩·다크 전수).

---

## 4. 검증

```bash
DATABASE_URL=... pnpm --filter @consulting/api test lifecycle restore purge
# tombstone 정합성: 삭제된 노드를 가리키는 "살아있는" 엣지가 0이어야
docker exec consulting-web-pg-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
select count(*) as live_edges_to_dead_nodes from context_edges e
where e.deleted_at is null and (
  exists(select 1 from channels c where e.to_scope_type=''channel'' and e.to_scope_id=c.id and c.status=''deleted_soft'')
  or exists(select 1 from topics t where e.to_scope_type=''topic'' and e.to_scope_id=t.id and t.status=''deleted_soft''));"'
```
**기대: 0.** (현재는 2 — 삭제채널1+삭제토픽1. B3가 이걸 닫는다.)

---

## 5. 리스크 / 트레이드오프

- **restore의 상향 의존:** 자식만 복구했는데 부모가 죽어있으면 트리 깨짐. → restore는 부모 live 검증, 아니면 "부모부터 복구" 안내.
- **archived 참조의 stale:** 보관된 채널을 계속 참조하면 오래된 정보 인용. → 주입 블록에 "보관됨(archived)" 라벨.
- **백필 안전:** 0010 마이그레이션이 기존 deleted_at행을 deleted_soft로. 현재 각 1건씩뿐이라 저위험. 실행 전 `pg_dump` 백업.
- **물리삭제 정책:** 자동 purge를 켜면 "완전삭제 회피" 위반. 기본 OFF, 후보 리스트+수동 승인만.

---

## 6. 놓친 질문 · 고도화 (주인님 요청)

### 놓치신 질문들
1. **archived vs deleted_soft를 UI에서 사용자가 구분하고 싶은가?** 아니면 "삭제=보관, 영구삭제=휴지통 비우기" 2단계면 충분한가? (많은 SaaS는 후자만 노출 — 결정 필요)
2. **보관기간(retention)은 며칠?** 기본 30일 제안. 프로젝트 중요도별 차등? (컨설팅은 감사 목적상 길게 — 90일+ 고려)
3. **자식이 부모와 다른 상태일 수 있나?** 예: 프로젝트는 active인데 특정 채널만 archived (O, 정상). 반대로 프로젝트 deleted인데 채널 active는 불가(cascade). → 규칙 명문화 필요.
4. **아티팩트/evidence의 운명:** 노드 삭제 시 산출물도 숨길지, 별도 "산출물 아카이브"로 살릴지. (재활용 가치 큼 → 살리는 쪽 제안)

### 고도화 로드맵
- **H1. audit 기반 타임라인:** 이미 `audit_events` 있음 → 노드별 "생성/보관/삭제/복구" 이력 타임라인 UI. 컨설팅 감사에 직결.
- **H2. 소프트삭제 통합 뷰:** 워크스페이스 전역 "최근 삭제/보관" 대시보드(실수 복구 UX).
- **H3. cascade 미리보기:** 프로젝트 삭제 전 "채널 3·토픽 5·스레드 12개가 함께 보관됩니다" 확인 다이얼로그(파괴적 작업 투명성 — 주인님 "실패 투명" 선호).
- **H4. 엣지 GC 정기 리포트:** dead edge/tag 수를 주기 스캔해 리포트(비침습 read-only analyzer — 주인님 선호 패턴). 자동정리 아님, 가시화만.
- **H5. 복원 시 그래프 재추론:** restore된 채널에 대해 A의 infer-related 잡 재실행 → 그동안 생긴 형제와 재연결.

---

## 7. 의존관계 / 실행순서

- **B가 A의 선행 인프라.** `deleted_at`(edges/tags) 컬럼·`isLive` 헬퍼·유령필터를 B가 깔면 A의 그래프 리더가 처음부터 깨끗.
- **권장 통합 순서:**
  1. B1(마이그레이션) → B2·B3(라이프사이클+tombstone) → B4(live필터 일원화)
  2. A1~A6(그래프 쓰기/읽기) — B의 유령필터 위에 안전하게 얹힘
  3. B5·B6(휴지통 UX) + A8(연관링크 UI) 병행
  4. A7 + 문서 C(memory_topic 배선)는 별도 트랙
- 0009 마이그레이션은 A·B 공유 → **한 번만 작성**, 두 문서가 같은 파일 참조.

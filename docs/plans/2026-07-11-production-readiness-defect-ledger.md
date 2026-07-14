# Consulting Web Production Readiness Defect Ledger

> 상태: ACTIVE · 최초 감사 2026-07-11 · master roadmap 보조 원장
>
> 원칙: 증거 없는 추측은 defect로 승격하지 않는다. 수정은 RED→GREEN→실DB/실브라우저→독립 리뷰 순서로 닫는다.

## 완료선

- `BLOCKER/HIGH` 0건인 독립 QA 라운드가 2회 연속 통과해야 한다.
- 브라우저 흐름, API 계약, DB readback, 새로고침/재기동 복구를 모두 검증한다.
- 오류를 빈 상태로 위장하지 않는다.
- production 배포 후 동일 flow readback까지 통과해야 `production-final`을 닫는다.

## 초기 감사 요약

| 구분 | 결과 |
|---|---|
| 실브라우저 | FAIL · P1 7건 · console 0 messages / JS errors 0 |
| state/recovery 정적 감사 | FAIL · BLOCKER 3건 · HIGH 8건 |
| DB/API→UI 미노출 감사 | 1차 timeout · 3개 좁은 lane으로 재실행 중 |
| 변경 여부 | 감사 agent는 read-only, 변경 없음 |

## BLOCKER

### PR-B01 채팅 정착 실패가 재시도 불가능한 영구 유실로 확정됨

- Todo: `blocker-chat-settlement`
- 증거: `apps/api/src/chat/chat-stream.controller.ts:329-379,381-418`
- 원인: DB 저장 전에 `persisted=true`; assistant/evidence/verifier/brain/notification을 한 `try`에 직렬 결합.
- 영향: 화면에 보인 답변이 새로고침 후 사라지거나 일부 side effect만 영구 누락.
- RED:
  1. 첫 `saveAssistantMessage()` 일시 실패 후 close/finally에서 재정착 또는 durable settle event 존재.
  2. `saveRunEvidence()` 실패에도 answer ingest/notification이 독립 보존.

### PR-B02 `processing` outbox가 crash 후 영구 고착됨

- Todo: `blocker-outbox-lease`
- 증거: `apps/api/src/queues/outbox-relay.service.ts:67-112`
- 원인: `pending`만 claim하며 `processing` lease/heartbeat/만료 재수거 없음.
- 영향: W2-3 contradiction write 포함 모든 outbox event 영구 누락 가능.
- RED: stale `processing` seed→relay restart→lease 만료 재claim→동일 jobId enqueue→published.

### PR-B03 global outbox competing consumer가 unknown event를 성공 처리함

- Todo: `blocker-outbox-routing`
- 증거: `apps/api/src/queues/outbox-relay.service.ts:87-98`, `apps/api/src/consulting/consulting-web-ingest.worker.ts:233-256`
- 원인: 모든 event type을 한 BullMQ queue에 넣고 Consulting Web 전용 Worker가 같은 queue를 소비한 뒤, event type 불일치 시 오류 없이 return.
- 영향: `WorkspaceCreated`와 향후 chat-settlement 등 비-ingest event가 실제 handler 없이 completed 처리되어 영구 유실 가능.
- RED:
  1. unknown event job을 Consulting Web worker에 전달→성공 ack가 아니라 명시 실패/비소비.
  2. event type별 dedicated queue에서 각 job을 단 하나의 호환 consumer만 처리.
  3. routing 없는 event는 relay가 published로 표시하지 않고 pending/dead-letter 정책에 남김.

## HIGH

### PR-H01 채팅 `clientMessageId` 미배선으로 재시도 중복 turn/run

- Todo: `high-chat-idempotency`
- 증거: `packages/contracts/src/chat.ts:15-22`, `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx:510-517`, `apps/api/src/chat/chat-stream.controller.ts:295-305`, `apps/api/src/chat/chat-message.store.ts:40-45`
- RED: user row 저장 뒤 SSE 단절→같은 `clientMessageId` 재요청→user row/run 각 1개.

### PR-H02 산출물 project 귀속이 활성 scope가 아니라 `projects[0]`

- Todo: `high-artifact-attribution`
- 증거: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx:627-647`, `apps/web/src/components/artifacts/ArtifactsSurface.tsx:68-76,228-235`, `apps/api/src/artifacts/artifacts.controller.ts:194,290-319`
- RED: `[A,B]`에서 활성 thread/filter=B일 때 두 생성 경로 request `projectId=B`.

### PR-H03 channel→topic→thread 및 설정 저장 부분 성공

- Todo: `high-scope-atomicity`
- 증거: `apps/web/src/widgets/app-shell/ui/AppShell.tsx:458-465`, `apps/web/src/routes/_app.t.$topicId.tsx:21-36`, `apps/web/src/widgets/app-shell/ui/ProjectSettingsModal.tsx:83-99`
- RED: 각 2·3번째 API 실패→all-or-nothing 또는 명시적 resumable 상태; loading 고착 0건.

### PR-H04 archive cascade가 `deleted_soft`를 되살리고 비트랜잭션

- Todo: `high-scope-atomicity`
- 증거: `apps/api/src/spaces/space-mutate.service.ts:63-81,84-105`
- RED: active+deleted_soft 혼합 subtree archive 후 deleted_soft 불변; N번째 update 실패 시 전체 rollback.

### PR-H05 library URL workspace와 query project tenant 불일치 허용

- Todo: `high-tenant-path`
- 증거: `apps/api/src/library/library.controller.ts:22-45`
- RED: `/workspaces/A/sources?projectId=B-project`→404/VALIDATION, B 자료 0건.

### PR-H06 archived ancestor의 자료·산출물이 active 목록에 노출

- Todo: `high-tenant-path`
- 증거: `apps/api/src/library/library.store.ts:62-70,120-128,179-185`, `apps/api/src/artifacts/artifact.store.ts:97-118`
- RED: project/channel/topic/thread archive→일반 목록 제외, archive 전용 labeled read에서만 노출.

### PR-H07 자료실/산출물 URL 상태·draft 복구 없음, 오류를 empty로 위장

- Todo: `prod-knowledge`
- 증거: `apps/web/src/lib/workspaceModalStore.ts:11-27`, `apps/web/src/widgets/app-shell/ui/AppShell.tsx:600-627`, `apps/web/src/components/library/LibrarySurface.tsx:51-64,145-152`, `apps/web/src/components/artifacts/ArtifactsSurface.tsx:35-53,196-203`
- RED: detail/editor draft refresh 복원; GET 500은 empty copy가 아니라 오류+retry.

### PR-H08 workspace 및 artifact archive/restore CRUD 단절

- Todo: `prod-creation`
- 증거: `apps/api/src/spaces/spaces.controller.ts:59-83,316-338`, `apps/web/src/lib/spaces.ts:69-80`, `apps/api/src/artifacts/artifacts.controller.ts:249-257`, `apps/web/src/lib/collab.ts:96-151`
- RED: workspace와 artifact 각각 create→rename/archive→restore E2E, active/archive 목록 분리.

## Browser P1

### PR-U01 Evidence API 500/stale을 “없음”으로 오판

- Todo: `prod-observability-ui`, `prod-motion-a11y`
- 증거: `EvidencePanel.tsx:176-187,213-238,376-379,476-479,515-516`
- RED: decision/review/retrieval 500·stale→empty 문구 금지, `role=alert`·retry·stale badge.

### PR-U02 Trace Viewer 이동 시 현재 `threadId` 문맥 유실

- Todo: `prod-observability-ui`
- 증거: `AppShell.tsx:513-524,600-650,659-663`
- RED: `/th/:id`의 Trace 클릭→URL 또는 filter에 동일 threadId 유지.

### PR-U03 낮은 viewport에서 생성 CTA 최초 화면 밖

- Todo: `prod-motion-a11y`, `prod-creation`
- 실측: 1280×633, project 2개 expanded 시 채널 추가 y=637·프로젝트 추가 y=671.
- RED: sticky CTA 또는 명시적 sidebar scroll로 pointer/keyboard 도달.

### PR-U04 Evidence tab 전환이 opacity 0 + scale/slide 소멸형 모션

- Todo: `prod-motion-a11y`
- 증거: `EvidencePanel.module.css:66-93,649-656`, `key={mode}` 재마운트.
- RED: 탭 연타 중 blank frame·scale 0건; reduced-motion animation none.

### PR-U05 tab keyboard pattern 미구현

- Todo: `prod-motion-a11y`
- 증거: `EvidencePanel.tsx` mode tabs에 roving focus/Arrow/tabpanel 연결 없음.
- RED: ArrowRight/Left 선택·focus, 비선택 `tabIndex=-1`, `aria-controls`/`tabpanel`.

### PR-U06 보관/숨김/산출물 보관함 lifecycle 용어 충돌

- Todo: `prod-language-lifecycle`
- 증거: `AppShell.tsx`, `CommandPalette.tsx:53-59` 하드코딩.
- RED: archived scope에서 “보관함/복원” 일관성, “숨긴 항목” 제거.

### PR-U07 핵심 control hit target 과소

- Todo: `prod-motion-a11y`
- 실측: 채널 메뉴 24×23, 검색 35×21, Evidence tab 72–75×25, 멤버/알림 30×30.
- RED: 핵심 control 44×44 권장, WCAG 24×24 미달 0건.

## INVESTIGATE

### PR-I01 document retrieval unit fixture가 0행에서 timeout

- 실환경 Postgres/Redis 연결 후 `evidence-decision-api.test.ts:123`에서 재현.
- 아직 worker 미기동 test-harness 문제인지 production indexing 장애인지 구분되지 않음.
- 다음 증거: 라이브 attachment 업로드→queue/job→`document_retrieval_units` DB readback과 worker log를 함께 측정.
- 판정 전에는 HIGH로 과장하지 않는다.

## 수정 순서

1. W2-3 server/UI filter 완료 및 독립 리뷰
2. PR-B03→PR-B02→PR-B01→PR-H01
3. W2-4/W2-5
4. PR-H03/H04/H05/H06/H02
5. PR-H07/H08 및 PR-U01~U07
6. W3/P3~P6
7. 전체 browser/API/DB/recovery 2회 연속 독립 QA

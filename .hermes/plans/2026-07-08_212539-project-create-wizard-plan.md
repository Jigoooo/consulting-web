# 프로젝트 생성 가이드 모달 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task after 주인님 approval.

**Goal:** 현재 `프로젝트 추가`가 이름 1개만 받는 인라인 입력이라서, 프로젝트명 → 연결할 프로젝트/강도 → 최초 자료 → 확인 순서로 받는 가이드형 생성 모달을 설계하고 백엔드 계약까지 연결한다.

**Architecture:** 프로젝트 생성의 “코어 생성”은 `/spaces/projects` 하나의 트랜잭션으로 처리하고, 대용량 최초 자료 업로드는 프로젝트 생성 성공 후 `intakeThreadId`로 순차 업로드한다. 강/약 연결은 기존 `context_edges`를 재사용해 `shares_memory_with`/`related_to`로 표현하고, 프로젝트 개요는 기존 `scope_profiles`를 `project`까지 확장해 저장한다.

**Tech Stack:** React 19 + TanStack Query/Router, Radix Dialog, NestJS, Drizzle/Postgres, `@consulting/contracts`, `@consulting/api-client`, existing attachments/evidence APIs.

---

## 0. Fable Scoping — 먼저 틀릴 수 있는 지점

### 핵심 해석
- 대상 repo는 `consulting-web`로 본다.
- “강하게/약하게 연결”은 프로젝트 간 지식 연결 강도다.
- “최초에 올릴 자료”는 파일뿐 아니라 링크/메모도 포함할 수 있다.
- “프로젝트 개요 판단”은 즉시 확정값이 아니라, 초기 자료 기반 개요 초안을 만들 수 있는 여지를 뜻한다.

### Devil's advocate
1. **모달 남발 위험:** 사용자가 “모달 너무 많이 띄우면 안 좋다”고 했지만, 프로젝트 생성은 드문 bootstrap 액션이라 모달 허용 범위다. 채널/토픽 인라인 생성은 유지한다.
2. **자료 업로드를 create-project 트랜잭션에 넣으면 위험:** base64 파일은 크고 추출이 비동기라 프로젝트 생성 트랜잭션에 묶으면 실패/타임아웃 UX가 나빠진다. 생성 코어와 자료 업로드를 분리한다.
3. **강한 연결이 과주입을 만들 수 있음:** strong은 나중에 chat context injection에 영향을 줄 수 있으므로 “서로 자주 참고”라는 쉬운 문구와 나중에 끊기 UI를 전제로 둔다.
4. **skip/none이 섞이면 UX가 헷갈림:** “미선택”은 아직 결정 전 상태, “나중에 고르기”는 deliberate skip, “연결하지 않음”은 independent start로 분리한다.
5. **개요 자동생성은 검증 없이 과신될 수 있음:** 초안에는 `source='inferred'`/“자료 기반 초안” 배지를 붙이고 사용자가 수정해야 `manual`이 된다.

---

## 1. Evidence — 현재 코드/라이브 UI 확인

### 라이브 UI
- `http://127.0.0.1:5273/` 로그인 후 현재 사이드바 확인.
- `프로젝트 추가` 클릭 시 현재는 좌측 트리 하단 인라인 입력만 열린다.
- 브라우저 콘솔 에러: `0`.

### 현재 구현 위치
- UI 트리/생성 위치: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
  - `InlineCreate` 정의: lines 258-329
  - project create wiring: lines 705-710 (`onSubmit={(name) => createProject.mutate(name)}`)
- web mutation: `apps/web/src/lib/spaces.ts`
  - `useCreateProject`: lines 55-61 — 현재 `name`만 받아 `api.createProject({ workspaceId, name, slug })` 호출
- contract: `packages/contracts/src/spaces.ts`
  - `CreateProjectRequestSchema`: lines 9-13 — 현재 `workspaceId/name/slug`만 허용, strict
  - context edge create/list contract: lines 162-216
- api client: `packages/api-client/src/client.ts`
  - `createProject`: lines 285-290
- backend controller: `apps/api/src/spaces/spaces.controller.ts`
  - `POST /spaces/projects`: lines 285-293
- backend usecase: `apps/api/src/spaces/create-project.usecase.ts`
  - 이미 `applyDefaultTemplate?: boolean`, `tags?: ...`가 내부 command에 있으나 public contract로 노출되지 않음
  - template 적용 분기: lines 78-84
- default project template: `apps/api/src/spaces/project-template.service.ts`
  - `consulting_default` channels/topics/thread spec: lines 66-104
  - template apply: lines 243-331
- graph connection service: `apps/api/src/spaces/context-graph.service.ts`
  - manual edge create: lines 84-129
  - traverse weight: lines 168-178 (`cross_project` = 0.6)
- initial file upload base:
  - contract: `packages/contracts/src/collab.ts` lines 389-430
  - API: `apps/api/src/chat/attachments.controller.ts` lines 52-110
  - UI composer upload: `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx` lines 636-665
- project overview/profile base:
  - `scope_profiles` table schema accepts enum `scope_type` including `project`, but current service/contract only expose `channel | topic`.
  - schema: `packages/db-schema/src/schema/scope-profile.ts`
  - contract: `packages/contracts/src/spaces.ts` lines 130-161

---

## 2. Product decision — Wizard structure

### Recommended modal flow

### 확정 결정 — 연결 강도와 생성 후 수정 가능성
- 주인님 승인: **강하게 연결 = `shares_memory_with`**, **약하게 연결 = `related_to`**로 확정한다.
- 생성 모달의 모든 선택은 “초기값”으로 고지한다. 사용자는 생성 후에도 프로젝트명, 개요/목표, 관련 프로젝트 연결 대상, 연결 강도, 최초 자료 보강/삭제를 바꿀 수 있어야 한다.
- 생성 전 확인 화면과 생성 완료 toast에 반드시 짧게 고지한다: “지금 선택한 이름·연결·자료는 생성 후 프로젝트 설정/자료실에서 다시 바꿀 수 있어요.”
- UX 원칙: 사용자가 생성 순간에 완벽한 결정을 해야 한다고 느끼면 안 된다. wizard는 확정 심사장이 아니라 좋은 시작값을 잡는 도우미다.

#### Step 1 — 기본 정보
Required:
- 프로젝트명

Optional but recommended:
- 한 줄 목표/개요: “무엇을 하려는 프로젝트인가요?”
- 프로젝트 유형/template:
  - 기본값: `컨설팅 기본 구조 만들기` = `consulting_default`
  - 고급: `빈 프로젝트로 시작`

UX rule:
- slug는 화면에 노출하지 않고 서버/클라이언트에서 자동 생성한다.
- 프로젝트명만 입력해도 다음 단계로 갈 수 있어야 한다.
- 하단 보조문구: “프로젝트명과 개요는 생성 후에도 프로젝트 설정에서 바꿀 수 있어요.”

#### Step 2 — 관련 프로젝트 연결
사용자 언어:
- **강하게 연결** — “두 프로젝트의 자료를 자주 함께 참고합니다.”
- **약하게 연결** — “필요할 때 관련 후보로만 보여줍니다.”
- **연결하지 않음** — “독립 프로젝트로 시작합니다.”
- **나중에 고르기** — “지금은 넘기고, 생성 후 추천/수동 연결합니다.”

State model:
```ts
type ConnectionDecision = 'undecided' | 'selected' | 'explicit_none' | 'skip';
type ConnectionStrength = 'strong' | 'weak';
```

Validation:
- `undecided` 상태에서는 다음 버튼 disabled.
- `selected`면 최소 1개 프로젝트 필요.
- 같은 workspace 안의 active project만 표시한다.
- 자기 자신은 생성 전이므로 후보에 없음.

Backend mapping:
- `strong` → `context_edges.edge_type = 'shares_memory_with'`, `origin='manual'`, `confidence=1.0`
- `weak` → `context_edges.edge_type = 'related_to'`, `origin='manual'`, `confidence=0.65`
- `explicit_none` / `skip` → edge 생성 없음

Post-create editability:
- 프로젝트 row menu에 `프로젝트 설정`을 추가한다.
- 설정 modal/tab에서 관련 프로젝트를 추가/삭제하고 strong↔weak을 바꿀 수 있게 한다.
- strong↔weak 변경은 기존 edge를 새 edge type으로 바꾸는 것이 아니라, 기존 manual edge를 tombstone/delete 후 새 type으로 upsert하는 명시적 상태 전환으로 다룬다.
- 연결 화면 보조문구: “연결은 생성 후에도 프로젝트 설정에서 언제든 바꿀 수 있어요.”

YAGNI:
- 별도 `edge_strength` 컬럼은 만들지 않는다. 기존 `edge_type`이 의미를 충분히 담는다.

#### Step 3 — 최초 자료
입력 타입:
- 파일: 이미지/PDF/텍스트/HWP/HWPX, 10MB 이하 — 기존 attachment API 재사용
- 링크: `sourceType='web'` evidence로 저장
- 짧은 메모/붙여넣기: `sourceType='manual'` evidence로 저장

UX copy:
- “자료는 생성 후 `자료수집 > 원문·근거`에 들어갑니다.”
- “문서 분석은 잠시 걸릴 수 있어요. 먼저 프로젝트를 열고, 분석 상태는 자료실에서 보여줍니다.”

Important choice:
- 파일은 final submit 전까지 브라우저 메모리에만 들고 있고, 프로젝트가 성공적으로 생성된 뒤 업로드한다.
- 자료 업로드 실패가 프로젝트 생성을 롤백하지 않는다. 실패 파일별 재시도 UI를 둔다.

#### Step 4 — 확인 및 생성
보여줄 요약:
- 프로젝트명/목표
- 생성될 기본 구조: `자료수집, 분석, 보고서, 질의응답, 대화` 또는 빈 프로젝트
- 연결 선택: strong/weak/none/skip
- 최초 자료 개수: 파일 N개, 링크 N개, 메모 N개
- “자료 기반 개요 초안 만들기” toggle: default ON if 자료 있음, OFF if 자료 없음
- 수정 가능 고지: “생성 후에도 프로젝트명·개요·연결·자료를 다시 바꿀 수 있습니다.”

생성 후 이동:
- 자료가 있으면 `자료수집 > 원문·근거` thread로 이동.
- 자료가 없으면 default `대화 > 기본 대화` 또는 첫 channel thread로 이동.
- 생성 완료 toast: `프로젝트를 만들었어요. 이름·연결·자료는 언제든 다시 바꿀 수 있어요.`

---

## 3. Backend/API design

### 3.1 Contract changes
Modify: `packages/contracts/src/spaces.ts`

Add schemas:
```ts
export const ProjectConnectionDecisionSchema = z.enum(['selected', 'explicit_none', 'skip']);
export const ProjectConnectionStrengthSchema = z.enum(['strong', 'weak']);

export const CreateProjectConnectionSchema = z.object({
  projectId: UuidSchema,
  strength: ProjectConnectionStrengthSchema,
}).strict();

export const CreateProjectProfileSchema = z.object({
  overview: z.string().trim().max(2000).optional(),
  goal: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict();
```

Evolve `CreateProjectRequestSchema`:
```ts
export const CreateProjectRequestSchema = z.object({
  workspaceId: UuidSchema,
  name: NameSchema,
  slug: SlugSchema,
  templateKey: z.enum(['consulting_default', 'blank']).default('consulting_default').optional(),
  connectionDecision: ProjectConnectionDecisionSchema.default('skip').optional(),
  connections: z.array(CreateProjectConnectionSchema).max(20).default([]).optional(),
  profile: CreateProjectProfileSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.connectionDecision === 'selected' && (value.connections?.length ?? 0) === 0) {
    ctx.addIssue({ code: 'custom', path: ['connections'], message: 'selected requires at least one connection' });
  }
  if (value.connectionDecision !== 'selected' && (value.connections?.length ?? 0) > 0) {
    ctx.addIssue({ code: 'custom', path: ['connections'], message: 'connections require selected decision' });
  }
});
```

Evolve response:
```ts
export const CreateProjectResponseSchema = z.object({
  id: UuidSchema,
  templateApplied: z.boolean(),
  defaultThreadId: UuidSchema.nullable(),
  intakeThreadId: UuidSchema.nullable(),
  created: z.object({
    channels: z.number().int().nonnegative(),
    topics: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(),
    consultingLinks: z.number().int().nonnegative(),
    contextEdges: z.number().int().nonnegative(),
  }).strict(),
}).strict();
```

### 3.2 Project profile support
Recommended: expand existing `scope_profiles` from `channel|topic` to `project|channel|topic`.

Modify:
- `packages/contracts/src/spaces.ts`
  - `ScopeProfileScopeTypeSchema = z.enum(['project', 'channel', 'topic'])`
- `apps/api/src/spaces/scope-profile.service.ts`
  - `ScopeProfileScopeType = 'project' | 'channel' | 'topic'`
  - add `project` branch to `resolveLiveScope`
- `apps/api/src/spaces/spaces.controller.ts`
  - optional later endpoints: `GET/PATCH /spaces/projects/:id/profile`

For create flow, `CreateProjectUseCase` can insert profile in the same transaction using `scopeType='project'`.

Profile field mapping:
- `purpose`: overview + goal combined, or generated overview later
- `role`: project type/client context if later added
- `style`: empty for now
- `rules`: notes/constraints
- `source`: `manual` initially; if auto-generated from files later, use `inferred`

### 3.3 CreateProjectUseCase changes
Modify: `apps/api/src/spaces/create-project.usecase.ts`

Add command fields:
```ts
templateKey?: 'consulting_default' | 'blank';
connections?: { projectId: string; strength: 'strong' | 'weak' }[];
connectionDecision?: 'selected' | 'explicit_none' | 'skip';
profile?: { overview?: string; goal?: string; notes?: string };
```

Transaction order:
1. Verify caller has workspace membership in controller, as today.
2. Insert `projects` row.
3. If `templateKey !== 'blank'`, apply `consulting_default`.
4. Resolve `defaultThreadId` and `intakeThreadId` from created/existing template rows:
   - intake target: channel slug `source-collection`, topic slug `source-evidence`, thread title `원문·근거 수집`
   - default chat target: channel slug `conversation`, topic slug `default-chat`, thread title `기본 대화`
5. Persist project profile if profile fields exist.
6. For each connection:
   - resolve target project active + same workspace
   - reject archived/deleted/foreign project
   - create context edge from new project → target project
   - map `strong` to `shares_memory_with`, `weak` to `related_to`
7. Insert audit event with non-secret setup summary:
   - templateKey
   - connectionDecision
   - connectionCount
   - hasProfile
8. Return ids + created counts.

Important:
- Do not upload files in this transaction.
- Do not start Hermes generation in this transaction.

### 3.4 Post-create edit APIs
생성 모달에서 고지한 “나중에 바꿀 수 있음”은 실제 기능으로 받쳐야 한다.

Existing reuse:
- 프로젝트명 변경은 이미 `PATCH /spaces/projects/:id` 경로가 있으므로 재사용한다.
- context edge 조회/생성은 이미 `GET /spaces/context-edges`, `POST /spaces/context-edges`가 있으므로 재사용한다.
- 파일 보강은 intake thread의 기존 attachment flow를 재사용한다.

Add/extend:
- `GET/PATCH /spaces/projects/:id/profile` — 프로젝트 개요/목표/메모 수정.
- `DELETE /spaces/context-edges/:edgeId` — 수동 연결 끊기. 구현은 physical delete보다 `deleted_at` tombstone이 안전하다.
- 선택사항: `PUT /spaces/projects/:id/connections` — 설정 modal에서 보낸 최종 연결 목록으로 manual project edges를 replace한다. MVP에서는 개별 add/delete/change로 충분하면 생략 가능하다.

Frontend edit surface:
- 프로젝트 row menu에 `프로젝트 설정`을 추가한다.
- 설정 modal 탭: `기본 정보`, `연결`, `자료`.
- `기본 정보`: 프로젝트명 + 개요/목표 수정.
- `연결`: 관련 프로젝트 추가/삭제, strong↔weak 변경.
- `자료`: intake thread로 이동하거나 자료실 필터를 열어 추가/삭제 위치를 안내한다.

### 3.5 Materials persistence after project creation
Use existing APIs first:
- Files: `POST /attachments` with returned `intakeThreadId`
- Links/text notes: `POST /chat/evidence` with returned `intakeThreadId`

If `intakeThreadId` is null because user chose blank project:
- UI must either block materials with “기본 구조를 만들 때만 최초 자료를 바로 넣을 수 있어요” OR backend must create a minimal `자료수집` channel/topic/thread.
- Recommendation: if 자료가 있으면 `templateKey='consulting_default'`를 강하게 권장하고, blank+materials는 confirm을 요구한다.

Auto overview phase:
- MVP: store manual overview if user typed it.
- Phase 2: after attachments extraction/evidence insert, run a `ProjectOverviewDraftService` that writes `scope_profiles(project).purpose` with `source='inferred'` only if the user has not edited it manually.
- Never overwrite `source='manual'` profile without explicit user action.

---

## 4. Frontend design

### Files likely to change/create

Create:
- `apps/web/src/widgets/app-shell/ui/ProjectCreateWizard.tsx`
- `apps/web/src/widgets/app-shell/ui/ProjectSettingsModal.tsx`
- `apps/web/src/widgets/app-shell/model/projectCreateWizard.ts`
- `apps/web/src/widgets/app-shell/model/projectCreateWizard.test.ts`
- `apps/web/src/widgets/app-shell/model/projectConnections.test.ts`

Modify:
- `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- `apps/web/src/widgets/app-shell/ui/AppShell.module.css`
- `apps/web/src/lib/spaces.ts`
- `packages/api-client/src/client.ts`
- `packages/contracts/src/spaces.ts`

Maybe modify:
- `apps/web/src/lib/api.ts` only if new API client methods are needed for evidence/material upload helpers.

### UI state model

`projectCreateWizard.ts` should be pure and tested:
```ts
export interface ProjectCreateWizardDraft {
  step: 0 | 1 | 2 | 3;
  name: string;
  overview: string;
  templateKey: 'consulting_default' | 'blank';
  connectionDecision: 'undecided' | 'selected' | 'explicit_none' | 'skip';
  connections: Array<{ projectId: string; strength: 'strong' | 'weak' }>;
  files: File[];
  links: Array<{ url: string; note: string }>;
  notes: string;
  autoOverview: boolean;
}
```

Pure helpers:
- `canGoNext(draft): boolean`
- `canSubmit(draft): boolean`
- `toCreateProjectRequest(draft, workspaceId): CreateProjectRequest`
- `materialCounts(draft)`
- `connectionSummary(draft, projects)`

### AppShell integration
- Replace only project-level `<InlineCreate level="project" ... />` with a button that opens `<ProjectCreateWizard />`.
- Keep channel/topic inline creation unchanged.
- After successful creation:
  1. invalidate `spaceKeys.tree(workspaceId)`
  2. upload files/evidence to `intakeThreadId` if present
  3. navigate to `intakeThreadId ?? defaultThreadId ?? '/'`
  4. toast summary: `프로젝트를 만들었어요. 이름·연결·자료는 언제든 다시 바꿀 수 있어요.`
  5. if 자료가 있으면 secondary toast/progress: `자료 3개를 넣는 중…`
  6. if partial material failures, show non-blocking retry list in modal or toast.

### Modal UX details
- Use existing `DialogRoot/DialogContent`, no backdrop blur.
- Max width around 720–840px; mobile full-width sheet-like behavior.
- Stepper should be calm, not colorful: `기본 정보 → 연결 → 최초 자료 → 확인`.
- Keyboard:
  - Enter on text field should not accidentally submit final create before final step.
  - Esc closes only with dirty-confirm if draft has data/files.
- Accessibility:
  - `aria-current="step"`
  - file input label and error text connected with `aria-describedby`
  - focus first invalid field on submit failure.

---

## 5. Bite-sized implementation plan

### Task 1: Contract RED tests for guided project request
**Objective:** Strict request/response schema supports the wizard payload without accepting inconsistent states.

**Files:**
- Modify: `packages/contracts/src/spaces.ts`
- Test: add/modify contracts tests if present; otherwise add API test coverage in Task 2.

**Checks:**
- `selected` + no connections rejects.
- `explicit_none` + connections rejects.
- valid strong/weak selected accepts.
- response accepts `defaultThreadId/intakeThreadId` nullable.

### Task 2: Backend create usecase maps connections to context_edges
**Objective:** Creating a project can also create strong/weak project links safely.

**Files:**
- Modify: `apps/api/src/spaces/create-project.usecase.ts`
- Test: `apps/api/test/project-create-guided.test.ts`

**Test cases:**
- strong connection creates `shares_memory_with/manual/confidence=1`.
- weak connection creates `related_to/manual/confidence=0.65`.
- archived/foreign target project rejects.
- `explicit_none` and `skip` create zero manual edges.

### Task 3: Backend returns upload/navigation targets
**Objective:** Create response tells frontend where to put initial materials.

**Files:**
- Modify: `apps/api/src/spaces/project-template.service.ts`
- Modify: `apps/api/src/spaces/create-project.usecase.ts`
- Modify: `apps/api/src/spaces/spaces.controller.ts`

**Test cases:**
- `consulting_default` returns non-null `intakeThreadId` and `defaultThreadId`.
- `blank` returns null targets.
- existing template reapply path still resolves ids.

### Task 4: Extend project profile storage minimally
**Objective:** Project overview/goal can be stored and later reused in prompts/UI.

**Files:**
- Modify: `packages/contracts/src/spaces.ts`
- Modify: `apps/api/src/spaces/scope-profile.service.ts`
- Modify: `apps/api/src/spaces/spaces.controller.ts` if adding read/update endpoints now
- Test: `apps/api/test/scope-profile.service.test.ts` or new project profile test

**Test cases:**
- `scope_profiles(scopeType='project')` insert/read works for active project.
- archived/deleted project returns NOT_FOUND.
- create project with profile writes `source='manual'`.

### Task 5: API client + React query mutation accepts full payload
**Objective:** Frontend can call the evolved createProject contract.

**Files:**
- Modify: `packages/api-client/src/client.ts`
- Modify: `apps/web/src/lib/spaces.ts`

**Implementation notes:**
- Change `useCreateProject` mutation input from `name: string` to object payload.
- Keep `toSlug(name)` reuse.
- Invalidate `spaceKeys.tree(workspaceId)` after success.

### Task 6: Pure wizard model tests
**Objective:** Step validation is locked before UI wiring.

**Files:**
- Create: `apps/web/src/widgets/app-shell/model/projectCreateWizard.ts`
- Create: `apps/web/src/widgets/app-shell/model/projectCreateWizard.test.ts`

**Test cases:**
- Step 1 requires name.
- Step 2 undecided blocks next.
- selected requires project.
- explicit_none/skip allows next.
- file count/size validation surfaces error.
- payload maps strong/weak and template/profile correctly.

### Task 7: Build ProjectCreateWizard component
**Objective:** Replace one-line project creation with guided modal.

**Files:**
- Create: `apps/web/src/widgets/app-shell/ui/ProjectCreateWizard.tsx`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.module.css`

**UI requirements:**
- Stepper header.
- Project name + overview.
- Related projects searchable list from `tree.projects` excluding archived/unavailable.
- Strength segmented control per selected project.
- “연결하지 않음” and “나중에 고르기” distinct choices.
- File/link/note input area.
- Final review screen.
- Partial upload failure state.

### Task 8: Integrate wizard into AppShell
**Objective:** Only project creation changes; channel/topic inline creation remains unchanged.

**Files:**
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`

**Steps:**
- Replace project-level `InlineCreate` at lines 705-710.
- Pass `workspaceId`, `projects`, `createProject`, `onNavigate` into wizard.
- On success, navigate to target thread.

### Task 9: Add post-create project settings/edit affordances
**Objective:** The wizard's “나중에 바꿀 수 있어요” promise is true in-product.

**Files:**
- Create: `apps/web/src/widgets/app-shell/ui/ProjectSettingsModal.tsx`
- Create/modify: `apps/web/src/widgets/app-shell/model/projectConnections.ts`
- Modify: `apps/web/src/widgets/app-shell/ui/AppShell.tsx`
- Modify: `apps/web/src/lib/spaces.ts`
- Modify: `packages/contracts/src/spaces.ts`
- Modify: `apps/api/src/spaces/spaces.controller.ts`
- Modify: `apps/api/src/spaces/context-graph.service.ts`

**Acceptance criteria:**
- Project row menu has `프로젝트 설정`.
- User can rename the project from settings using the existing rename mutation.
- User can edit project overview/goal through project profile API.
- User can add/remove related projects.
- User can change a related project from strong to weak or weak to strong.
- Settings modal copy says: “생성 때 고른 값은 초기값이에요. 언제든 다시 바꿀 수 있습니다.”

**Tests:**
- API test: deleting a manual context edge tombstones it and traversal no longer returns it.
- API test: strong↔weak replacement returns only the new edge type.
- Web model test: connection diff computes add/remove/change without duplicate edges.

### Task 10: Initial materials upload flow
**Objective:** First files/links/notes land in the new project's intake thread.

**Files:**
- Possibly modify: `apps/web/src/lib/spaces.ts` for helper
- Reuse: `api.uploadAttachment`, `api.addEvidence`

**Rules:**
- If no `intakeThreadId`, skip upload and show actionable message.
- Files upload sequentially or bounded concurrency=2.
- Links/notes become evidence items.
- A failed material does not undo project creation.

### Task 11: Browser QA and cleanup
**Objective:** Prove the actual modal flow works, not just tests.

**Browser QA scenarios:**
1. Open 프로젝트 생성 modal from sidebar.
2. Step 1: name only → next enabled.
3. Step 2: undecided blocks; explicit none allows; selected+strong/weak works.
4. Step 3: file too large shows error; allowed file is listed.
5. Step 4: create TEST marker project, verify tree shows it and navigates to intake/default thread.
6. Open `프로젝트 설정`, rename project, change connection strength, remove a connection, and verify the tree/settings reflect it.
7. Verify modal/review/toast copy clearly says names, connections, overview, and materials are editable after creation.
8. If marker project was created, archive it via UI or cleanup through approved test path.
9. Console errors remain 0.

---

## 6. Validation commands

Run during implementation, not now:

```bash
pnpm --filter @consulting/contracts typecheck
pnpm --filter @consulting/api test -- project-create-guided.test.ts
pnpm --filter @consulting/api test -- context-graph-activation.test.ts
pnpm --filter @consulting/api test -- scope-profile.service.test.ts
pnpm --filter @consulting/web test -- projectCreateWizard projectConnections
pnpm --filter @consulting/api typecheck
pnpm --filter @consulting/web typecheck
pnpm --filter @consulting/web build
pnpm lint
pnpm typecheck
```

Browser verification:
- dev server: `http://127.0.0.1:5273/`
- Do not kill the user-owned dev server.
- Use real clicks and snapshots; do not rely only on DOM inspection.

---

## 7. Risks / tradeoffs / open questions

### Risks
- `strong = shares_memory_with` may be too powerful if later prompt injection uses it without labels. Mitigation: keep cross-project label and allow unlink.
- Blank project + materials has no natural upload target. Mitigation: recommend default template when materials are present.
- Auto overview from 자료 can hallucinate. Mitigation: mark inferred, never overwrite manual overview.
- File upload after project creation can partially fail. Mitigation: per-file status/retry; do not rollback project.

### Settled decisions before implementation
- Confirmed: **강하게 연결 = `shares_memory_with`**, **약하게 연결 = `related_to`**.
- Confirmed: 프로젝트 생성 wizard의 입력값은 초기 설정이며, 프로젝트명·개요·연결·자료는 생성 후에도 다시 바꿀 수 있어야 한다.

---

## 8. Recommended MVP cut

Do first:
1. Guided modal steps 1-4.
2. Strong/weak project connection via existing `context_edges`.
3. `consulting_default` default template + return `intakeThreadId/defaultThreadId`.
4. Initial files/links/notes saved to intake thread.
5. Manual project overview stored through expanded `scope_profiles(project)`.
6. Project settings modal for post-create rename/profile/connection/material edit affordances.

Defer:
1. Automatic project overview summarizer from uploaded documents.
2. AI-based project 추천 연결.
3. Batch upload progress drawer beyond simple per-file list.

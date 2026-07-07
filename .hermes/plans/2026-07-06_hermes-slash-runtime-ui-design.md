# 설계: consulting-web Hermes Slash/Runtime UI 정비

작성: 2026-07-06 23:52 KST · 지구 · **설계 전용(구현 없음)**

## 결론

- 지금 `consulting-web`의 slash UI는 **진짜 Hermes slash 실행기가 아니라, composer에 `/model` 같은 문자열을 채워 넣는 제안 목록**이다. 결과적으로 `/model`은 TUI/Discord처럼 picker를 여는 게 아니라 `/v1/runs`의 일반 사용자 메시지로 흘러간다.
- Hermes API Server가 현재 안정적으로 제공하는 것은 **run 제출/상태/SSE/중단/승인응답/모델 route alias 조회**다. TUI의 `slash.exec`/`config.set` 같은 제어면은 API Server에 없다.
- 따라서 consulting-web 적용은 “Hermes 모든 slash를 웹에 복제”가 아니라, **웹용 Runtime Command Layer**를 두고 `지원 가능 / 약한 대체 / 미지원`을 명확히 분리해야 한다.
- 1차 구현의 핵심은 네 가지다: **(1) `/model` 웹 picker + per-run model route 적용, (2) `approval.request` 이벤트를 실제 버튼 UI로 노출, (3) `/stop`을 Hermes upstream stop까지 연결, (4) slash 제안을 ‘문자열 삽입’이 아닌 ‘웹 커맨드 실행’으로 바꾸기.**
- 이번 승인 범위에서는 **Hermes native source 수정도 허용**한다. 단, 제품 레이어에서 해결 가능한 것은 consulting-web에서 먼저 해결하고, API Server/TUI/adapter의 실제 한계 때문에 막히는 지점만 Hermes core에 최소 패치한다.
- Hermes core 패치는 업데이트 때 초기화되지 않도록 **기존 local patch 체계에 편입**한다. 즉 `~/.hermes/local-patches/*.patch` + `~/.hermes/scripts/apply_*.sh` + 통합 `hermes_update_preserve_patches.sh`에 등록해 `hermes update` 후 자동 재적용/검증되게 한다.
- 웹 UI는 단순 기능 노출이 아니라 **SaaS-grade command center**로 설계한다. `/model`, 승인, 상태, 중단, 선택지는 모두 세련된 sheet/panel/card/chip으로 제공하고, 키보드·검색·설명·위험도·모바일·다크모드까지 일관된 고급 UX를 목표로 한다.
- slash command는 계속 지원하되 **초보 사용자에게는 버튼/퀵액션/상태바/설정 sheet로 같은 기능을 노출**한다. 즉 `/model`을 몰라도 “모델 변경” 버튼으로 열 수 있고, `/status`를 몰라도 상태 pill 클릭으로 확인할 수 있어야 한다.

---

## 1. 근거 인벤토리

### 1.1 Hermes 본체: command registry

| 사실 | 근거 |
|---|---|
| Slash command의 canonical source는 `COMMAND_REGISTRY`다. CLI help, gateway dispatch, Telegram/Slack/autocomplete가 여기서 파생된다. | `/home/jigoo/.hermes/hermes-agent/hermes_cli/commands.py:1-8`, `:64` |
| 현재 registry는 **82개** command. 범주별: Session 32, Configuration 15, Tools & Skills 18, Info 16, Exit 1. | 로컬 파서 실행 결과 |
| `cli_only`, `gateway_only`, `gateway_config_gate`가 있어 모든 command가 모든 표면에서 같은 의미는 아니다. | `hermes_cli/commands.py:45-58` |
| `/model`, `/reasoning`, `/personality`, `/new`, `/undo`, `/retry`, `/stop`, `/compress`, `/queue`, `/steer`, `/background`, `/goal`, `/subgoal` 등은 registry상 gateway/CLI 공통 가능 command지만, 이것이 곧 API Server `/v1/runs`에서 실행 가능하다는 뜻은 아니다. | `hermes_cli/commands.py:68-158` |

Registry 요약:

| 범주 | total | 공통 | CLI only | gateway only |
|---|---:|---:|---:|---:|
| Session | 32 | 18 | 8 | 6 |
| Configuration | 15 | 8 | 7 | 0 |
| Tools & Skills | 18 | 9 | 9 | 0 |
| Info | 16 | 9 | 5 | 2 |
| Exit | 1 | 0 | 1 | 0 |

### 1.2 Hermes TUI: local slash + overlay 구조

| 사실 | 근거 |
|---|---|
| TUI는 자체 `SLASH_COMMANDS` 배열을 갖고, command 파일들을 합친 뒤 name/alias map으로 찾는다. | `ui-tui/src/app/slash/registry.ts:1-24` |
| TUI command 파일별 command 수: core 23, session 17, ops 13, debug 2, billing/credits/setup 각 1. | 로컬 파서 실행 결과 |
| TUI `/model`은 인자가 없으면 `overlay.modelPicker=true`를 켜서 picker를 연다. | `ui-tui/src/app/slash/commands/session.ts:64-74` |
| TUI `/model <arg>`는 `config.set` RPC를 호출하고, 비싼 모델이면 confirm overlay를 띄운다. | `ui-tui/src/app/slash/commands/session.ts:76-115` |
| TUI overlay renderer는 `overlay.modelPicker`일 때 `<ModelPicker />`를 실제로 렌더한다. | `ui-tui/src/components/appOverlays.tsx:141-188` |
| TUI fallback은 `slash.exec` → 실패 시 `command.dispatch` JSON-RPC로 떨어진다. | `ui-tui/src/app/createSlashHandler.ts:120-145` |

**해석:** TUI의 `/model` 경험은 “slash 문자열을 agent에게 보내는 것”이 아니라 **frontend가 command를 intercept하고 gateway RPC/overlay를 직접 호출**하는 구조다. consulting-web도 같은 원칙을 따라야 한다.

### 1.3 Discord/gateway: native slash + interactive components

| 사실 | 근거 |
|---|---|
| Discord는 `/model`, `/reasoning`, `/personality`, `/stop`, `/steer`, `/compress`, `/title`, `/resume`, `/usage`, `/help`, `/approve`, `/deny` 등을 native app command로 등록한다. | `plugins/platforms/discord/adapter.py:3907-4016` |
| Discord는 registry에서 gateway-available command를 자동 등록하되 100 command cap을 고려한다. | `plugins/platforms/discord/adapter.py:4044-4117` |
| Discord `/model`은 `send_model_picker`로 provider → model 2단계 select menu를 띄운다. | `plugins/platforms/discord/adapter.py:5508-5568`, `:6734-6980` |
| 위험 명령 승인은 `ExecApprovalView` 버튼 4개(once/session/always/deny)로 처리한다. | `plugins/platforms/discord/adapter.py:5269-5315`, `:6412-6504` |
| 일반 slash confirm은 Approve Once / Always Approve / Cancel 3버튼이다. | `plugins/platforms/discord/adapter.py:5316-5353`, `:6523-6620` |
| clarify는 선택지가 있으면 버튼, 없으면 다음 메시지 text capture로 처리한다. | `plugins/platforms/discord/adapter.py:5355-5469` |

**해석:** Discord 표면은 “명령 실행”과 “사용자 입력/승인”을 플랫폼 component로 해결한다. consulting-web은 Discord component를 그대로 쓸 수 없으므로 **동등한 웹 component**를 만들어야 한다.

### 1.4 Hermes API Server: 가능한 것과 불가능한 것

| 사실 | 근거 |
|---|---|
| API Server routes: `/v1/models`, `/v1/capabilities`, `/v1/runs`, `/v1/runs/{id}`, `/events`, `/approval`, `/stop`. Slash execute endpoint는 없다. | `gateway/platforms/api_server.py:4760-4800` |
| `/v1/runs`는 body의 `input`, `instructions`, `session_id`, `model` 등을 읽고 agent run을 시작한다. | `api_server.py:4159-4278` |
| `instructions`는 `ephemeral_system_prompt`로 agent에 주입된다. | `api_server.py:4189`, `:4244`, `:4282-4288` |
| `/v1/runs`의 SSE 이벤트는 `message.delta`, `tool.started`, `tool.completed`, `reasoning.available`, `run.completed/failed/cancelled`, `approval.request/responded`가 핵심이다. | `api_server.py:4113-4157`, `:4292-4317`, `:4384-4398`, `:4535-4621` |
| `tool.completed`는 현재 duration/error만 내보내고 result body는 내보내지 않는다. | `api_server.py:4139-4147` |
| `/v1/models`는 기본 model과 `model_routes` alias만 노출한다. provider credentials는 노출하지 않는다. | `api_server.py:1412-1446` |
| `body.model`은 arbitrary full model switch가 아니라 `model_routes` alias resolve에 쓰인다. route가 없으면 기본 모델을 쓴다. | `api_server.py:1198-1202`, `:1270-1320`, `:4276-4278` |
| `/v1/capabilities`는 run_submission/status/events/stop/approval_response/tool_progress 등을 true로 advertise하지만 admin_config_rw는 false다. | `api_server.py:1448-1501` |

**해석:** consulting-web에서 가능한 native급 기능은 **run control** 중심이다. 전역 `/model` 설정 변경, `/reasoning high` 같은 config mutation, TUI overlay 그대로 호출은 API 표면에 없다.

### 1.5 consulting-web 현재 구조

| 사실 | 근거 |
|---|---|
| composer slash 목록은 `HERMES_SLASH_COMMANDS` 9개 hardcode이며, 선택 시 `setInput(item.value)`만 한다. | `apps/web/src/widgets/chat-thread/ui/ChatThread.tsx:53-63`, `:633-651` |
| Enter 전송은 `api.streamChat({ threadId, message })`로 일반 chat stream을 시작한다. | `ChatThread.tsx:229-303` |
| API client는 `/chat/stream`을 열고 strict `ChatStreamEvent`만 yield한다. | `packages/api-client/src/client.ts:241-254` |
| API server proxy는 `/v1/runs`에 `input`, `session_id`, `instructions`만 보낸다. 현재 `model`은 보내지 않는다. | `apps/api/src/chat/hermes-runs-client.ts:128-157` |
| proxy는 `tool.started/completed`, `reasoning.available`, `run.completed/failed/cancelled`는 처리하지만 `approval.request`는 처리하지 않는다. | `hermes-runs-client.ts:71-115` |
| `ChatStreamEventSchema`에도 approval event가 없다. | `packages/contracts/src/chat.ts:65-72` |
| 현재 약한 선택 UI는 `::choices` fence → chip → 다음 사용자 메시지 전송으로 구현되어 있다. | `apps/web/src/shared/ui/markdown/parseChoices.ts:1-17`, `Markdown.tsx:66-101` |
| `RunStatusBar`는 모델/상태/토큰/reasoning/runId detail popover를 이미 갖고 있다. | `apps/web/src/widgets/chat-thread/ui/RunStatusBar.tsx:37-143` |
| Radix Select/Dialog 공통 primitive가 이미 있다. model picker를 새 dependency 없이 만들 수 있다. | `apps/web/src/shared/ui/select/Select.tsx:1-78`, `shared/ui/dialog/Dialog.tsx:1-108` |

---

## 2. 명령어별 적용 분류

### A. 1차 구현 권장: 웹에서 native하게 지원 가능

| command/기능 | 웹 처리 | 이유 |
|---|---|---|
| `/model` | **문자열 전송 금지.** command intercept → model picker/sheet → 선택 alias를 project/thread runtime preference에 저장 → 이후 `/chat/stream` request에 `model` 포함 | API `/v1/models` + `/v1/runs body.model`로 가능. 단, configured `model_routes` alias만 신뢰 가능 |
| `/status` | 로컬 runtime panel 열기: 현재 thread, 마지막 run, model, tokens, reasoning, API health/capabilities 표시 | 이미 `RunStatusBar`가 있고 `/v1/capabilities`, `/v1/health`, run status로 보강 가능 |
| `/usage` | 마지막 run usage + 누적 thread usage(저장 가능하면) 표시. 전역 billing/credit과 혼동 금지 | Runs API completed event usage는 존재. 전역 provider quota는 별도 API 없음 |
| `/help`, `/commands` | 웹 지원 command만 보여주는 local command reference panel | Hermes registry 전체를 그대로 노출하면 실행 불가능 command가 섞여 UX가 깨짐 |
| `/stop` | 현재 client abort + API proxy가 upstream `/v1/runs/{runId}/stop` 호출 | API Server가 stop route를 제공. 현재는 browser abort만 하므로 upstream agent가 계속 돌 위험 |
| `approval.request` | stream event로 전달 → assistant bubble/composer 위에 승인 카드 → once/session/always/deny 버튼 → proxy가 `/v1/runs/{runId}/approval` 호출 | API Server가 이미 event와 response endpoint 제공. Discord의 `ExecApprovalView`에 대응 |
| `/retry` | 기존 마지막 prompt resend로 처리. Slash command라기보다 client action | `ChatThread`에 `lastPromptRef`와 retry hook이 이미 있음 |

### B. 1차에서 “부분 지원/약한 대체”

| command/기능 | 웹 처리 | 한계 |
|---|---|---|
| `/reasoning show/hide` | **표시 토글**만 local preference로 지원. `reasoning.available` event 표시 여부 제어 | API Server는 per-run reasoning effort mutation을 노출하지 않음. effort 변경은 상류 config 영역 |
| `/personality` | 당장은 미지원 또는 “프로젝트 응답 포맷/톤” 설정으로 별도 설계 | Hermes personality config mutation은 API에 없음. 이미 `instructions`로 consulting format을 주입 중 |
| `/queue` | busy 중 입력을 local queue로 저장해 현재 run 완료 후 자동 전송 가능 | Hermes TUI의 진짜 queue와 다름. 웹 client queue임을 명시 |
| `/steer` | 현재 run 중 “추가 지시”를 별도 out-of-band로 upstream에 넣을 endpoint가 없음. UI만 만들면 거짓 기능 | Hermes API에 steer endpoint 없음. 하지 않는 편이 낫다 |
| `clarify` | 현재처럼 `::choices` chip. 향후 `::approve`, `::form`, `::choices mode=multi`로 확장 | 진짜 blocking resume 아님. 새 사용자 메시지로 이어지는 약한 선택 |
| `/background` | consulting-web product concept과 맞지 않음. 향후 “비동기 작업 카드”로 별도 설계 가능 | Hermes background session 결과를 API로 관리하는 표면 없음 |

### C. 1차 미지원/노출 금지

| command | 이유 |
|---|---|
| `/new`, `/clear`, `/sessions`, `/resume`, `/branch` | Hermes session lifecycle과 consulting DB thread lifecycle이 다름. 잘못 노출하면 사용자가 대화/프로젝트 구조를 오해함 |
| `/undo`, `/compress` | Hermes transcript mutation과 consulting DB message persistence가 불일치. DB message 삭제/압축 정책과 별도 설계 필요 |
| `/yolo` | 위험 승인 정책 변경. 보안 민감. consulting UI에서 일반 사용자에게 노출 금지 |
| `/tools`, `/toolsets`, `/skills`, `/reload-mcp`, `/plugins`, `/curator`, `/kanban` | host/runtime admin 영역. API Server admin_config_rw=false. 노출하면 실행 불가/보안 혼동 |
| `/update`, `/restart` | Hermes runtime 운영/배포 side effect. 명시 승인 없는 웹 UI 노출 금지 |
| `/approve`, `/deny` typed command | 승인 UI는 `approval.request` card로만 처리. 사용자가 임의로 `/approve` 입력하는 UX는 run ownership이 불명확 |
| `/voice`, `/browser`, `/paste`, `/image` | TUI/플랫폼 전용. consulting-web에는 이미 file upload/preview 체계가 있음 |

---

## 3. 목표 아키텍처

### 3.1 원칙

1. **Slash 문자열을 agent에게 그냥 보내지 않는다.** `/model`, `/status`, `/help` 등은 frontend command registry가 intercept한다.
2. **지원 가능성은 API capability에 묶는다.** `GET /v1/capabilities`, `/v1/models`를 backend proxy에서 조회하고, UI는 가능한 command만 enabled로 표시한다.
3. **전역 Hermes 설정은 바꾸지 않는다.** consulting-web은 multi-user/product surface이므로 `/model`도 global config mutation이 아니라 per-project/per-thread run preference로 처리한다.
4. **위험 승인은 typed slash가 아니라 structured event card로 처리한다.** `approval.request` 이벤트가 오면 UI가 버튼을 렌더한다.
5. **미지원 command는 조용히 agent에게 보내지 말고 즉시 설명한다.** 예: “이 명령은 TUI/gateway 전용이라 웹에서는 지원하지 않습니다.”

### 3.2 Web Runtime Command Layer

새 파일 제안:

- `apps/web/src/widgets/chat-thread/model/runtimeCommands.ts`
  - `WEB_RUNTIME_COMMANDS`
  - type: `local_panel | modal | stream_action | insert_template | unsupported`
  - fields: `name`, `aliases`, `label`, `description`, `risk`, `availability`, `execute`
- `apps/web/src/widgets/chat-thread/ui/SlashCommandMenu.tsx`
  - 현재 `ChatThread.tsx` 내부 slash list 분리
  - arrow/tab/enter 동작 유지
  - Enter/Click 시 `setInput`이 아니라 `executeRuntimeCommand`
- `apps/web/src/widgets/chat-thread/ui/ModelPickerSheet.tsx`
  - Radix Dialog/Select 기반
  - `GET /chat/runtime/models` 결과 표시
  - default route + configured aliases만 표시
  - 선택 값은 local/project preference에 저장
- `apps/web/src/widgets/chat-thread/ui/RuntimeCommandPanel.tsx`
  - `/status`, `/usage`, `/commands` 표시
- `apps/web/src/widgets/chat-thread/ui/ApprovalRequestCard.tsx`
  - `approval.request` event rendering

### 3.3 API proxy 확장

Contracts:

- `packages/contracts/src/chat.ts`
  - `ChatStreamRequestSchema`에 `model?: z.string().min(1).max(200).optional()` 추가
  - `ChatStreamApprovalEventSchema` 추가
  - `ChatStreamEventSchema` union에 `approval` 추가
- 새 contract 후보: `packages/contracts/src/runtime.ts`
  - `RuntimeModelSchema`, `RuntimeModelsResponseSchema`
  - `RuntimeCapabilitiesResponseSchema`
  - `RunApprovalRequestSchema`

API client:

- `packages/api-client/src/client.ts`
  - `listRuntimeModels()` → `/chat/runtime/models`
  - `runtimeCapabilities()` → `/chat/runtime/capabilities`
  - `respondRunApproval(runId, choice)` → `/chat/runs/:runId/approval`
  - `stopRun(runId)` → `/chat/runs/:runId/stop`

Nest API:

- `apps/api/src/chat/hermes-runs-client.ts`
  - `startRun(cmd, scope)` body에 `...(cmd.model ? { model: cmd.model } : {})`
  - `readRunEvents`에서 `approval.request` 처리
  - `respondApproval(runId, choice)` 구현 → Hermes `/v1/runs/{runId}/approval`
  - `stopRun(runId)` 구현 → Hermes `/v1/runs/{runId}/stop`
  - `listModels()`, `capabilities()` proxy 구현
- `apps/api/src/chat/chat-stream.controller.ts`
  - `/chat/runtime/models`
  - `/chat/runtime/capabilities`
  - `/chat/runs/:runId/approval`
  - `/chat/runs/:runId/stop`
  - 권한: active run ownership 확인. 최소 구현은 in-memory `activeRuns: runId -> { userId, threadId, workspaceId }` map.

**중요:** approval/stop은 보안·권한 경계다. runId만 알면 아무나 승인하지 못하게, Nest API에서 반드시 현재 사용자와 thread ownership을 확인한다.

### 3.4 Hermes native source 확장 허용 범위

이번 설계에서는 Hermes native source 수정이 승인되었다. 다만 적용 순서는 다음 원칙을 따른다.

1. **제품 레이어 우선:** consulting-web의 frontend/backend proxy에서 해결 가능한 것은 native patch로 보내지 않는다.
2. **최소 core patch:** API Server가 실제로 이벤트/엔드포인트를 누락해서 제품 레이어가 불가능할 때만 Hermes core를 수정한다.
3. **관측 가능한 계약부터:** core 수정은 “웹이 더 예뻐 보이게”가 아니라, 명확한 API 계약을 추가/보강하는 방향이어야 한다.
4. **테스트 동반:** Hermes core patch는 regression test 또는 endpoint contract test가 같이 있어야 한다. 순수 cosmetic TUI patch만 예외다.
5. **업데이트 내구성:** 모든 native patch는 local patch 보존 체계에 등록한다. `~/.hermes/hermes-agent`에 직접 수정만 남기면 update 때 사라진다.

Native patch 후보:

| 후보 | 필요성 | 판단 |
|---|---|---|
| `/v1/runs` `tool.completed.result` 선택적 노출 | 근거/출처 라이브러리의 실제 tool 결과 캡처가 필요할 때 | P1. privacy/redaction/size cap 동반 필수 |
| `/v1/slash/commands` read-only catalog | 웹 command palette가 Hermes registry와 drift 없이 동기화되어야 할 때 | P2. read-only라 비교적 안전 |
| `/v1/slash/execute` 제한 실행 | `/model`, `/reasoning` 등 config/run-control을 웹에서 native 실행해야 할 때 | P3. 권한·admin scope가 크므로 보류 후 별도 설계 |
| structured `interaction.request` / `interaction.respond` | 진짜 blocking clarify/resume이 필요할 때 | P3. API/session state 설계가 커서 제품 검증 후 |
| API Server model route metadata 보강 | alias 설명, 비용등급, 권장 태그를 UI에 보여줄 때 | P1/P2. schema 작고 UX 효과 큼 |

Native patch 금지/보류:

- consulting-web 사용자 액션이 Hermes global config를 직접 바꾸는 패치.
- `/yolo`, `/update`, `/restart`, `/tools` 같은 host admin 기능을 일반 웹 사용자에게 열기 위한 패치.
- 제품 UX 편의를 위해 credential/provider secret을 API에 노출하는 패치.
- 테스트 없이 `~/.hermes/hermes-agent`만 직접 수정하고 끝내는 패치.

### 3.5 local patch 보존 전략

Hermes core 수정이 발생하면 다음 파일 세트를 반드시 만든다.

```text
~/.hermes/local-patches/hermes-api-runtime-interactions.patch
~/.hermes/scripts/apply_hermes_api_runtime_interactions_patch.sh
~/.hermes/scripts/hermes_update_preserve_patches.sh
```

기존 local patch들과 함께 적용되도록 **통합 wrapper**를 사용한다. wrapper는 patch별 스크립트를 배열로 관리한다.

```bash
PATCHES=(
  "~/.hermes/local-patches/langfuse-shutdown-context.patch::~/.hermes/scripts/apply_langfuse_shutdown_context_patch.sh"
  "~/.hermes/local-patches/anthropic-tool-result-order.patch::~/.hermes/scripts/apply_anthropic_tool_result_order_patch.sh"
  "~/.hermes/local-patches/hermes-api-runtime-interactions.patch::~/.hermes/scripts/apply_hermes_api_runtime_interactions_patch.sh"
)
```

필수 동작:

1. update 전 현재 적용된 patch는 `git apply --reverse --check` 후 임시 제거.
2. `hermes update` 실행.
3. 모든 patch apply script를 순서대로 재실행.
4. 실패 시 trap으로 제거했던 patch를 다시 복구.
5. `HERMES_UPDATE_BIN=echo` dry-run으로 실제 update 없이 제거→재적용 round-trip 검증.

개별 apply script 규칙:

- repo 경로 기본값: `~/.hermes/hermes-agent`, env override 허용.
- stable marker grep으로 “이미 적용됨” 판정.
- `git apply --check` 후 `git apply`.
- reverse-check로 “이미 upstream 반영됨”도 성공 처리.
- regression test 파일이 있으면 narrow test 실행.
- 충돌 시 명확히 `manual rebase needed`로 실패.

patch 생성 규칙:

```bash
cd ~/.hermes/hermes-agent
git diff -- gateway/platforms/api_server.py tests/gateway/test_api_server_runtime_interactions.py \
  > ~/.hermes/local-patches/hermes-api-runtime-interactions.patch
```

새 테스트 파일이 untracked이면 반드시 `git add -N tests/...` 후 diff를 뜬다. 그렇지 않으면 patch가 테스트 파일을 빠뜨린다.

### 3.6 SaaS-grade UI/UX 목표

웹 UI는 “터미널 명령을 웹에 옮긴 것”처럼 보이면 안 된다. 목표는 **고급 SaaS command center**다.

구성 원칙:

- **Command Palette:** `/` 입력 시 Linear/Slack식 command palette. 검색, 그룹, 위험도, 지원 여부, 설명, 단축키를 한눈에 표시.
- **Beginner Quick Controls:** slash를 모르는 사용자를 위해 header/composer/status 영역에 `모델 변경`, `상태 보기`, `중단`, `자주 쓰는 선택지` 버튼을 별도로 둔다. slash는 고급 단축 경로이고, 버튼은 발견 가능한 기본 경로다.
- **Model Picker Sheet:** `/model`은 compact sheet. 추천/현재/비용/속도/용도 badge를 보여주고, route alias의 기술명은 detail에 숨긴다.
- **Approval Card:** 위험 명령은 redacted command preview + 영향 설명 + 버튼 3개(`이번만`, `세션`, `거부`) 중심. `항상 허용`은 2차 confirm 또는 고급 설정에 둔다.
- **Run Status Popover:** pill은 짧게, 클릭하면 상세. raw run id는 기본 노출 금지, `기술 정보` 안에서 copy 가능.
- **Choice Chips/Form:** `::choices`는 버튼 chip, multi-select는 tokenized chip, form은 mini-card. 모두 키보드 접근 가능해야 한다.
- **Motion:** 120~180ms micro-interaction, `prefers-reduced-motion` 준수. 큰 blur/backdrop-filter 금지.
- **Dark mode:** hardcoded `#fff`, `rgba(255,255,255,...)`를 token으로 치환. overlay는 blur 대신 plain dim.
- **Hit target:** 모든 row/card/button은 실제 클릭 영역과 시각 영역이 일치해야 한다. `elementFromPoint`/브라우저 클릭 QA로 검증.

추천 visual language:

| 영역 | UI 방향 |
|---|---|
| command palette | Slack/Linear식 리스트, 좌측 icon, 중앙 설명, 우측 shortcut/status badge |
| beginner quick controls | header/composer에 작고 명확한 버튼. `모델 변경`, `상태`, `중단`, `추천 액션`처럼 명령어 지식 없이 클릭 가능 |
| model picker | shadcn/Radix Select + segmented recommendation cards |
| approval | low-saturation amber/red accent, command는 monospace card, destructive color 남발 금지 |
| status | 작은 pill + popover detail, 정보 밀도는 높되 기본 화면은 조용하게 |
| unsupported | disabled row + “웹 미지원/관리자 전용” one-line reason, agent에게 보내지 않음 |

---

## 4. `/model` 설계 상세

### 현재 문제

- UI 목록에는 `/model`이 있지만 선택하면 `setInput('/model')`만 한다.
- 전송하면 `/chat/stream` → Hermes `/v1/runs`의 `input='/model'`로 들어간다.
- TUI처럼 `ModelPicker`를 여는 경로가 전혀 없다.

### 목표 UX

1. 사용자가 composer에서 `/` 입력.
2. `/model` 선택.
3. composer 입력값을 바꾸지 않고 **모델 선택 sheet**를 연다.
4. sheet는 현재 모델과 선택 가능한 route alias를 보여준다.
5. 선택 후 composer 아래 status pill이 `모델: <alias>`로 바뀐다.
6. 다음 run부터 `/v1/runs` body에 `model: <alias>`를 포함한다.
7. run start event/status에서 실제 모델 표시를 확인해 `RunStatusBar`에 반영한다.

### 데이터 한계

- `/v1/models`는 full provider model catalog가 아니라 **기본 모델 + configured `model_routes` alias**만 준다.
- arbitrary `anthropic/claude...` 같은 string을 body.model로 보내도 route가 없으면 `_resolve_route()`가 `None`을 반환한다.
- 따라서 UI 문구는 “모델”보다 “실행 프로필/라우트”가 더 정확할 수 있다. 사용자용 문구는 `모델 선택`, detail에는 `Hermes model_routes alias`를 설명.

### 저장 위치 선택

| 방식 | 장점 | 단점 | 판단 |
|---|---|---|---|
| localStorage per project | DB migration 없음, 빠름 | 기기/브라우저별로 다름 | 1차 추천 |
| user profile DB preference | 사용자별 일관 | schema/API 추가 | 2차 |
| project DB setting | 팀 전체 일관 | 한 사용자의 실험이 팀에 영향 | 기본값으로는 비추천 |

1차는 `consulting.runtime.model.${workspaceId}.${projectId}` localStorage로 충분하다.

---

## 5. 승인 UI 설계 상세

### 현재 문제

Hermes API Server는 `approval.request`를 SSE로 보낼 수 있는데, consulting proxy가 이를 무시한다.

- upstream event: `approval.request`, `choices: ['once','session','always','deny']`
- response endpoint: `POST /v1/runs/{run_id}/approval`
- 현재 contracts에는 approval event가 없음.

### 목표 UX

- Assistant stream 중 위험 command가 필요하면 메시지 하단/ composer 위에 **승인 필요 카드** 표시.
- 카드 내용:
  - 제목: `승인이 필요합니다`
  - command preview: redacted command만 monospace block
  - reason/description
  - 버튼: `이번만 허용`, `이 세션 허용`, `항상 허용`, `거부`
- 버튼 클릭:
  - Nest API `POST /chat/runs/:runId/approval` 호출
  - 성공 시 카드 disabled + “승인됨/거부됨” 상태
  - stream은 계속 이어짐

### 보안 규칙

- command 원문은 upstream에서 이미 redaction되지만, UI도 길이 제한/overflow 처리.
- approval choice는 enum만 허용: `once | session | always | deny`.
- `always`는 위험도가 가장 높으므로 confirm 한 번 더 띄우거나, 1차에서는 숨기고 `once/session/deny`만 노출하는 옵션도 검토.
- run ownership map이 없으면 승인 endpoint를 만들지 않는다.

---

## 6. `/stop` 설계 상세

### 현재 문제

브라우저 cancel은 `AbortController.abort()`만 한다. Nest response close 후 upstream Hermes run이 실제로 멈췄는지 보장하기 어렵다.

### 목표

- `cancel()`은 다음 순서로 동작:
  1. 현재 `runStatus.runId` 확인
  2. `api.stopRun(runId)` 호출(best effort)
  3. `AbortController.abort()` 호출
  4. UI 상태 `중단 요청됨` → `중단됨`
- server는 `/chat/runs/:runId/stop`에서 ownership 확인 후 Hermes `/v1/runs/{runId}/stop` 호출.

---

## 7. Weak 선택 UI 확장 방향

이미 있는 `::choices`는 유지한다.

추가 후보:

```text
::choices mode=multi submit="선택한 항목으로 진행"
- 옵션 A
- 옵션 B
::
```

```text
::approve
label: 이 분석 방향으로 진행할까요?
yes: 진행
no: 보류
::
```

```text
::form
field: 예산 범위 | placeholder=예: 3억~5억
field: 기간 | placeholder=예: 2026년 상반기
submit: 조건 적용
::
```

단, 이것은 **진짜 Hermes clarify resume이 아니라 다음 메시지 전송**이다. UI copy에 “선택 후 다음 답변으로 이어집니다” 정도의 의미를 담는다.

---

## 8. 구현 순서

### Phase 0 — 방어적 정리

- `HERMES_SLASH_COMMANDS` hardcode를 `runtimeCommands.ts`로 이동.
- command item에 `kind`, `supported`, `risk`, `execute` 추가.
- 기존 문자열 삽입 방식은 `unsupported`/`template` command에만 제한.

### Phase 1 — model picker + command panel

- API proxy:
  - `GET /chat/runtime/models`
  - `GET /chat/runtime/capabilities`
- contracts/api-client 추가.
- web:
  - `ModelPickerSheet`
  - `/model` intercept
  - selected model localStorage preference
  - `ChatStreamRequest.model` 전달
- QA: `/model` 선택 시 composer에 `/model`이 남지 않고 sheet가 열리는지 확인.

### Phase 2 — approval event

- `ChatStreamApprovalEventSchema` 추가.
- `HermesRunsClient.streamChat`에서 `approval.request` yield.
- `ApprovalRequestCard` 렌더.
- `POST /chat/runs/:runId/approval` proxy.
- in-memory active run ownership map.
- QA: 위험 command를 유발하는 테스트 prompt로 승인 card 표시/버튼 동작 확인.

### Phase 3 — real stop

- `HermesRunsClient.stopRun` + API endpoint.
- frontend cancel이 upstream stop 호출.
- QA: 긴 실행 중 stop → `/v1/runs/{id}` status가 stopping/cancelled 계열로 바뀌는지 확인.

### Phase 4 — status/help/usage polishing

- `/status` local panel.
- `/commands` local reference.
- `/usage` last run usage panel.
- `RunStatusBar`에 현재 selected model alias와 actual model 차이를 표시.

### Phase 5 — SaaS-grade UI/UX 고도화

- slash palette를 command center로 승격:
  - command grouping: `실행`, `모델`, `상태`, `선택`, `관리자 전용`.
  - 각 command에 icon, 설명, risk badge, availability badge.
  - unsupported command는 disabled row + 이유 표시.
- 초보 사용자용 quick controls 추가:
  - header/status pill의 `모델 변경` 버튼 → 같은 `ModelPickerSheet` 열기.
  - run 중 composer 옆 `중단` 버튼 → 같은 stop action 호출.
  - `상태` pill 클릭 → `/status`와 같은 runtime detail panel.
  - 자주 쓰는 선택/응답 포맷은 chip/button으로 노출하고 slash는 고급 단축키로 유지.
- model picker 고급화:
  - 현재 선택, 추천 route, 속도/품질/비용 성격 badge.
  - route alias 기술명은 detail/tooltip에 숨기고 사용자 문구는 쉬운 이름 사용.
- approval card 고급화:
  - command preview는 redacted + 줄바꿈 + overflow-safe.
  - `이번만 허용`, `이 세션 허용`, `거부`를 기본 3버튼으로 구성.
  - `항상 허용`은 기본 숨김 또는 2단 confirm.
- status/help panel 고급화:
  - raw run id는 `기술 정보` disclosure 안에 넣고 copy button 제공.
  - unavailable metric은 `n/a`로 표시하고 가짜 context/quota 수치 금지.
- 브라우저 QA는 실제 click/hit-test, keyboard navigation, mobile width, dark mode까지 포함.

### Phase 6 — Hermes native patch 필요성 판정

제품 레이어 구현 후에도 아래가 막히면 Hermes core patch로 승격한다.

- `/v1/runs`가 필요한 event payload를 누락한다.
- model route metadata가 부족해 UI가 alias만 보여줄 수밖에 없다.
- 진짜 blocking interaction/resume이 제품 요구사항으로 확정된다.
- read-only slash catalog가 없어 command registry drift가 커진다.

각 native patch는 별도 mini-design을 작성한다.

| patch | core file 후보 | test 후보 |
|---|---|---|
| run event payload 보강 | `gateway/platforms/api_server.py` | `tests/gateway/test_api_server_runs_events.py` |
| slash catalog endpoint | `gateway/platforms/api_server.py`, `hermes_cli/commands.py` | `tests/gateway/test_api_server_slash_catalog.py` |
| interaction request/respond | `gateway/run.py`, `gateway/platforms/api_server.py` | 별도 state-machine test |
| model route metadata | config/model route resolver 주변 | route serialization contract test |

### Phase 7 — local patch persistence

- `~/.hermes/local-patches/hermes-api-runtime-interactions.patch` 생성.
- `~/.hermes/scripts/apply_hermes_api_runtime_interactions_patch.sh` 생성.
- 기존 통합 wrapper `~/.hermes/scripts/hermes_update_preserve_patches.sh`의 `PATCHES` 배열에 등록.
- dry-run:

```bash
HERMES_UPDATE_BIN=echo ~/.hermes/scripts/hermes_update_preserve_patches.sh
```

- 검증 기준:
  - patch reverse remove → fake update → reapply 성공.
  - regression test 통과.
  - `git diff --check` 또는 문법 검사 통과.
  - `grep '^diff --git'`로 patch에 code+test 파일 모두 포함 확인.

### Phase 8 — weak choice extensions

- `parseChoiceBlock` 확장 또는 새 parser(`parseInteractionBlocks`) 추가.
- multi-select/form/approve chip UI.
- format contract 또는 skill nudge에 출력 규약 추가.

---

## 9. 검증 명령

로컬 offline gate:

```bash
pnpm -C packages/contracts build
pnpm -C packages/api-client build
pnpm -C apps/api typecheck
pnpm -C apps/web typecheck
pnpm -C apps/api lint
pnpm -C apps/web lint
pnpm -C apps/web build
pnpm -C apps/api test
```

Hermes native patch gate가 추가되는 경우:

```bash
cd ~/.hermes/hermes-agent
pytest tests/gateway/test_api_server_runtime_interactions.py -q
bash -n ~/.hermes/scripts/apply_hermes_api_runtime_interactions_patch.sh
~/.hermes/scripts/apply_hermes_api_runtime_interactions_patch.sh
HERMES_UPDATE_BIN=echo ~/.hermes/scripts/hermes_update_preserve_patches.sh
```

브라우저 QA:

1. composer에 `/` 입력 → command list 표시.
2. `/model` 선택 → model picker opens, composer에 `/model` 문자열이 남지 않음.
3. model alias 선택 → 다음 run의 status에 선택 alias/actual model 표시.
4. `/status`, `/commands`, `/usage`는 chat message를 만들지 않고 panel/sheet로 열린다.
5. long run 중 `중단` → upstream stop 호출, UI가 중단됨으로 정리.
6. 위험 command prompt → approval card 표시 → `이번만 허용/거부` 버튼 동작.
7. 미지원 command(`/tools`, `/update` 등)는 즉시 “웹 미지원/관리자 전용” 안내.
8. 모바일 폭에서도 sheet/popup이 composer/sidebar에 가려지지 않음(portal/fixed positioning 확인).
9. `/model` sheet에서 keyboard navigation, Esc close, focus return이 정상 동작.
10. dark mode에서 approval/card/sheet에 흰색 artifact 또는 blur smear가 없음.
11. command palette의 visible row와 실제 click target이 일치.
12. slash를 모르는 사용자가 `모델 변경` 버튼, 상태 pill, `중단` 버튼만으로 같은 기능을 수행할 수 있음.

Docker/prod 주의:

- 현재 consulting-web은 docker-served backend일 수 있으므로 source 수정 후 prod QA는 **컨테이너 rebuild 승인 후** 진행한다.
- 컨테이너가 오래된 strict Zod schema를 서빙하면 새 event가 parse 실패할 수 있다. contracts → api-client → api/web build 순서를 지킨다.

---

## 10. 리스크와 결정 필요 사항

| 리스크/질문 | 판단 |
|---|---|
| Hermes full model catalog가 API에 없음 | `model_routes` alias 기반 UI로 시작. full catalog는 upstream/API 확장 없이는 보류 |
| `/reasoning high` 같은 effort 변경 | API admin config mutation이 없어 1차 보류. local show/hide만 가능 |
| `always approve` 노출 | 보안상 1차에서는 숨기거나 2단 확인 권장 |
| active run ownership in-memory | 서버 재시작 시 live approval/stop은 유실 가능. live run 제어라 허용 가능. 장기적으로 DB active_runs 필요 |
| slash 전체 노출 욕심 | 실행 불가 command가 UX를 망친다. 웹 지원 subset만 노출 |
| TUI/Discord와 100% 동일 UX 요구 | API 표면이 달라 불가능. 동일한 “원칙”(intercept + component + structured event)을 웹 방식으로 구현 |
| Hermes native source 수정 | 이번 범위에서 허용. 단, 제품 레이어가 불가능한 경우만 최소 patch + test + local patch wrapper 등록 |
| local patch update 충돌 | `hermes_update_preserve_patches.sh`에 기존 patch들과 함께 등록하고 dry-run으로 remove→update→reapply 검증 |
| UI가 기능만 있고 조잡해질 위험 | Phase 5를 별도 UI/UX gate로 분리. sheet/card/palette/panel의 visual QA를 구현 완료 조건에 포함 |

---

## 11. 하지 말 것

- `/model`, `/status`, `/commands`를 그냥 chat message로 보내지 말 것.
- API Server에 없는 `/slash.exec` endpoint를 consulting-web 내부에서 있는 척하지 말 것.
- Hermes global config를 consulting-web 일반 사용자 액션으로 바꾸지 말 것.
- `/yolo`, `/update`, `/restart`, `/tools` 같은 운영 command를 일반 command palette에 노출하지 말 것.
- approval을 run ownership 확인 없이 runId만으로 처리하지 말 것.
- `model` field에 arbitrary full model id를 넣으면 동작한다고 가정하지 말 것. 현재는 `model_routes` alias 중심이다.
- Hermes core를 수정하고 patch 파일/적용 스크립트/통합 update wrapper 등록 없이 끝내지 말 것.
- 기존 local patch wrapper를 복제해서 patch마다 wrapper를 늘리지 말 것. 반드시 통합 `PATCHES` 배열에 편입한다.
- UI를 단순 form/select/button 나열로 끝내지 말 것. 선택 흐름은 사용자가 이해하기 쉬운 sheet/card/palette 중심으로 설계한다.

---

## 12. 최종 우선순위

1. **P0:** slash menu를 command registry 기반으로 분리하고 `/model`을 sheet로 intercept.
2. **P0:** `ChatStreamRequest.model` → Hermes `/v1/runs model` 전달.
3. **P0:** `approval.request` event/schema/UI/proxy 추가.
4. **P0:** cancel이 upstream `/stop`까지 호출하게 수정.
5. **P0:** command palette/model picker/approval card/초보자 quick controls를 SaaS-grade UI로 고도화하고 browser hit-test까지 통과.
6. **P1:** `/status`, `/usage`, `/commands` local runtime panels.
7. **P1:** 미지원 command 안내 UX.
8. **P1:** 제품 레이어로 막히는 지점만 Hermes native patch 후보로 판정.
9. **P1:** native patch가 생기면 `~/.hermes/local-patches` + apply script + 통합 update wrapper에 편입.
10. **P2:** `::choices` 확장(`multi`, `approve`, `form`).
11. **P3:** upstream Hermes API에 `/v1/slash/commands`/`execute`/native interaction resume 제안 — local patch로 검증 후 upstream PR/제안.

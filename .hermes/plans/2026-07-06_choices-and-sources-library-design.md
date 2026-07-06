# 설계: 사용자 선택 UI(clarify) + 자료 라이브러리 + 근거 연결 (Round 11)

작성: 2026-07-06 · 지구 · **설계 전용(구현 없음)**
대상: `consulting-web` (apps/web, apps/api, packages/contracts, packages/db-schema)

이 문서는 주인님 두 질문에 대해 **현재 코드 실측 → 설계**만 담는다. 구현·배포는 별도 승인 후.

---

## 0. 실측 요약 (코드 근거)

| 사실 | 근거 파일 |
|---|---|
| Hermes Runs SSE 이벤트 = `message.delta / tool.started·completed / reasoning.available / run.completed·failed·cancelled` **뿐**. clarify/interaction 이벤트 **없음** | `apps/api/src/chat/hermes-runs-client.ts:51-95` |
| 진짜 중단형 선택 UI를 띄울 API 훅이 상류에 없음(startRun→events 단방향, respond 엔드포인트 없음) | 동 파일 `startRun` 108-125, `readRunEvents` 152-187 |
| 이미 배포된 "약한" 선택 UI = 마크다운 `::choices` 칩(클릭 시 다음 메시지 전송) | `apps/web/src/shared/ui/markdown/parseChoices.ts`, `Markdown.tsx` |
| **자료는 이미 3계층으로 DB에 쌓임** | 아래 |
| ① evidence_items: gbrain/web/file/tool 자동 캡처 + 수동. `messageId`로 답변과 연결됨 | `chat/evidence.store.ts`, `db-schema/.../collab.ts:13` |
| ② file_attachments + document_extractions: 업로드 문서 원문+추출텍스트 | `chat/attachments.controller.ts`, `collab.ts:167,204` |
| ③ artifacts + artifact_versions: 확정 산출물(버전관리·PDF/DOCX export) | `artifacts/artifact.store.ts` |
| **그러나 세 자료 모두 thread(대화) 스코프로만 조회 가능.** 프로젝트/채널/워크스페이스 단위 "쌓인 자료 전체 보기" API·UI **없음** ← 주인님이 느낀 공백 | evidence: `GET /chat/threads/:id/evidence`, attachments: `GET /attachments/threads/:id`, artifacts만 workspace 스코프 존재 |
| 근거-답변 연결은 evidence에 한해 이미 존재(hover glow E-4, `messageId` FK) | `EvidencePanel.tsx`, `VirtualMessageStream` hoveredMessageStore |
| gbrain 도구 사용 = evidence의 `gbrain` 소스로 자동 분류 | `evidence.store.ts:15 classifyTool` |

**결론 두 줄:**
- Q1(선택 UI): 상류 미지원이라 **네이티브 중단형은 불가**, 현재의 `::choices` 칩이 최선. 확장은 "약한 선택"을 더 리치하게(승인/다중선택/폼).
- Q2(자료 보기): 데이터는 이미 다 쌓이는데 **thread에 갇혀 있음**. 프로젝트/워크스페이스 단위로 모아 보는 **자료 라이브러리**를 새로 세우면 즉시 가치. 근거 연결도 evidence 링크를 답변 인라인 각주로 승격하면 완성.

---

## Q1. 사용자 선택 UI — 무엇이 가능한가

### 현재 상태 (사실)
- Hermes가 `clarify` 도구로 만드는 "선택지 제시→사용자 선택→run 재개"를 **Runs API가 구조화 이벤트로 노출하지 않음.** (GitHub #2971 미구현.)
- 우리가 지금 가진 것: `::choices` 마크다운 규약 → 칩 렌더 → 클릭 시 그 텍스트가 **새 사용자 메시지로 전송**(=새 turn, 진짜 resume 아님). 이미 구현·배포됨.

### 설계: 3단 확장 (상류 의존도 순)

**A. 지금 당장 가능 (백엔드 무변경) — `::choices` 리치화**
현재 파서는 단순 선택지만 지원. 확장 규약(하위호환):
```
::choices [mode=single|multi] [submit=자동전송문구]
1. 옵션 A
2. 옵션 B
::
```
- `mode=multi`: 체크박스형 다중선택 → "선택 완료" 버튼으로 조합 전송.
- `::approve` 전용 블록: 예/아니오 승인 칩(위험작업 확인 UX).
- `::form` 블록: 짧은 입력 폼(예산 범위 등)을 채워 한 메시지로 전송.
- 파서는 순수함수(TDD) 유지, 미완 fence는 null(스트리밍 안전) — 기존 원칙 그대로.
- 한계 명시: 여전히 "새 turn 전송"이지 run 중단·재개가 아님.

**B. 반(半)-네이티브 (백엔드 계약만 확장, 상류 대기 없음)**
- 지구(Hermes) 쪽에서 답변 말미에 `::choices`를 **일관되게 출력하도록 스킬/시스템프롬프트로 유도** → 프론트는 A만으로 충분히 "선택형 대화" 경험.
- 우리 API가 `session_id=consulting-thread:*`로 run을 걸므로, 스킬 주입은 우리 통제 범위. (별도 문서: 컨설팅 응답 스킬에 "선택지가 있으면 ::choices로" 규약 추가.)

**C. 진짜 중단형 clarify (상류 지원 필요 — 대기)**
- 조건: Hermes Runs API가 `interaction.requested`(prompt, options, interactionId) 이벤트 + `/v1/runs/:id/respond` 재개 엔드포인트 노출(#2971).
- 그때 우리가 할 일(계약 자리만 미리 문서화):
  - `packages/contracts`: `ChatStreamEvent`에 `{type:'interaction', kind:'clarify'|'approval', prompt, options[], interactionId}` 추가.
  - `hermes-runs-client.ts`: 업스트림 `interaction.requested`→매핑, 사용자의 선택을 `/respond`로 되돌려 run 재개.
  - UI: 스트림 중 선택 카드(라디오/버튼) 렌더→선택 시 respond→같은 run이 이어서 진행(새 turn 아님).
- **지금은 A/B만 구현 권장. C는 placeholder만.**

### 권장
- **A(리치 `::choices`) + B(스킬 유도)** 를 다음 구현 대상으로.
- C는 Hermes #2971 머지 감지 시 승격.

---

## Q2. 자료 라이브러리 + 근거 연결 — 핵심 신규 기능

### 문제 정의
컨설팅을 하며 자료(gbrain 근거, 업로드 문서, 산출물)가 계속 쌓이는데, **대화 하나하나 안에 흩어져** 있어 "창원 컨설팅 관련 자료 전체"를 한눈에 볼 곳이 없다. 그리고 지구가 답할 때 **어떤 자료를 근거로 썼는지**가 대화 밖에서 추적 불가.

### 설계 2트랙

---

### 트랙 1 — 자료 라이브러리 (Sources Library)

thread에 갇힌 자료를 **프로젝트/워크스페이스 단위로 집계**해 보여주는 새 화면.

**1-1. 백엔드 (집계 read API 신설, 기존 테이블 재사용 — 스키마 변경 최소)**
- `GET /library/workspaces/:wsId/sources?projectId=&type=&q=&cursor=`
  - evidence_items + file_attachments(+extraction) + artifacts를 **UNION 집계**해 통합 목록 반환.
  - 각 행: `{ kind: 'evidence'|'attachment'|'artifact', id, title, sourceType, projectId, channelId, threadId, snippet, url?, createdAt, messageId? }`
  - 필터: 프로젝트, 종류(gbrain/web/file/문서/산출물), 키워드(한글 초성 검색 재사용 — 이미 `parseChoices` 옆에 hangul matcher 있음).
  - 정렬: 최신순 / 종류별.
- 테넌시: 기존 `space-access`/`requireThreadRead` 패턴으로 워크스페이스 멤버십 검증.
- **스키마 변경 없음(집계 뷰/쿼리만).** 단, thread→channel→project 조인이 필요(G10에서 이미 join 경로 확보).

**1-2. 프론트 (신규 라우트 `/_app.library`)**
- 좌: 필터 레일(프로젝트 · 종류 · 검색).
- 중: 자료 카드 리스트(종류 아이콘 + 제목 + 스니펫 + 출처 채널/대화 + 날짜). 무한스크롤(기존 virtualization 패턴 재사용).
- 우: 자료 상세(문서면 추출 텍스트/다운로드, evidence면 원문 excerpt+출처 링크+"이 근거가 쓰인 답변으로 이동", artifact면 뷰어로 딥링크).
- 사이드바에 "산출물 보관함" 옆 **"자료실"** 워크스페이스 툴 1줄 추가(round4 Slack 스타일 원칙 준수 — 카드 아님, flat row).
- 대화→자료 딥링크: 자료 카드의 "출처 대화 열기"가 `/th/:threadId` + `targetMessageId`로 점프(기존 search jump 인프라 재사용).

**1-3. 확장 여지 (지금 설계에 자리만)**
- gbrain 원장 직접 브라우징(우리 evidence 캡처 외에, gbrain MCP를 프로젝트별로 조회). 상류 gbrain 접근 계약 필요 → placeholder.
- 자료 태깅/즐겨찾기(evidence_items에 `tags text[]` 추가 시 — 나중).
- 자료→산출물 원클릭(선택 근거들을 모아 새 artifact 초안 생성).

---

### 트랙 2 — 답변 ↔ 근거 인라인 연결 (Citations)

지금 evidence는 우측 패널에서 hover glow로만 연결. 이걸 **답변 본문 안 각주**로 승격.

**2-1. 데이터 (이미 있음 — messageId FK)**
- evidence_items.messageId 로 답변 메시지와 이미 연결. 추가 스키마 불필요.

**2-2. 렌더 설계**
- assistant 메시지 렌더 시 그 `messageId`의 evidence 개수를 뱃지로 표시(`🔖 근거 3`).
- 클릭 → 우측 패널 "근거" 탭이 해당 evidence만 필터링해 표시(기존 EvidencePanel 재사용 + `messageId` 필터 파라미터 추가).
- (확장) 지구가 답변 안에 `[^1]` 스타일 각주 마커를 달면, 그 마커를 evidence 행에 매핑해 인라인 각주로 렌더. → 이건 Q1-A의 `::choices`처럼 **마크다운 규약 + 스킬 유도**로 구현(백엔드 무변경).

**2-3. 근거 신뢰 표시 (이미 필드 있음)**
- evidence_items에 `qualityScore`/`qualitySignals` 컬럼 존재(현재 미사용). 근거 카드에 신뢰도 뱃지로 노출 → "근거로 말하는 컨설팅" 정체성 강화.

---

## 구현 우선순위 (권장, 승인 후)

```
P1. 트랙1-1/1-2  자료 라이브러리 (백엔드 집계 API + /library 화면)   ← 가장 큰 체감 가치
P2. 트랙2-2      답변별 근거 뱃지 → 우측 패널 필터 (messageId)        ← 저비용·고효과
P3. Q1-A         리치 ::choices (multi/approve/form) + 스킬 유도       ← 대화 UX 강화
P4. 트랙2-2확장  ::cite 각주 규약 + qualityScore 뱃지                  ← 정체성 마감
--  Q1-C, 트랙1-3(gbrain 원장 직결)  = 상류(Hermes/gbrain) 계약 대기, placeholder만
```

## 스키마 변경 요약
- **P1·P2·P3: 스키마 변경 0** (기존 테이블 집계 + 마크다운 규약 + 프론트).
- P4 태깅/즐겨찾기 도입 시에만 `evidence_items.tags` 등 additive 컬럼(나중, 별도 승인).

## 리스크 / 열린 결정
1. **자료 라이브러리 집계 성능**: evidence+attachment+artifact UNION은 워크스페이스 규모 커지면 무거움 → 커서 페이지네이션 + 종류별 인덱스(이미 thread/workspace 인덱스 존재) 활용. 초기엔 프로젝트 스코프 기본.
2. **gbrain 원장 직접 노출 범위**: 우리가 캡처한 evidence만 보여줄지(안전), gbrain 전체를 프로젝트 필터로 브라우징할지(강력하지만 상류 계약·권한 필요). → 1차는 캡처 evidence만, gbrain 직결은 P-대기.
3. **근거 각주 규약(P4)**: 지구가 각주를 항상 달지 보장 못함(Q1과 같은 한계). 규약 미준수 시 뱃지(P2)로 폴백.
4. **"자료실" 명칭**: 산출물(확정 결과물) vs 자료실(근거·원천). 두 개를 하나로 합칠지 분리할지 — 분리 권장(성격 다름: 산출=output, 자료=input/evidence).

## 검증 계획 (구현 시)
- 백엔드: 집계 API 계약 테스트(종류별 필터·커서·테넌시 격리), 빈 워크스페이스/대량 자료 경계.
- 프론트: /library 실화면(필터·검색·딥링크 점프), 근거 뱃지 클릭→패널 필터, 리치 choices 파서 TDD.
- 루트 게이트(typecheck/lint/test/build) + prod 재빌드 후 실화면 QA.

---

## 다음 단계
이 설계에서 **어디까지·어떤 순서로** 구현할지 주인님 결정 필요:
- (a) P1 자료 라이브러리부터 (권장)
- (b) P2 근거 뱃지부터 (가장 저비용)
- (c) P3 리치 choices부터 (대화 UX)
- (d) 순서·범위 조정

---

# 추가 심층 발견 (2차 코드 파기 — 놓쳤던 부분)

1차 설계 후 evidence/attachment/extraction/chat-stream 파이프라인을 더 파보니 **설계를 바꿀 만한 사실 8건**이 나왔다.

### F1. 🔴 gbrain 근거는 "제목만" 저장되고 실제 컨설팅 자료 본문은 안 담긴다
- `chat-stream.controller.ts:189-191`: SSE에서 **`tool.started`의 preview만** `toolUses`에 담고, `tool.completed`(도구 결과)는 안 담는다.
- `hermes-runs-client.ts:58-69`: preview는 `upstream.preview`(≤500자)만 매핑.
- 결과: gbrain 근거 행의 `excerpt`가 **"무엇을 검색했나(쿼리)"**일 뿐 **"무엇을 찾았나(결과 본문)"**가 아니다. → 자료 라이브러리에서 gbrain 근거를 열어도 알맹이가 없다.
- **설계 영향(중요):** P1/트랙2가 의미 있으려면 `tool.completed`의 결과 텍스트도 캡처해야 함. 단 Hermes가 `tool.completed`에 결과 preview를 실어 보내는지 **상류 확인 필요**(현재 클라이언트는 tool 이름만 매핑, completed의 결과 본문 필드 미확인). → **선행 조사 항목**으로 승격.

### F2. 🟢 document_extractions.textContent = 이미 완전한 "문서 원문 검색 인덱스"인데 노출이 0
- `document-extraction.service.ts:54`: 업로드 문서의 추출 텍스트를 **최대 200K자**까지 pg에 저장(`textContent`). HWP/HWPX/PDF/OCR(한글)까지 처리.
- 그런데 이 `textContent`는 **어떤 API로도 노출 안 됨.** attachments 목록은 status/글자수/품질만 주고 본문은 안 준다(`attachments.controller.ts:116-134`).
- **놓친 기회:** 자료 라이브러리의 "문서 전문 검색"이 사실상 공짜다. `textContent`에 대한 ILIKE/전문검색만 얹으면 **업로드한 창원 자료 전체를 키워드로 관통 검색** 가능. → P1에 "문서 본문 검색" 하위기능 추가.

### F3. 🔴 문서 근거는 messageId=null → 답변에 영영 연결 안 됨
- `document-extraction.service.ts:65`: 업로드 문서를 evidence로 넣을 때 `messageId: null`.
- 즉 트랙2(답변별 근거 뱃지)는 **업로드 문서 근거를 절대 못 잡는다**(gbrain/web 자동근거만 잡음). 지구가 그 문서를 근거로 답해도 연결 끊김.
- **설계 영향:** 트랙2를 "답변 시점에 사용된 문서까지" 연결하려면, 스트림 중 지구가 참조한 attachment를 answer messageId로 되엮는 로직 필요(F1과 같은 뿌리 — 도구 결과 캡처). 1차 트랙2는 자동근거만 대상임을 명시해야 함.

### F4. 🟡 evidence 중복 폭증 위험 — 라이브러리 UX 설계 전제
- `evidence.store.saveRunEvidence`: 한 답변에서 gbrain을 5번 부르면 evidence 5행. dedup 없음.
- 자료 라이브러리에서 그대로 나열하면 "같은 쿼리 반복"이 도배됨. → **집계 시 (sourceType+ref+url) 그룹핑/최근우선 dedup**을 API에 넣어야 함(1차 설계엔 없던 요구).

### F5. 🟡 소프트삭제·중복은 걸러도 "품질 0/실패 문서"는 살아있음
- 실패한 추출(`status:failed`, textChars=0)도 evidence로는 안 들어가지만(서비스 61행 가드), attachment 행은 남음.
- 라이브러리에서 문서 종류를 보여줄 때 **추출 실패 문서를 어떻게 표시할지**(숨김 vs "추출 실패" 뱃지) 결정 필요. round 원칙(실패 투명) 상 **뱃지로 노출** 권장.

### F6. 🟢 근거→답변 역방향 점프는 인프라가 이미 다 있다
- evidence.messageId + 기존 search-jump(`focusMessage`/`targetMessageId`, G6에서 방금 다듬음)만 재사용하면 "이 근거가 쓰인 답변으로 이동"이 **거의 무료**. 트랙2-2의 딥링크는 신규 코드 최소.

### F7. 🟡 세션 매핑상 gbrain '컨설팅 자료'가 실제로 조회되는지는 스킬/프롬프트에 달림
- `hermes-runs-client.ts:114`: run은 `session_id=consulting-thread:<threadId>`로 걸린다. 지구가 gbrain을 **부를지 말지**는 상류 스킬/프롬프트 결정. 즉 "근거 자동 축적"은 지구가 실제로 gbrain을 조회할 때만 발생.
- **설계 영향:** 창원 자료가 라이브러리에 쌓이려면 (a) 지구가 답변 시 gbrain을 조회하도록 유도 + (b) F1(결과 본문 캡처) 둘 다 필요. → 트랙1의 "gbrain 근거" 가치는 F1 해결에 종속. **문서 업로드 근거(F2)는 F1과 무관하게 지금 바로 가치** → P1 1차 범위를 **문서·산출물 우선, gbrain 근거는 F1 후**로 재정렬 권장.

### F8. 🟢 notifications에 이미 deep-link(refType/refId) 체계 존재
- 자료 라이브러리의 "새 자료 알림"(예: 문서 추출 완료, 새 산출물)을 붙일 때 기존 notifications 테이블(refType: thread|artifact|workspace) 재사용 가능. `library` refType만 추가하면 됨(additive).

---

## 재정렬된 우선순위 (2차 발견 반영)

```
P0(선행조사) Hermes tool.completed 이벤트에 도구 결과 본문이 실리나?  ← F1 확인. 라이브러리 gbrain 근거 가치의 전제
P1  자료 라이브러리 = 문서(textContent 검색) + 산출물 먼저.           ← F2, 지금 바로 가치 (gbrain 근거는 F1 후)
    · 집계 API에 (sourceType+ref+url) dedup(F4), 실패문서 뱃지(F5)
P2  답변별 근거 뱃지 → 패널 필터 (자동근거 한정, 딥링크는 F6로 거의 무료)
P3  리치 ::choices (multi/approve/form) + 스킬 유도
P4  ::cite 각주 + qualityScore 뱃지
--  F1(도구 결과 캡처)  = P0 결과가 "실린다"면 트랙1/2를 gbrain까지 확장
--  F3(문서→답변 연결), Q1-C(중단형 clarify)  = 상류/구조 확장 대기
```

## 놓쳤던 핵심 3줄
1. **문서 원문(textContent, 200K자)이 이미 DB에 다 있는데 노출이 0** → 자료 라이브러리 "문서 전문 검색"은 사실상 공짜다(F2). 이게 가장 큰 미발굴 자산.
2. **gbrain 근거는 지금 "쿼리 제목"만 저장** → 알맹이(결과 본문)를 담으려면 상류 `tool.completed` 캡처 조사(P0/F1)가 선행. gbrain 근거 라이브러리는 그 다음.
3. **근거→답변 역점프 인프라는 이미 완비**(F6) → 트랙2 딥링크는 거의 무료. 반면 문서근거는 messageId=null이라 답변 연결 불가(F3) — 1차 트랙2는 자동근거 한정임을 명확히.

---

# 3차 심층 발견 (권한·삭제·검색·메모리 축)

트랙1이 "워크스페이스 전체 자료 집계"인 순간 터지는 지점들. 다중사용자·컨설팅 실환경 기준.

### F9. 🔴 소프트삭제가 evidence/attachment/artifact로 전파 안 됨 → "유령 자료" 확정
- `space-mutate.service.ts:58-81 softDeleteNode`: project→channel→topic→thread까지만 `deletedAt` 전파. **evidence_items / file_attachments / document_extractions / artifacts는 건드리지 않음.**
- thread는 FK `onDelete:cascade`지만 **소프트삭제(deletedAt)는 cascade가 아님**(하드 delete만 cascade). 즉 채널을 지워도 그 안의 근거·문서·산출물 행은 `deletedAt=null`로 살아있음.
- **영향(치명):** 현재는 자료가 thread 스코프 조회라 안 드러났지만, **워크스페이스 집계 라이브러리를 만드는 순간 삭제된 채널의 자료가 그대로 노출됨.** → 집계 쿼리는 **부모(thread→channel→project)의 deletedAt까지 조인 검사**해야 함(G10에서 확보한 조인 경로 재사용). 단순 `evidence.deletedAt IS NULL`로는 부족.

### F10. 🔴 file_attachments.dataBase64가 같은 테이블에 인라인 → 목록 쿼리 메모리 폭탄
- `collab.ts:181`: 첨부 원본이 `dataBase64 text`로 **첨부 테이블 본문에 인라인**. 10MB 파일 = 13.7MB 문자열/행.
- 라이브러리 집계에서 attachment를 `SELECT *` 하거나 조인하면 **수백 MB가 pg→api로 빨려옴.** 기존 attachments 목록(`attachments.controller.ts:99`)이 `dataBase64`를 select 안 하는 건 우연이 아님 — 반드시 컬럼 명시.
- **설계 규칙:** 집계 API는 절대 `dataBase64`/`textContent` 전체를 목록에 넣지 말 것. 목록=메타+스니펫(≤200자), 본문=상세 별도 엔드포인트(지연 로드). (F2의 문서검색도 `textContent` ILIKE는 하되 반환은 스니펫만.)

### F11. 🟡 권한이 워크스페이스 멤버십 단일 게이트 — 채널별 격리 없음
- `spaces.controller.ts:53-64`: tree/members가 `workspaceMember`만 확인. 채널·프로젝트 단위 read 권한 세분화 없음(role-matrix도 `channel.read`는 있으나 스코프별 grant는 미구현).
- **영향:** 자료 라이브러리가 워크스페이스 전체를 모으면 **워크스페이스 멤버 누구나 모든 프로젝트 자료를 봄.** 창원 컨설팅에 외부 협력자를 viewer로 초대하면 다른 프로젝트 자료까지 노출.
- **설계 결정 필요:** 1차는 "워크스페이스=한 팀" 전제로 전체 노출 허용(현행과 동일 수준) or 프로젝트별 필터를 권한으로 승격(스코프 membership 필요 — 큰 작업). → 1차는 현행 수준 유지 + **프로젝트 필터는 UI 편의**로만, 권한 격리는 P-대기로 명시.

### F12. 🟡 검색 아키텍처가 "JS 필터 2000행 캡" — 워크스페이스 스케일에서 한계
- `chat-message.store.ts:90-93`: 한글검색이 thread당 최근 2000행을 pg에서 뽑아 **JS에서 `hangulMatch` 필터**. thread 스코프라 지금은 OK.
- **영향:** 자료 라이브러리 검색을 같은 방식(워크스페이스 전체 evidence+문서 텍스트를 JS로)으로 하면 **수만 행×200K자를 메모리로 끌어옴 → 터짐.** 
- **설계:** 라이브러리 검색은 pg-side로. 1차는 `ILIKE`(ref/excerpt/textContent) + 인덱스. 한글 초성/합성 검색까지 원하면 pg 확장(pg_trgm 또는 초성 생성 컬럼) 필요 — 단, gbrain은 별 store라던 원칙처럼 여기도 "JS 캡 방식 재사용 금지"가 핵심. `hangulMatch`는 **로드된 페이지 하이라이트 용도로만** 재사용.

### F13. 🟢 evidence.addManual은 이미 범용 삽입구 — 문서 evidence가 라이브러리의 1급 시민
- `document-extraction.service.ts:62`가 이미 문서를 evidence(sourceType:'file')로 넣음. 즉 **업로드 문서는 evidence 테이블에도 이미 들어와 있음**(attachment + evidence 이중 표현).
- **영향(설계 단순화):** 라이브러리 집계를 **evidence_items 단일 테이블 중심**으로 짜면 gbrain·web·file(문서)이 한 곳에 모임. attachment는 "원본 다운로드/추출상태"용으로만 조인. artifacts만 별도 UNION. → 3-way UNION(1차 설계)보다 **evidence 중심 + artifact 보강**이 더 단순하고 정합적.
- 단 F3(문서 evidence의 messageId=null)과 F4(중복) 여전히 적용.

### F14. 🟡 evidence 하드 상한 없음 + 매 답변 삽입 → 장기 누적 테이블 비대
- `saveRunEvidence`가 매 답변마다 무제한 insert, TTL·상한 없음. 컨설팅 장기 사용 시 evidence_items가 최대 테이블이 됨.
- **설계 자리:** 라이브러리 도입과 함께 (a) dedup(F4)로 표시 억제, (b) 장기적으로 오래된 tool 근거 아카이빙 정책 고려(P-대기). 지금 스키마 변경은 안 하되 문서에 리스크로 남김.

---

## 최종 재정렬 우선순위 (3차 반영)

```
P0(선행조사)  Hermes tool.completed에 도구 결과 본문 실림 여부 (F1)
P1  자료 라이브러리 (evidence 중심 집계, F13):
      · 소스 = evidence_items(gbrain/web/file) + artifacts, attachment는 조인 보강
      · 삭제 정합성: 부모 thread→channel→project deletedAt 조인 필수 (F9)  ★놓치면 유령자료
      · 목록엔 dataBase64/textContent 금지, 스니펫만 (F10)               ★놓치면 메모리폭탄
      · 검색은 pg-side ILIKE, JS 2000행 캡 재사용 금지 (F12)             ★놓치면 스케일붕괴
      · dedup (sourceType+ref+url) (F4), 실패문서 뱃지 (F5)
      · 문서 전문검색(textContent ILIKE→스니펫) (F2)
P2  답변별 근거 뱃지 → 패널 필터 (자동근거 한정 F3, 딥링크 F6 무료)
P3  리치 ::choices (multi/approve/form) + 스킬 유도
P4  ::cite 각주 + qualityScore 뱃지
--  권한 채널격리(F11), evidence 아카이빙(F14), gbrain 결과캡처(F1), 중단형 clarify(Q1-C) = 대기/승인
```

## 3차 놓쳤던 핵심 (치명 3, 단순화 1)
- **치명 F9:** 소프트삭제가 자료로 전파 안 됨 → 라이브러리 만들면 삭제된 채널 자료가 부활. **부모 deletedAt 조인 필수.**
- **치명 F10:** 첨부 base64가 테이블 인라인 → 목록에서 본문 컬럼 select 금지(메모리 폭탄).
- **치명 F12:** 현재 검색은 JS 2000행 캡 방식 → 워크스페이스 스케일엔 pg-side ILIKE 필수, JS 방식 재사용 금지.
- **단순화 F13:** 문서가 이미 evidence로 이중 저장됨 → 3-way UNION 대신 **evidence 중심 집계**가 더 정합적·단순.

---

# 4차 심층 발견 (알림 실시간성 · gbrain 원장 직결 · export 재사용 축)

주인님이 지목한 3축을 코드 실측. **가장 큰 반전: F1 재정의** — gbrain 결과 본문 미저장 원인이 "상류 미지원"이 아니라 **우리 컨트롤러 1줄** 이었다. 그리고 **알림 인프라가 3차 문서 작성 이후 Web Push까지 확장됨**(F8 전제가 바뀜).

## 축 0. F1 재정의 🔴 — gbrain 결과 본문 병목은 상류가 아니라 우리 컨트롤러다

3차까지 F1은 "Hermes `tool.completed`에 결과 본문이 실리나? = P0 상류조사"였다. 실측하니 다르다.

- `hermes-runs-client.ts:58-69`: 우리 프록시는 이미 `tool.started` **와** `tool.completed` **둘 다** `{type:'tool', phase, tool, preview}`로 매핑해 yield한다. completed의 preview도 그대로 통과된다.
- `chat-stream.controller.ts:189-191`: **그런데 evidence로 캡처할 때 `parsed.phase === 'started'` 인 것만** `toolUses.push()` 한다. **`completed`는 버려진다.**
- 즉 결과 본문(preview)이 상류→우리 프록시까지는 오는데, **우리 controller가 started만 주워담아** excerpt가 "쿼리 제목"이 되는 것. `saveRunEvidence`(evidence.store.ts:49)는 그 preview를 그대로 excerpt로 쓴다.
- **설계 영향(P0 재정의):** F1은 "상류 대기"가 아니라 **우리 쪽 수정 가능 항목**으로 승격. 단 두 갈래로 나뉜다:
  - (a) **여전히 상류 확인 필요한 것 1가지:** Hermes가 `tool.completed` 이벤트에 `preview` 필드로 **도구 결과 본문**을 싣는지(현재 `HermesRunSseEvent.preview`는 `unknown`, started의 인자 프리뷰일 수도 있음). → **P0 조사 대상은 이 한 줄로 좁혀짐**: "completed 이벤트의 preview 내용물이 결과인가 인자인가".
  - (b) 만약 결과가 실린다면: `controller.ts:189`를 `started`→`started|completed`로 바꾸고 **동일 tool의 started/completed를 병합**(started=쿼리, completed=결과)해야 evidence 1행에 쿼리+결과가 함께 담긴다. dedup(F4)과 맞물림.
- **주의:** completed도 무조건 담으면 evidence가 답변당 2배로 늘어남(started+completed 각 1행) → **tool 단위 병합 필수**, 안 하면 F4/F14 악화.

## 축 1. 알림 실시간성 🔴🟢 — 30초 폴링은 충분, 그러나 라우팅이 'thread' 단일 하드코딩

**F15 🔴 — 알림 라우팅이 `refType==='thread'` 단일 분기 2곳에 하드코딩 → 'library' 추가 시 클릭이 죽는다**
- 계약: `contracts/collab.ts:140` `refType: z.enum(['thread','artifact','workspace'])` + `NotificationSchema.strict()`(145) → **'library' 값은 스키마가 거부.** `NotificationType` enum도 4종 고정(collab.ts:126-131).
- 인앱 클릭: `NotificationBell.tsx:40-44` — `if (n.refType === 'thread')` **일 때만** navigate. artifact/workspace/library는 **닫히기만 하고 이동 없음**(현재 artifact 알림도 클릭해도 안 감 = 기존 버그).
- 웹푸시 URL: `notification.store.ts:52` `const url = input.refType === 'thread' ? '/th/'+refId : '/';` → **thread 아니면 전부 '/'로.** SW(`sw.js:206-222`)는 이 url을 그대로 열므로 라이브러리 알림 눌러도 홈으로.
- **설계 결론:** 라이브러리 "새 자료" 알림을 붙이려면 **3파일 동시 확장**이 최소 단위 —
  1. `contracts/collab.ts`: `refType` enum에 `'library'`, `NotificationType`에 `'library_source'` 추가(additive, .strict 유지).
  2. `notification.store.ts:52`: url 매핑을 `thread→/th/:id`, `artifact→/artifacts?id=`, `library→/library?focus=`로 **분기 테이블화**(현재 3항 연산자로는 확장 불가).
  3. `NotificationBell.tsx:43`: 클릭 라우팅도 같은 테이블 재사용. **덤으로 artifact 알림 클릭 버그(F15-b)도 같이 고쳐짐.**
- `typeIcon`(NotificationBell.tsx:11-16)은 미등록 시 `'info'` fallback(78행)이라 graceful — 아이콘만은 추가 안 해도 안 깨짐.

**F16 🟢 — 30초 폴링으로 충분 + Web Push가 이미 배포되어 있음(F8 전제 갱신)**
- 3차 F8 시점엔 "notifications 폴링만" 이었으나, **2026-07-06에 Web Push 계층이 추가됨**: `push.service.ts`(best-effort 팬아웃, VAPID 없으면 no-op degrade), `sw.js:188-222`(push/notificationclick 핸들러), `push.ts`(클라 토글), 계약 `PushSubscribe*`(collab.ts:164-180), prod 배선(`docker-compose.prod.yml:78-80`).
- `collab.ts:67-74` 폴링 간격 `refetchInterval: 30_000` 그대로. `notification.store.ts:8-11` 주석 "no joins at read time, cheap to poll" — 폴링 유지가 설계 의도.
- **판단:** 라이브러리 새 자료(문서 추출 완료·산출물 등록)는 **본질적으로 배치성·비실시간** → 30초 폴링 + 기존 Web Push 재사용으로 **충분. 웹소켓 불필요**(collab.ts 주석 "by design" 유지). 새 알림 타입은 `notifyWorkspace()`에 `refType:'library'`로 태워 보내면 in-app·push 양쪽 자동 팬아웃(F15의 url 분기만 고치면).
- **비용:** 알림 실시간성 축은 **신규 인프라 0, F15의 3파일 additive 확장만.** 새 자료 이벤트를 어디서 쏠지(문서 추출 완료 = `document-extraction.service` 후크, 산출물 = 이미 `artifact_version` 존재)만 결정.

## 축 2. gbrain 원장 직결 🔴 — 주인님 원칙상 '캡처 evidence만', 직결은 거부

**F17 🔴 — gbrain 원장 직접 브라우징은 "★듀얼스토어=물리미러링거부·3층위" 원칙 위반**
- 세션 매핑: `hermes-runs-client.ts:114` run은 `session_id=consulting-thread:<threadId>`로 걸린다. 이건 **Hermes run 세션 id**일 뿐, gbrain 원장(PostgreSQL 5433/gbrain)의 `facts.session_id`/page store와 **동일 축이 아니다.** 우리 evidence는 우리 앱 DB(pg, consulting own)에 별도 적재된다.
- 직결 시 3중 문제:
  - **권한:** gbrain 도구 상당수가 local-only(예: `get_recent_transcripts`는 remote 거부). 우리 앱은 Hermes를 HTTP 프록시로 부르므로 gbrain 원장 직독 경로가 없음 → 새 gbrain 접근 계약·크레덴셜 필요(비침습 원칙 위반 소지).
  - **격리:** gbrain은 주인님 "단일자산·store/topic 격리" 원칙. consulting 프로젝트 필터로 gbrain 전체를 브라우징하면 다른 topic(창원 외)까지 노출 위험. `session_id=consulting-thread:*` 로 필터해도, 그 세션에서 지구가 조회한 것과 gbrain에 원래 있던 것의 경계가 모호.
  - **매핑:** 프로젝트↔gbrain 세션 1:1 보장 없음(한 thread가 여러 gbrain 세션 건드릴 수 있고, 반대로 gbrain 페이지엔 우리 threadId 개념 없음).
- **설계 결론(원칙 준수):** 라이브러리는 **우리가 캡처한 evidence_items만** 보여준다(1차 안 유지). gbrain 원장 직결은 **물리 미러링에 해당하므로 거부**, placeholder도 "원칙상 보류(대기 아님)"로 격하. 대신 evidence의 gbrain 근거 **본문**을 F1(축0) 수정으로 채우는 게 정도(正道) — 원장을 긁어오는 게 아니라, 지구가 실제 인용한 것만 3층위(캡처→표시→export)로.
- **부수 효과:** 이 판단이 F7(가치가 F1에 종속)을 강화한다. gbrain 근거 라이브러리의 가치는 원장 직결이 아니라 **F1 결과캡처**로 실현된다.

## 축 3. export 파이프라인 재사용 🟢 — 근거 묶음 PDF는 저비용, 순수함수라 재사용 쉬움

**F18 🟢 — ArtifactExportService.export()는 artifact 비종속 순수함수 → 근거 묶음에 그대로 재사용 가능**
- `artifact-export.service.ts:26` 시그니처 `export({title, versionNo, content, format})` — **입력이 markdown 문자열뿐, artifact 엔티티에 종속되지 않음.** Typst→WeasyPrint→Chromium 폴백(57-70), 한글 CJK CSS(179), `%PDF-` 검증(155), 좌측정렬·풀폭표 CSS(180-186)까지 **주인님 보고서 취향(좌정렬+풀폭표)에 이미 부합.**
- **설계:** 라이브러리 "근거 묶음 내보내기" = 선택된 evidence 행들의 `ref/excerpt/url/createdAt`을 **markdown으로 조립 → 같은 export() 호출.** 신규 코드는 **"evidence[]→markdown 조립기" 하나뿐**, PDF 엔진 로직은 100% 재사용.
- DOCX도 동일 무료(pandoc 경로 37행).

**F19 🟡 — export 컨트롤러는 artifact 권한 스코프 → 라이브러리 export는 새 엔드포인트 + F10 캡 필요**
- `artifacts.controller.ts:68-102` export는 `artifactWorkspace(id)`→`workspaceMember` 권한으로 게이트. **evidence 묶음엔 이 경로가 없음** → `GET /library/.../export` 신규 엔드포인트 필요(워크스페이스 멤버십 + 부모 deletedAt 검사 F9 재사용).
- **F10 재적용:** 조립기가 evidence excerpt(≤4000자, evidence.store.ts:49)만 쓰면 안전하지만, 문서 evidence를 원문(document_extractions.textContent 200K자)까지 펼쳐 묶으면 **PDF 폭탄.** → 묶음 export는 **excerpt/스니펫 기준, 원문 전개는 옵트인 + 개수 상한**(예: ≤50건, 총 ≤2MB) 가드.
- 재사용 난이도: **낮음.** 엔진·CSS·검증 전부 재활용, 신규는 조립기+엔드포인트+권한체크뿐.

---

## 4차 놓쳤던 핵심 (반전 1, 확정 3)
- **반전 F1(축0):** gbrain 결과 본문 병목은 상류가 아니라 **우리 `chat-stream.controller.ts:189`가 `started`만 캡처**. P0가 "상류 대기"에서 "completed preview 내용물 1건 확인 + 우리 병합 로직"으로 좁혀짐. 단 무병합 담기는 evidence 2배 부작용.
- **확정 F15(축1):** 알림 라우팅이 `refType==='thread'` 단일 하드코딩(store:52 + Bell:43 + 계약 enum) → 'library' 추가는 **3파일 additive 확장**. 덤으로 artifact 알림 클릭 죽는 기존 버그도 동시 수정.
- **확정 F16(축1):** Web Push가 이미 배포됨(F8 전제 갱신) → 라이브러리 알림은 30초 폴링+기존 push 재사용으로 충분, **웹소켓·신규 인프라 0.**
- **확정 F17(축2):** gbrain 원장 직결 = 물리 미러링·격리 위반 → **원칙상 거부**, 캡처 evidence만. gbrain 근거 가치는 F1 수정으로 실현.
- **확정 F18/19(축3):** export는 순수함수라 근거 묶음 PDF **재사용 쉬움**, 신규는 조립기+엔드포인트뿐. 단 F10(원문 전개 시 메모리) 캡 필수.

---

## 최종 재정렬 우선순위 (4차 반영)

```
P0(선행조사, 축소됨)  Hermes tool.completed의 preview 내용물 = 결과본문인가 인자인가? (F1/축0)
      · 결과면: controller.ts:189를 started|completed 캡처 + tool단위 병합(무병합 시 evidence 2배)
P1  자료 라이브러리 (evidence 중심 집계, F13):
      · 소스 = evidence_items(gbrain/web/file) + artifacts, attachment는 조인 보강
      · 삭제 정합성: 부모 thread→channel→project deletedAt 조인 필수 (F9)   ★유령자료
      · 목록엔 dataBase64/textContent 금지, 스니펫만 (F10)                ★메모리폭탄
      · 검색은 pg-side ILIKE, JS 2000행 캡 재사용 금지 (F12)              ★스케일붕괴
      · dedup (sourceType+ref+url) (F4), 실패문서 뱃지 (F5), 문서 전문검색 (F2)
P2  답변별 근거 뱃지 → 패널 필터 (자동근거 한정 F3, 딥링크 F6 무료)
P2.5 라이브러리 "새 자료" 알림 = notifyWorkspace refType:'library' (F16 폴링/푸시 재사용)
      · 선행: F15 3파일 additive(계약 enum + store url분기 + Bell 라우팅) ★안하면 클릭사망
      · 덤: artifact 알림 클릭 버그 동시수정
P3  리치 ::choices (multi/approve/form) + 스킬 유도
P3.5 근거 묶음 export = evidence[]→markdown 조립 → ArtifactExportService.export() 재사용 (F18)
      · 신규 엔드포인트 GET /library/.../export + 워크스페이스권한 + F9 deletedAt
      · F10 캡: excerpt 기준, 원문 전개는 옵트인+상한(≤50건/≤2MB) (F19)
P4  ::cite 각주 + qualityScore 뱃지
--  권한 채널격리(F11), evidence 아카이빙(F14) = 대기/승인
--  gbrain 원장 직결(F17) = ★원칙상 거부(물리미러링), 대기 아님
--  중단형 clarify(Q1-C) = 상류(#2971) 대기
```

## 축별 한 줄 판단
- **알림 실시간성:** 30초 폴링 충분(웹소켓 불필요), 단 라우팅 `thread` 하드코딩 3파일 확장이 전제. Web Push는 이미 있음.
- **gbrain 원장 직결:** 원칙(물리미러링거부) 위반 → 거부. 캡처 evidence만, 본문은 F1로 채움.
- **export 재사용:** 순수함수라 근거 묶음 PDF 저비용 재사용, 신규는 조립기+엔드포인트+F10캡뿐.

---

# 5차 심층 발견 (P0 상류 실측 확정 + 문서추출 훅 + 검색 인덱스 전략)

4차의 P0("completed preview가 결과인가 인자인가")를 **Hermes 코어 소스 직독으로 확정**했다. 결론부터: **결과 본문은 코어까지 도달하지만 `/v1/runs` SSE 엔드포인트가 버린다.** 우리 앱만으로는 못 고친다.

## P0 확정 🔴🔴 — gbrain 결과 본문은 3단 관문 중 마지막 두 관문에서 버려진다

실측 경로(코어→엔드포인트→우리앱) 3층 전부 확인:

**1층(코어): 결과 본문은 콜백에 실려 있다 ✅**
- `hermes-agent/agent/tool_executor.py:877-881` 및 `:1545-1549`: `tool_progress_callback("tool.completed", function_name, None, None, duration, is_error, result=function_result)` — **`result=function_result`로 도구 결과 전문이 콜백에 전달됨.** 즉 코어 레벨엔 결과가 있다.

**2층(엔드포인트): `/v1/runs`가 result를 이벤트에 안 싣는다 🔴 (여기가 진짜 병목)**
- `hermes-agent/gateway/platforms/api_server.py:4139-4147` `_make_run_event_callback`: `tool.completed` 이벤트를 `{event, run_id, timestamp, tool, duration, error}`로만 만든다. **콜백이 받은 `result`/`preview`를 이벤트에 넣지 않음.** `**kwargs`에서 `duration`·`is_error`만 뽑고 `result`는 버려짐.
- 대조군: **다른 엔드포인트는 preview를 싣는다.** `api_server.py:1966-1971`의 세션 chat-stream 콜백(`/api/sessions/.../chat/stream`)은 `tool.completed`에 `preview`를 실어 보냄. 즉 **Hermes가 `/v1/runs`에서만 결과를 누락** — 우리가 쓰는 게 하필 `/v1/runs`(hermes-runs-client.ts:109 `POST /v1/runs`).
- 4차 F1(a)의 답: completed의 preview는 **애초에 `/v1/runs`엔 존재하지 않는다**(started만 preview 있음, api_server.py:4137). 우리 클라이언트(hermes-runs-client.ts:61)가 completed의 preview를 매핑해도 상류가 안 보내므로 항상 undefined.

**3층(우리앱): started만 캡처 🟡 (2·1층이 막혀 무의미)**
- `chat-stream.controller.ts:189` `phase==='started'`만 push — 하지만 2층에서 completed에 내용이 없으니 이 줄을 고쳐도 소용없음.

**F20 🔴 결론 — gbrain 결과 본문 라이브러리는 우리 앱 단독으로 불가, Hermes 코어 3줄 수정이 전제**
- 필요한 최소 상류 수정: `api_server.py:4139-4147`의 `tool.completed` 이벤트에 `"preview": (kwargs.get("result") or "")[:N]` 한 줄 추가(세션 chat-stream이 이미 하는 방식). **이건 Hermes 본체 수정** → 주인님 원칙 "작업 repo 정체 확인"에 따라 **consulting-web이 아니라 hermes-agent 변경**. 비침습 원칙상 별도 승인 대상.
- 대안(우리 통제 범위, 상류 무수정): **지구가 답변 말미에 근거를 `::cite`/명시 요약으로 남기도록 스킬 유도**(Q1-B와 동형). 결과 본문을 이벤트에서 못 캐면, 지구가 텍스트로 인용하게 만드는 우회.
- **설계 반영:** P0를 "조사"에서 **"상류 3줄 수정(hermes-agent) or 스킬 우회 — 택1"**로 확정. P1(문서·산출물 라이브러리)은 이와 **완전 독립**하게 지금 가치 실현(F2 재확인). gbrain 근거 본문만 P0에 종속.

## 축 4. 문서추출 훅 = "새 자료" 알림 발화점 🟢🟡

**F21 🟢 — 문서 추출 완료 지점이 이미 명확 → 알림 발화 1줄 추가 위치 확정**
- `attachments.controller.ts:82-90`: 업로드 직후 `documentExtraction.indexAttachment()` **동기 await**. 이 호출이 끝나면 `document_extractions` 행 + evidence 행이 확정됨.
- `document-extraction.service.ts:61-74`: `status==='indexed'`일 때만 evidence 적재. → **여기가 "새 자료 추가됨" 알림의 자연 발화점**(indexed 분기 안에서 `notifyWorkspace({refType:'library'})` 호출).
- **설계:** P2.5 알림은 이 indexed 분기에 훅. F15(라우팅 3파일)만 선행하면 in-app+push 자동 팬아웃. 산출물은 이미 `artifact_version` 알림 존재하므로 라이브러리 알림은 **문서 추출 완료만 신규**.

**F22 🟡 — 추출이 업로드 요청을 동기 블로킹 → 대용량/OCR 문서는 업로드 응답 지연**
- `attachments.controller.ts:82` `await indexAttachment` → PDF OCR(`document-extraction.service.ts:129-133` pdftoppm 250dpi + tesseract)은 **수초~수십초** 소요. 그동안 업로드 HTTP 응답이 안 돌아옴(spawnSync 동기, service.ts:196).
- **영향:** 라이브러리에 "추출 중" 상태를 보여주려면 현재 구조론 불가(추출 끝나야 응답=행 생성). 비동기화하면 "pending→indexed" 상태 전이 + 그 시점 알림이 자연스러움.
- **설계 결정:** 1차는 현행 동기 유지(단순), 라이브러리엔 이미 완료된 것만 표시. 비동기 추출 큐 + "추출 중" 뱃지(F5의 실패뱃지와 한 세트)는 **P-대기**(스키마에 status 이미 있음, service.ts:11 'indexed|skipped|failed' → 'pending' 추가 시). 이게 F22.

## 축 5. 라이브러리 검색 인덱스 전략 🔴 — 현재 JS 2000행 캡의 정확한 한계와 pg-side 설계

**F23 🔴 — 현재 검색은 thread당 최근 2000행 JS 필터, 워크스페이스 집계엔 3중으로 부적합**
- `chat-message.store.ts:85-111 searchMessages`: `.limit(2000)`로 뽑아 JS `hangulMatch`로 필터(90-98행). thread 스코프라 현재는 OK.
- 라이브러리(워크스페이스 전체 evidence+문서)에 그대로 쓰면:
  1. **2000행 캡**: 워크스페이스 evidence가 2000행 넘으면 오래된 자료가 검색에서 사라짐(F14 누적과 결합 시 확정적).
  2. **200K자×N행 메모리**: 문서 evidence의 excerpt는 4000자로 잘려있으나(evidence.store.ts:49), 문서 전문검색(F2)을 하려면 `document_extractions.textContent`(200K자)를 봐야 함 → JS로 끌어오면 F10/F12 동시 폭발.
  3. **정렬 불가**: JS 필터는 관련도 랭킹 없이 최근순 컷.
- **설계(pg-side 3단):**
  - **1차(P1): pg `ILIKE`** — `evidence.ref/excerpt ILIKE '%q%'` + `document_extractions.textContent ILIKE '%q%'`(반환은 스니펫만, F10). 한글 정확일치·부분일치 커버. 인덱스: `evidence(workspaceId, createdAt)` 이미 있음(스키마), textContent엔 **초기엔 인덱스 없이 seq scan 허용**(프로젝트 스코프로 범위 축소).
  - **2차(P-대기): pg_trgm GIN** — `CREATE EXTENSION pg_trgm` + `gin(textContent gin_trgm_ops)`로 부분일치 가속. 한글 trigram도 동작(자모 아닌 완성형 기준).
  - **3차(P-대기): 초성검색** — 현재 JS `isChosungQuery`(chat-message.store.ts:96) 수준을 pg로 옮기려면 초성 생성 컬럼(generated column) 필요. **1차 범위 밖.**
- **핵심 규칙 재확인(F12):** `hangulMatch` JS 캡 방식은 **라이브러리에서 재사용 금지.** 단 "이미 로드된 목록 페이지 안에서의 하이라이트"용으론 재사용 가능(표시 계층). 검색 자체는 pg.

**F24 🟡 — evidence.excerpt(4000자)와 document.textContent(200K자)의 이중 검색 대상 → 검색 UX 분리 필요**
- 같은 문서가 evidence(excerpt 4000자, store.ts:49)와 document_extractions(textContent 200K자, service.ts:54) 양쪽에 있음(F13/F2). 검색 시 어느 쪽을 긁을지가 정확도를 가름.
- **설계:** 라이브러리 검색은 **문서 종류는 textContent(전문), gbrain/web 근거는 evidence.excerpt**를 대상으로 하는 **소스별 분기 검색**. 결과는 통합 랭킹. 안 하면 문서 전문검색(F2의 핵심 가치)이 4000자 컷에 막힘.

---

## 5차 놓쳤던 핵심 (확정 5)
- **★확정 F20(P0):** gbrain 결과 본문은 **코어엔 있으나(tool_executor.py:880 `result=`) `/v1/runs` 엔드포인트가 버림(api_server.py:4139-4147)**. 세션 chat-stream(:1971)은 preview를 싣는데 `/v1/runs`만 누락. → 우리 앱 단독 불가, **hermes-agent 3줄 수정 or 스킬 우회 택1**. P1은 이와 독립.
- **확정 F21:** 문서추출 완료 훅(document-extraction.service.ts:61 indexed 분기)이 "새 자료" 알림의 자연 발화점.
- **확정 F22:** 추출이 업로드를 동기 블로킹(controller.ts:82) → "추출 중" 상태는 비동기화 전엔 불가, P-대기.
- **확정 F23:** 라이브러리 검색은 pg ILIKE(1차)→pg_trgm(대기)→초성(대기). JS 2000행 캡은 표시 하이라이트로만 재사용.
- **확정 F24:** 문서=textContent(200K), 근거=excerpt(4000) 소스별 분기 검색해야 문서 전문검색 가치 실현.

---

## 최종 재정렬 우선순위 (5차 반영)

```
P0(상류/우회 택1)  gbrain 결과본문 캡처 (F20)
      · 정공법: hermes-agent api_server.py:4145 tool.completed에 preview=result[:N] 1줄 (★본체수정=별도승인)
      · 우회:   지구가 답변에 근거 명시하도록 스킬 유도 (상류무수정, Q1-B 동형)
      · P1은 이와 독립 — gbrain 근거 본문만 종속
P1  자료 라이브러리 (evidence 중심 집계, F13) — 문서·산출물 우선(gbrain본문은 P0 후):
      · 소스 = evidence_items(web/file) + artifacts, attachment 조인 보강
      · 삭제 정합성: 부모 thread→channel→project deletedAt 조인 필수 (F9)   ★유령자료
      · 목록엔 dataBase64/textContent 금지, 스니펫만 (F10)                ★메모리폭탄
      · 검색 pg-side: 문서=textContent ILIKE, 근거=excerpt ILIKE, 소스별분기 (F23/F24) ★JS캡재사용금지
      · dedup (sourceType+ref+url) (F4), 실패문서 뱃지 (F5), 문서 전문검색 (F2)
P2  답변별 근거 뱃지 → 패널 필터 (자동근거 한정 F3, 딥링크 F6 무료)
P2.5 라이브러리 "새 자료" 알림:
      · 발화점 = document-extraction.service.ts:61 indexed 분기 → notifyWorkspace refType:'library' (F21)
      · 선행: F15 3파일 additive(계약 enum + store url분기 + Bell 라우팅) ★안하면 클릭사망
      · 30초 폴링+기존 Web Push 재사용, 웹소켓 불필요 (F16). 덤: artifact 알림 클릭 버그 수정
P3  리치 ::choices (multi/approve/form) + 스킬 유도
P3.5 근거 묶음 export = evidence[]→markdown 조립 → ArtifactExportService.export() 재사용 (F18)
      · 신규 GET /library/.../export + 워크스페이스권한 + F9 deletedAt, F10 캡(≤50건/≤2MB) (F19)
P4  ::cite 각주 + qualityScore 뱃지
--  권한 채널격리(F11), evidence 아카이빙(F14), 비동기추출+"추출중"뱃지(F22) = 대기/승인
--  pg_trgm/초성 검색가속(F23 2·3차) = 대기
--  gbrain 원장 직결(F17) = ★원칙상 거부(물리미러링), 대기 아님
--  중단형 clarify(Q1-C) = 상류(#2971) 대기
```

---

# 최초 요청 대응 확인 (주인님 원 질문 ↔ 설계 매핑)

주인님이 최초에 물은 **두 가지**가 설계에 모두 반영되었는지 명시 확인:

| 최초 질문 | 설계 위치 | 결론 |
|---|---|---|
| **Q1. 사용자 선택 UI(clarify)가 우리 API에 갖춰져 있나?** | 본문 "Q1" 섹션(31-67행) + 4차 축0 | **네이티브 중단형=불가**(hermes-runs-client.ts SSE에 interaction 이벤트 없음). 현재 `::choices` 칩이 최선. 리치화(multi/approve/form)+스킬 유도는 백엔드 무변경 가능(P3). 진짜 중단형은 상류 #2971 대기(Q1-C). |
| **Q2. 창원 자료 라이브러리 UI + 답변 근거 연결** | 본문 "Q2" 섹션(71-122행) 트랙1+트랙2, 4차/5차 전면 | **데이터는 이미 다 쌓임(evidence+문서+산출물), thread에 갇혀있을 뿐** → 워크스페이스 집계 라이브러리(P1) + 근거 인라인 연결(P2)로 실현. 문서 전문검색(F2)은 공짜 자산. gbrain 근거 본문만 P0 종속. |

**두 질문 모두 설계에 있음.** 3~5차 심층은 이 두 트랙을 "실환경에서 안 깨지게" 다지는 작업이었다(삭제 정합성 F9, 메모리 F10, 검색 스케일 F12/F23, 알림 라우팅 F15, 결과캡처 F20).

---

# 6차 설계 (HTML 렌더링 + #3 프로젝트 컨텍스트 이어짐 + #5 산출물 프로젝트 스코프 + #6 근거 스코프)

주인님이 추가 요청한 4개 축. 앞 5차까지가 "자료를 어떻게 쌓고 보여줄까"였다면, 6차는 **답변을 어떻게 렌더할까(HTML)** + **프로젝트 단위로 어떻게 묶을까(#3/#5/#6)**. 모두 파일:라인 근거 기반.

## 축 A. HTML 렌더링 — 🔴 sanitize 없이는 켜면 안 됨(XSS)

**현황(F25):** `Markdown.tsx:9-20`은 `ReactMarkdown + remarkGfm`만. **raw HTML 비활성(react-markdown 기본)** — 주석(:25)에 "raw HTML stays DISABLED so streamed model output can never inject markup". 즉 지구가 `<table style>`·`<div>` 같은 HTML을 내면 **문자 그대로 이스케이프**되어 안 먹는다.

**요청 해석:** 주인님이 원하는 건 지구가 HTML(표/색/레이아웃)을 내면 그대로 렌더. 그러려면 `rehype-raw`(HTML 파싱)가 필요한데, 그건 **XSS 문(door)을 여는 것** — 지구 출력이 프롬프트 인젝션당하면 `<script>`/`<img onerror>`가 실행된다.

**설계(안전한 유일 경로):**
- 의존성 2개 추가(승인 필요): `rehype-raw`(HTML→hast) + `rehype-sanitize`(허용목록 필터). **둘은 반드시 세트.** raw만 넣으면 XSS.
- `Markdown.tsx`/`StreamingMarkdown.tsx`에 `rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}` 추가. 순서 중요: raw로 파싱 후 sanitize로 정리.
- **허용 스키마(화이트리스트)**: `table/thead/tbody/tr/th/td/div/span/p/ul/ol/li/h1~h4/code/pre/blockquote/hr/br/strong/em/a/img`. 속성은 `class`(우리 CSS 토큰만)·`href`(http/https/mailto)·`src`(https·data:image)·표의 `colspan/rowspan`·`align`. **차단**: `script/style/iframe/object/on*(onerror 등)/style 속성(임의 CSS 주입)`.
  - `style` 속성은 막고(임의 배경/position 주입 방지), 색·정렬은 우리가 정의한 `className` 화이트리스트로만 허용 → 디자인 토큰 일관성도 유지.
- 스트리밍 안전: `StreamingMarkdown`은 미완 HTML 태그가 프레임마다 들어오므로, sanitize가 불완전 태그를 drop하게 두면 됨(깜빡임 있으면 블록 파서가 fence처럼 태그 균형 볼 수도 있으나 1차는 sanitize에 위임).
- 링크는 이미 `target=_blank rel=noreferrer`(Markdown.tsx:12) — sanitize 후에도 유지되게 컴포넌트 오버라이드 순서 확인.

**리스크/판단:** 이건 순수 프론트 추가지만 **보안 표면을 늘리는 변경**이라 read-only가 아님. 주인님 "빌드/설정변경=명시승인" 대상. 대안(무의존): HTML은 계속 막고, 지구가 **마크다운 표/헤딩으로만** 내게 #9 규약을 강화(이미 주입함). 대부분의 "정돈된 답변"은 마크다운으로 충분 → **HTML은 정말 필요한 케이스(색 강조 표, 복합 레이아웃)만.** 권장: 1차는 마크다운 규약(#9)으로 체감 확인 → 부족하면 sanitize 세트 도입.

## 축 B. #3 프로젝트 내 채널 컨텍스트 이어짐 — 🟡 memoryTopicId 훅 활용

**현황(F26):** 
- 계층 = `workspace→project→channel→topic→thread` (space.ts). 채널마다 기본 topic('대화') 1개 + thread 1개.
- run 세션 = `consulting-thread:${threadId}` (hermes-runs-client.ts:114) → **스레드(=채널)마다 완전 격리.** 채널 A에서 한 얘기를 채널 B가 모름.
- **★핵심 발견:** `topics.memoryTopicId`(space.ts:68) = "dialogue_memory topic linkage ADR-0003, Null until registered" — **이미 스키마에 있으나 미사용.** 크로스 세션 기억을 위한 자리가 이미 파여 있음.
- `/v1/runs`는 `conversation_history` 배열을 받음(api_server.py:4194-4208) → 다른 채널 히스토리를 주입할 수 있는 경로 존재.

**주인님 의도 재해석:** "메시지 통합"이 아니라 **"프로젝트 안에서는 다른 채널이라도 서로 기억하고 이어질 수 있게"**. 즉 채널은 대화 화면상 분리(현행 유지)하되, 지구의 **기억은 프로젝트 단위로 공유**.

**설계 3안 (독립적, 조합 가능):**

- **B1(권장·저비용) — 프로젝트 공유 session_id:** run을 `consulting-project:${projectId}` 세션으로 걸면, Hermes dialogue_memory가 프로젝트 단위로 누적 → 같은 프로젝트의 어느 채널에서 물어도 지구가 이전 채널 맥락을 기억. 변경점: `hermes-runs-client.ts:114`의 session_id를 threadId→projectId 파생으로. **단, 채널별 화면 분리(우리 DB의 chat_messages는 threadId 스코프 유지)와 지구 기억 스코프(projectId)를 분리** — 화면은 채널, 기억은 프로젝트.
  - 리스크: 세션이 너무 커지면 컨텍스트 압박. Hermes가 압축하지만, 프로젝트가 방대하면 토큰비용↑. → topic/thread 수가 많은 프로젝트는 B2로.
- **B2 — conversation_history 주입:** run 시작 시 **같은 프로젝트의 다른 채널 최근 요약**을 `conversation_history`로 앞에 실어보냄. `chat-stream.controller`가 projectId로 형제 채널 최근 N메시지(또는 요약)를 조인해 주입. 장점: 세션 격리 유지하면서 선택적 컨텍스트. 단점: 매 run 프리픽스가 바뀌면 **프롬프트 캐시 깨짐**(주인님 성능 원칙 위반 소지) → 요약을 안정적으로 캐시 가능한 형태로 고정해야.
- **B3(정공법·상류) — memoryTopicId 등록:** 프로젝트를 dialogue_memory의 상위 topic으로 등록하고, 채널 topic들을 그 하위로 링크(memoryTopicId 채움). Hermes 기억 계층이 프로젝트를 인식. 상류 dialogue_memory API 계약 필요 → **대기**.

**권장:** B1(session_id를 프로젝트 파생)이 가장 단순하고 주인님 의도("프로젝트 안에서 이어짐")에 정확히 부합. **단 이건 지구 기억 동작 변경 → 승인 대상.** 화면(채널 분리)은 안 건드림.

**주의(격리):** B1로 프로젝트 세션을 공유하면, **다른 프로젝트/워크스페이스와는 반드시 격리**(session_id에 workspaceId+projectId 둘 다 포함). 안 그러면 창원 프로젝트 맥락이 다른 고객사로 샘.

## 축 C. #5 산출물 프로젝트별 관리 + 전체 보관함 프로젝트 필터 — 🟢 이미 거의 됨

**현황(F27):** `artifacts.projectId`가 **이미 NOT NULL FK**(collab.ts:60-62) + `artifacts_project_idx` 인덱스(:72) 존재. 즉 산출물은 **이미 프로젝트에 매여 저장**됨. 그런데 조회는 워크스페이스 전체만(`GET /artifacts/workspaces/:wsId`, artifacts.controller.ts:50) — **프로젝트 필터 파라미터가 없다.**

**설계(저비용):**
- **C1 백엔드:** `GET /artifacts/workspaces/:wsId?projectId=` 쿼리 추가. `ArtifactStore.listForWorkspace`에 projectId 옵션 필터(이미 인덱스 있음). 스키마 변경 0.
- **C2 프론트(`_app.artifacts.tsx`):** 좌측 리스트 상단에 **프로젝트 필터 드롭다운/칩** 추가(워크스페이스 트리의 projects 재사용, 이미 `useWorkspaceTree`로 로드). "전체 / 프로젝트별" 토글. 선택 시 목록 필터.
- **C3 프로젝트별 진입:** 사이드바 프로젝트 행에서 "이 프로젝트 산출물" 바로가기(RowMenu 액션 추가) → `/artifacts?projectId=`로 딥링크. 
- **결론:** #5는 **거의 무료**(스키마 0, API에 필터 1개, UI에 드롭다운 1개). 전체 보관함=프로젝트 필터 조회 둘 다 충족.

## 축 D. #6 근거 스코프(채널별 vs 프로젝트 통합) — 🟡 결정 필요, evidence는 thread 스코프

**현황(F28):** `evidence_items`는 **threadId FK 스코프**(collab.ts:20-22) + `evidence_thread_idx`. 조회도 `GET /threads/:id/evidence`(chat-stream.controller.ts:88)로 thread(=채널)별만. 프로젝트 통합 조회 없음(이건 5차 P1 자료 라이브러리가 워크스페이스 집계로 이미 다룸).

**주인님 질문 재정리:** 근거를 **채널마다 볼지 vs 프로젝트 전체 통합해 볼지.** 두 레벨이 다 필요.

**설계(3계층 스코프 — 이미 있는 것 + 추가):**
| 스코프 | 현황 | 추가 필요 |
|---|---|---|
| 채널(thread)별 | ✅ 이미 됨(EvidencePanel 우측, thread별) | 없음 |
| **프로젝트별** | ❌ 없음 | `GET /library/.../sources?projectId=` (5차 P1에 이미 설계). evidence를 thread→topic→channel→**project** 조인해 projectId 필터 |
| 워크스페이스 전체 | 5차 P1 라이브러리가 담당 | 5차 설계대로 |

- **핵심 판단(#6 답):** 근거는 **"채널별=작업 중 맥락, 프로젝트별=자료 라이브러리"** 두 레벨로 분리. 채널별은 지금처럼 답변 옆 우측 패널(실시간 작업), 프로젝트별은 5차 P1 자료 라이브러리에 **projectId 필터**를 기본값으로. **통합이냐 분리냐가 아니라 둘 다** — 스코프 스위처(채널/프로젝트/워크스페이스)로.
- **삭제 정합성(F9 재적용):** 프로젝트 스코프 집계도 부모 channel→project deletedAt 조인 필수(안 하면 유령근거).
- **B1(프로젝트 세션 공유)과의 시너지:** 만약 축 B의 B1을 택하면 지구가 프로젝트 단위로 근거를 쌓으므로, #6의 프로젝트 근거 뷰가 자연스럽게 채워짐. B와 D는 한 세트로 움직이면 정합적.

---

## 6차 통합 우선순위 (승인 후)

```
[구현 완료·검증됨] #9 답변 포맷 규약 주입 (hermes-runs-client.ts instructions) — api typecheck 통과
[구현 완료] UI 즉시수정 1·2·4·7·8 + 컴팩트높이 + 경로자간 + 데드존(행 role=button)

[승인 필요 — 구현]
C  #5 산출물 프로젝트 필터  ← ★가장 저비용(스키마0, API+UI 각 1). 즉시 가치
   · GET /artifacts/workspaces/:id?projectId= + _app.artifacts 드롭다운
A  HTML 렌더링  ← rehype-raw + rehype-sanitize 세트(보안필수). dep 2개 추가 승인
   · 화이트리스트 스키마, style속성 차단, className만 허용
B1 #3 프로젝트 컨텍스트 이어짐  ← session_id를 project 파생(workspaceId+projectId 격리)
   · 지구 기억 동작 변경 = 승인. 화면(채널분리)은 불변
D  #6 근거 프로젝트 스코프  ← 5차 P1 라이브러리에 projectId 필터(B1과 세트). F9 deletedAt 조인

[대기/상류]
B3 memoryTopicId dialogue_memory 등록 = 상류 계약
B2 conversation_history 주입 = 프롬프트 캐시 리스크 검토 후
```

## 6차 핵심 4줄
- **HTML(A):** 켜려면 rehype-raw+**sanitize 필수**(XSS). 무의존 대안=마크다운 규약(#9, 이미 주입)으로 대부분 커버. 정말 필요할 때만 dep 추가.
- **#3(B):** `topics.memoryTopicId` 훅이 이미 있음. 가장 단순한 답=**session_id를 프로젝트 파생**(B1), workspaceId+projectId로 타 프로젝트 격리. 화면은 채널 분리 유지, 기억만 프로젝트 공유.
- **#5(C):** artifacts.projectId **이미 NOT NULL**. 프로젝트 필터는 API 쿼리1+UI드롭다운1 = **거의 무료.**
- **#6(D):** 근거는 채널별(현행)+프로젝트별(5차 라이브러리 projectId 필터) **둘 다.** B1 택하면 자연 시너지. F9 deletedAt 조인 필수.



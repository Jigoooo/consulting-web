# 설계(전체): 메시지 렌더·최상급 뷰어·날짜헤더·자료실·공통Select·내부 분석레이어 고도화 (Round 14, v2)

작성: 2026-07-06 · 지구 · **설계 전용(구현 없음)**
대상: `consulting-web` (apps/web, apps/api, packages/contracts) + 내부 추출 레이어
전제: 프로덕션 8088=docker 서빙(소스 수정→재빌드=승인). dev 5273=사용자 서버 kill 금지. 로그인 게이트로 실화면 QA는 주인님 몫.

주인님 결정 반영:
1. **회색박스 = 메시지 렌더링 상태(검색 아님)** → 원인 확정: inline code pill + 한글 `word-break:break-all`.
2. Radix Select 도입 **OK**.
3. PDF 뷰어 = **pdf.js 기반**.
4. 자료실 = **별도 메뉴**.
5. 뷰어 라이브러리 **최상급**(리소스 충분).
6. 내부 분석 레이어(pdf/ocr) **최고급 + fallback·비교 레이어 신설**.

---

## 0. 실측 요약 (코드 근거)

### 0-1. 회색박스 원인 (메시지 렌더 상태)
| 사실 | 근거 |
|---|---|
| 평상시 assistant는 `<Markdown>`로 정상 렌더 | `VirtualMessageStream.tsx:124` |
| **inline code 배경 = `--bg-warm`(라이트 `#efece5` 베이지그레이) + hair 보더 → 회색 pill** | `Markdown.module.css:84-95`, `tokens.css:13` |
| **`.md code { word-break: break-all }` → 한글이 어절 중간에서 끊김("5년/6월" 뭉개짐)** | `Markdown.module.css:93` |
| 표 `th`·zebra·blockquote 도 `--bg-warm` 계열 배경 | `Markdown.module.css:76-83,154-166` |
| 지구가 값·기간(`5년`, `5년 6월`)에 백틱을 붙이면 회색 박스화 | 포맷 규약에 백틱 억제 규칙 없음(`hermes-runs-client.ts:53`) |

**결론:** "5년→5년 6월 뒷 회색박스 + 뭉개짐" = 지구가 **값에 백틱**을 씀 → inline code 회색 pill + `break-all` 한글 절단. 렌더 버그가 아니라 (a)inline code 스타일 (b)백틱 남용 두 축.

### 0-2. 내부 분석(추출) 레이어 현황 — 개선 여지 큼
| 사실 | 근거 |
|---|---|
| PDF: `pdftotext -layout` → 텍스트<80자면 `pdftoppm 250dpi` + `tesseract kor+eng --psm 3` **단일 패스** | `document-extraction.service.ts:120-134` |
| 이미지: `tesseract --psm 3` 단독 | `:136-140` |
| HWPX: `unzip *.xml` + **정규식 태그제거**(표 구조·읽기순서 소실) | `:142-152` |
| HWP: `hwp5txt`(PrvText 1023자 절단 위험 — 창원스킬 기록) | `:154-158` |
| **레이아웃 인식·표 구조복원·읽기순서·수식 없음. OCR 다중런/교차검증 없음. 파서 비교(최대값 선택) 없음.** | 서비스 전체 |
| 창원 별도 Python 파이프라인엔 이미 pymupdf/pdfminer/pdfplumber 최대값 + multi-OCR 프로토콜 존재(웹앱과 미공유) | skill `changwon-parsing-pipeline` |

### 0-3. 기타
| 사실 | 근거 |
|---|---|
| 채팅 날짜 divider/sticky **없음**(시간만) | `VirtualMessageStream.tsx:98-100` |
| 파일 뷰어 **없음**(다운로드 API만 `attachments.controller.ts:138`) | 뷰어 컴포넌트 grep=0 |
| 자료 집계 API **없음**(evidence/문서/산출물 전부 thread 스코프) | api grep=0 |
| 업로드 문서 원문 `text_content`(≤200K) 저장되나 노출 read API 없음 | `document-extraction.service.ts:54` |
| 산출물 셀렉트 = 네이티브 `<select>` | `_app.artifacts.tsx:120,174` |

### 0-4. 레퍼런스 (2026 최상급 실측)
- **렌더**: Streamdown(Vercel AI SDK) — 미완블록 파싱·스트리밍 caret·**Shiki 코드 하이라이트+복사/다운로드**·KaTeX·Mermaid·**CJK 문장부호**·링크안전모달.
- **PDF 뷰어**: pdf.js(Mozilla) 기반 — `react-pdf`(wojtekmaj, MIT, 경량) 또는 `@react-pdf-viewer`(툴바·검색·썸네일·줌 풀세트, **라이선스 확인 필요**).
- **코드**: Shiki(VSCode TextMate 엔진, 최상급 하이라이트).
- **OCR/문서지능 SOTA 2026**: 레이아웃 파서 **Docling(IBM)·Marker·MinerU**(layout+table+reading-order→structured md), OCR VLM **Surya 2**(open 650M)·**PaddleOCR-VL**·**olmOCR**·Mistral OCR(API)·DeepSeek-OCR. 다중 OCR 교차검증은 창원스킬 `multi-ocr-numeric-cross-validation.md`에 이미 프로토콜化.
- **Select**: shadcn = Radix `@radix-ui/react-select`.

---

## 축 1 — 메시지 렌더 최상급화 + 회색박스 제거

### 1-A. 회색박스 즉효 처방(3중, 모두 근본)
1. **inline code 스타일 톤다운**(`Markdown.module.css:84-95`):
   - 배경 `--bg-warm` → `color-mix(in srgb, var(--text-primary) 5%, transparent)`(은은), 보더 제거 또는 `--border-hair`만.
   - **`word-break: break-all` → `keep-all` + `overflow-wrap: anywhere`**(한글 어절 보존, 긴 경로만 줄바꿈). ← "뭉개짐" 직접 해소.
2. **백틱 남용 억제**(`CONSULTING_RESPONSE_FORMAT` 상수 1줄, `hermes-runs-client.ts:53`):
   - "백틱은 파일경로·명령·코드 식별자에만. 숫자·기간·일반 명사(예: 5년, 5년 6월)에 백틱 금지." → 근본 원인(값에 pill) 억제. 백엔드 상수, 프롬프트 캐시 보존.
3. **표 헤더/zebra/인용 톤다운**: th는 배경 대신 하단 2px 보더, zebra 3%→2%. 실화면 미세조정.

### 1-B. 렌더 엔진 최상급(Streamdown 급 자체 구현)
| 기능 | 처방 | 파일 |
|---|---|---|
| 코드블록 헤더바 | 언어 라벨 + **복사·다운로드** 버튼 | 신규 `CodeBlock.tsx`, `Markdown.tsx` `components.pre` |
| 구문 하이라이트 | **Shiki**(VSCode 엔진, 최상급) lazy import — 초기 번들 영향 0(lazy chunk). 라이트/다크 테마 동기 | `CodeBlock.tsx` |
| 수식 | **KaTeX** + `remark-math`/`rehype-katex`(lazy) | `Markdown.tsx` |
| 다이어그램 | **Mermaid**(lazy, 풀스크린 뷰) — 컨설팅 플로우/조직도 렌더 | 신규 `Mermaid.tsx` |
| CJK 문장부호 폭 | 한글 `：／（）` 교정 CSS | `Markdown.module.css` |
| 스트리밍 미완블록 | 미완 코드펜스 "생성 중" caret + 안전 렌더 | `StreamingMarkdown.tsx` |
| HTML 렌더 | 이미 rehype-raw+sanitize 켜짐. `style` 차단 유지(XSS), className 화이트리스트 | `sanitizeSchema.ts`(유지) |
| 인라인 citation | 지구가 `[^1]`→evidence 매핑(축5 연계) | 규약+렌더 |

**의존성(승인):** `shiki`, `katex`+`remark-math`+`rehype-katex`, `mermaid`. 전부 **lazy chunk**로 초기 로드 무영향. 번들 영향 측정 후 보고.

---

## 축 2 — 현재 보는 영역 날짜 표시

- **2-A. Sticky 날짜 pill(주력):** 가상리스트라 IntersectionObserver로 상단 근접 행의 `createdAt` 추적(기존 sentinel 재사용) → 스트림 상단 `position:sticky` 중앙 pill(`오늘`/`어제`/`2026년 7월 6일`). 스크롤 정지 1.5s 후 페이드(선택).
- **2-B. 날짜 경계 divider:** 날짜 바뀌는 첫 메시지 위 `── 2026년 7월 6일 ──`(기존 `newDivider` 톤 재사용, `ThreadView.module.css:556`).
- **2-C. hover 툴팁:** `s.time`에 `title={전체 날짜시간}` 1줄 추가(`VirtualMessageStream.tsx:98`).
- 유틸: `shared/lib/formatDate.ts`(상대표기, KST). 순수함수 TDD.

---

## 축 3 — 파일 뷰어 (최상급, 우측 슬라이드, 다운로드)

주인님: "파일 클릭→우측 펼쳐지며 보이게, html/text/md/pdf 뷰어, 다운로드."

**신규 위젯 `widgets/file-viewer`** — 우측 슬라이드 패널(`translateX(100%)→0`, backdrop/ blur 없음=round6 원칙). open 상태는 URL `?file=id`(딥링크·뒤로가기).

| 종류 | 뷰어(최상급) |
|---|---|
| PDF | **pdf.js 기반 `react-pdf`(wojtekmaj, MIT)** + 커스텀 툴바(페이지 이동/줌/검색/썸네일). worker는 vite로 번들. lazy chunk |
| Markdown/.md | 기존 `<Markdown>`(축1 최상급 엔진) 재사용 |
| text/코드 | `CodeBlock`(Shiki) 재사용 |
| HTML | **sanitize 후** 렌더(축1 sanitizeSchema). raw 금지, iframe이면 `sandbox`+blob |
| 이미지 | `<img>` blob + 줌 |
| HWP/HWPX | 인라인 뷰 대신 **추출 텍스트**(`text_content`) 표시 + 원본 다운로드 |

- 데이터: `GET /attachments/:id/content`(blob, 존재) + 신규 `GET /attachments/:id/extraction`(text_content).
- 다운로드: 기존 `saveAttachment`(content-disposition) 재사용. 뷰어 헤더 "다운로드" 버튼.
- 진입점: 채팅 첨부칩 / 자료실(축4) 행 / evidence 카드.
- 보안: 업로드 HTML 앱오리진 인라인 금지(`nosniff` 유지), sanitize 파싱결과만 DOM화.
- **의존성(승인):** `react-pdf`(+pdfjs-dist). lazy.

---

## 축 4 — 자료실 (별도 메뉴) + 다운로드

DB에 이미 3계층 축적(evidence·업로드문서·산출물). **workspace/project 집계 read API + 별도 메뉴**.

### 4-A. 백엔드 (신규 read, 스키마 변경 0)
`GET /library/workspaces/:wsId/sources?projectId=&type=&q=&cursor=&limit=`
- evidence_items + file_attachments(+extraction) + artifacts **UNION 집계**.
- 행: `{ kind, id, title, sourceType, projectId, channelName, threadId, snippet, url?, sizeBytes?, mime?, createdAt, messageId? }`
- 검색: **pg-side `ILIKE`**(문서=text_content 200K, 근거=excerpt) — JS 대량로드 금지(F12).
- **F9 소프트삭제 가드**: evidence→threads→topics→channels→projects 전 계층 `deletedAt IS NULL` 조인(유령자료 방지).
- **컬럼 명시 SELECT**: `data_base64`·`text_content` 대용량은 목록 제외, 상세/다운로드에서만(메모리폭탄 방지).
- 중복제거: `(sourceType+ref+url)` group.
- 테넌시: `SpaceAccessService.projectMember`/workspace 멤버십.
- 부속: `GET /attachments/:id/extraction`(text_content). 다운로드=기존 `/content`·artifact `/export` 재사용.

### 4-B. 프론트 (신규 라우트 `/_app.library` — 별도 메뉴)
- 사이드바 워크스페이스 툴에 **"자료실"** flat row(Slack 스타일=round4, "산출물 보관함"과 **별도 항목**).
- 좌: 필터(프로젝트·종류·검색). 중: 자료 카드 리스트(종류 아이콘+제목+스니펫+출처 채널+날짜, 무한스크롤=기존 가상화). 우: **파일 뷰어(축3 공유)** — 문서=뷰어+다운로드, evidence=원문 excerpt+출처+"이 근거가 쓰인 답변으로 이동"(`focusMessage` 딥링크), artifact=산출물 딥링크.
- 실패 투명: extraction `status:failed`는 "추출 실패" 배지(숨김 금지, 주인님 선호).

---

## 축 5 — 공통 Select (shadcn/Radix) + 애니메이션

### 5-A. 공통 컴포넌트 `shared/ui/select/Select.tsx` — **Radix 채택**
`@radix-ui/react-select`(shadcn Select 실체) — a11y·키보드·portal 포지셔닝(clipped 컨테이너 안전=round2) 완비.
```tsx
<Select value={v} onValueChange={setV} placeholder="전체 프로젝트"
  options={[{value:'',label:'전체 프로젝트'}, ...projects.map(p=>({value:p.id,label:p.name}))]} />
```
- **애니메이션(shadcn 표준):** open=`fade-in+zoom-in-95+slide-in-from-top-2`, close 역방향, ~150ms `--ease-out`, chevron 회전. `prefers-reduced-motion` 폴백.
- 토큰: `--surface-card`·`--border-whisper`·`--shadow-pop`. 다크 하드코딩 금지(round9/12).

### 5-B. 교체 범위(공통화)
- `_app.artifacts.tsx:120,174`(프로젝트 필터/선택). evidence 범위 스위치=segmented 유지.
- 전 화면 `NativeSelect` 전수 grep 후 일괄 교체(주인님 "구조적 재발불가").

---

## 축 6 — 내부 분석(추출) 레이어 최고급화 + fallback·비교 레이어 신설 ★신규

주인님: "내부 분석 레이어 pdf/ocr 최고급으로, fallback·비교 레이어 없으면 추가."

### 6-0. 현재 한계
단일 `pdftotext`→`tesseract` 단일패스. 레이아웃/표/읽기순서/수식 없음, OCR 다중런 없음, 파서 비교 없음, 신뢰도 교차검증 없음.

### 6-A. 다단 파서 파이프라인(비교 레이어 = 여러 파서 병렬→최대·최적 선택)
PDF 텍스트 추출을 **여러 엔진 병렬 실행 → 품질 스코어 최대값 채택**(창원 파이프라인의 웹앱 이식):
| 티어 | 엔진 | 역할 |
|---|---|---|
| T1 텍스트레이어 | `pdftotext -layout` / **pymupdf(fitz)** / pdfminer / pdfplumber | 텍스트형 PDF 최대값 선택 |
| T2 레이아웃/구조 | **Docling** 또는 **Marker/MinerU** | layout detection + **표 구조복원** + reading-order → **structured markdown**(표가 `\|---\|`로 살아남음) |
| T3 OCR(스캔형) | **다중 OCR**: tesseract(psm 3/4/6 × DPI 250/400) + **Surya 2**(open VLM, 표·다국어 강함) | 텍스트레이어 없을 때 |
| T4 수식/특수 | 수식 영역 → 전용 모델 라우팅(Docling/Marker 내장) | 컨설팅 문서엔 드묾, 낮은 우선순위 |
- **비교·수렴 레이어**: T1~T3 결과를 `qualityScore`(기존 `scoreText` 확장: 텍스트량·한글비율·표검출·수치일치)로 **교차 비교 → 최고 채택**. 스캔 수치문서는 창원 `multi-ocr-numeric-cross-validation`처럼 **다중런 수치 일치 검증**(불일치 시 `수치대조필요` 플래그).
- **fallback 체인 명시화**(현재 암묵적 2단 → 명시적 다단):
  `pymupdf → pdftotext → pdfminer/pdfplumber → Docling(layout) → 다중 tesseract → Surya OCR → 실패(투명 기록)`.
- HWP/HWPX: 정규식 태그제거 → **구조 보존 파서**(HWPX section XML 순회=창원 검증 19,652자, HWP=한컴 BodyText olefile+zlib) 이식. PrvText 1023자 절단 회피.

### 6-B. 아키텍처(성능·격리 = 주인님 성능저하 방지 원칙 준수)
- **현재 `spawnSync`(동기 블로킹) → 백그라운드 워커**로 이관: nestjs가 무거운 파싱(특히 VLM)을 요청 스레드에서 돌리면 안 됨. 이미 `queues/`(redis/bullmq 추정) 존재 → **추출 잡 큐화**(업로드 즉시 202+`status:processing`, 워커가 파이프라인 실행 후 `text_content` 채움). UI는 "분석 중" 배지 → 완료 시 갱신.
- **VLM(Surya/Docling)은 무겁다** → 별도 파이썬 워커(창원 `.venv` 재사용 가능) 또는 컨테이너. 웹앱 API는 잡 enqueue만. GPU 유무에 따라 CPU 폴백(tesseract).
- **재처리 API**: 기존 첨부를 새 파이프라인으로 재추출(`POST /attachments/:id/reindex`) — 과거 업로드도 최고급 재분석.
- 신뢰도·추출기·경고를 UI 노출(자료실 배지: `pymupdf`/`Docling`/`Surya·교차검증`/`추출실패`).

### 6-C. 신규/변경 파일(설계)
- `apps/api/src/chat/document-extraction.service.ts`: 파이프라인化(파서 어댑터 인터페이스 + 비교 선택 + fallback 체인).
- 신규 파서 어댑터: `extractors/pymupdf.ts`(python 브리지), `extractors/docling.ts`, `extractors/surya.ts`, `extractors/hwpx-structured.ts`.
- `queues/`: `document-extraction.processor.ts`(잡 워커).
- 파이썬 사이드카: `scripts/extractor_worker.py`(Docling/Surya/pymupdf, 창원 venv 재사용 검토).

### 6-D. 승인·리스크
- **[의존성/인프라 승인]** Docling/Surya(파이썬, 모델 다운로드·수 GB), 잡 워커 전환, 파이썬 사이드카. 성능·메모리 영향 큼 → **단계적**: ①웹앱에 pymupdf+다중 tesseract+HWPX 구조파서 먼저(경량, 즉효) ②Docling 레이아웃 ③Surya VLM(GPU 여유 시).
- 성능저하 방지 원칙: 동기 spawnSync 제거(오히려 개선), 무거운 건 큐+워커 격리.

---

## 구현 순서 (승인 후, blast-radius·가치 순)

1. **회색박스 즉효(축1-A)**: inline code keep-all·톤다운 + 백틱 억제 규약 + 표 톤다운. (web CSS + api 상수) — 저위험·즉가치.
2. **날짜 헤더(축2)**: sticky pill + divider + hover title. web only.
3. **공통 Select(축5)**: Radix 도입 → `shared/ui/select` → 전수 교체.
4. **렌더 엔진 최상급(축1-B)**: CodeBlock(Shiki)+복사/다운로드, KaTeX, Mermaid. lazy 번들 측정.
5. **파일 뷰어(축3)**: `file-viewer` 위젯(react-pdf) + `/attachments/:id/extraction`.
6. **자료실(축4)**: `/library/.../sources` API → `/_app.library` 별도 메뉴 → 뷰어 연결.
7. **내부 분석 레이어(축6)**: ①경량(pymupdf+다중OCR+HWPX구조) ②Docling ③Surya. 잡 큐화. 단계적.

## 승인 필요 항목 (주인님 명시 승인)
- **[의존성]** `@radix-ui/react-select`, `shiki`, `katex`+`remark-math`+`rehype-katex`, `mermaid`, `react-pdf`(+pdfjs-dist) — 전부 lazy, 번들 영향 보고 후.
- **[인프라·중]** 축6: Docling/Surya 파이썬 사이드카 + 추출 잡 큐화(모델 수 GB, 워커 전환). 단계적·승인.
- **[api 상수]** `CONSULTING_RESPONSE_FORMAT` 백틱 억제(축1-A).
- **[docker 재빌드/배포]** 모든 web/api 변경. dev 5273 kill 금지.

## 검증 게이트
- 오프라인: contracts build → api/web typecheck → lint → vitest → web build 전부 GREEN. 페이즈별 커밋.
- 순수함수 TDD: formatDate, library 필터쿼리, sanitize, 추출기 스코어/선택 로직, 다중OCR 수치수렴.
- 실화면(승인 후 재빌드): version.json 번들해시 확인 → 8088에서 (a)회색박스·뭉개짐 소멸 (b)코드/수식/표/mermaid 렌더 (c)날짜 pill 스크롤 추적 (d)파일 클릭→우측 뷰어(pdf 툴바)+다운로드 (e)자료실 목록·검색·다운로드 (f)Select 애니메이션·다크 (g)새 파이프라인 문서 재추출 품질.
- `browser_console` fetch/폼값 read=차단 → DOM innerText + click/type/snapshot QA.

## 열린 질문(주인님 확인)
1. 축6 OCR VLM: **Surya 2(open, 자체호스팅)** vs **Mistral OCR(API, 무운영)** — 자료 외부전송 민감도? (컨설팅 고객문서라 자체호스팅 권장)
2. 축6 잡 큐화: 기존 `queues/`(bullmq/redis) 재사용 OK? (업로드→비동기 추출로 UX 바뀜: "분석 중" 배지)
3. PDF 뷰어: `react-pdf`(경량 MIT, 툴바 자체구현) vs `@react-pdf-viewer`(풀툴바, 라이선스 확인) — 어느 쪽?
4. 축6을 이번 배치에 **전부** vs **경량단계(①)만 먼저** 넣고 Docling/Surya는 후속?

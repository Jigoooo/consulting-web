# 컨설팅 문서 지능 레이어

## 결론

컨설팅 웹의 문서 처리 레이어는 단일 OCR 엔진이 아니라 fallback ladder로 운영한다.
업로드 자료의 품질이 매번 다르기 때문에, 빠른 텍스트 추출과 고급 OCR을 분리하고 실패 사유를 남긴다.

## 1. Export ladder

### PDF

1. Typst
   - 1순위 PDF 엔진
   - Pandoc Markdown → Typst PDF
   - 서버 산출물의 기본 경로

2. WeasyPrint
   - HTML/CSS 보존형 fallback
   - 표, 좌측정렬, 한글 폰트 유지

3. Chromium
   - 브라우저 렌더링 최종 fallback
   - 복잡한 HTML 시각 보존용

성공 조건:
- 파일 존재
- 1KB 이상
- 헤더가 %PDF- 로 시작

### DOCX

- Pandoc 유지
- Word 편집 가능한 산출물 제공 목적

## 2. Extraction/OCR ladder

### 1순위: 텍스트 PDF

- pdftotext -layout
- 텍스트 레이어가 충분하면 OCR을 하지 않는다.
- 빠르고 정확하며 표 위치 보존에 유리하다.

### 2순위: 스캔 PDF/이미지 OCR

- pdftoppm으로 250dpi 렌더링
- tesseract kor+eng --psm 3
- 한글/영문 혼합 행정문서 기본 대응

### 3순위: 향후 고급 엔진

- marker-pdf
  - 복잡한 레이아웃, 수식, 표 구조, 스캔 문서 고품질 추출
  - 모델/디스크 비용이 커서 옵션 레이어로 둔다.

- Cloud Vision OCR
  - 사용 승인 필요
  - 로컬 OCR 신뢰도가 낮거나 작은 글씨/도장/스캔 품질이 나쁜 경우 선택 fallback

## 3. 운영 원칙

- 선별과 판정을 분리한다.
  - OCR 결과는 자료 후보를 만드는 도구다.
  - 정책 판단이나 컨설팅 결론을 OCR 결과 하나로 확정하지 않는다.

- 실패는 숨기지 않는다.
  - 어떤 엔진이 실패했는지 기록한다.
  - fallback으로 성공해도 최초 실패 사유를 디버그 로그에 남긴다.

- 외부 공유 문서는 가독성을 우선한다.
  - 좌측정렬
  - 풀폭표
  - 한글 폰트
  - URL/근거/주의사항 보존

## 4. 현재 구현

- PDF export: Typst → WeasyPrint → Chromium fallback
- DOCX export: Pandoc
- OCR helper: scripts/extract-document-text.sh
- Docker runtime 포함 도구:
  - pandoc
  - typst
  - weasyprint
  - chromium
  - font-noto-cjk
  - poppler-utils
  - tesseract-ocr
  - tesseract-ocr-data-kor
  - tesseract-ocr-data-eng

## 5. 다음 고도화 후보

- 업로드 첨부파일별 자동 텍스트 인덱싱
- OCR confidence/텍스트 길이/페이지 수 기반 품질 점수
- 저품질 문서만 marker-pdf 또는 Cloud Vision으로 승격
- 추출 결과를 Evidence 후보로 자동 연결
- HWP/HWPX 추출 rail 추가

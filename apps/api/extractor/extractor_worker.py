#!/usr/bin/env python3
"""
문서 추출 워커 (축6 — consulting-web 내부 분석 레이어 최고급).

여러 파서를 병렬/순차로 돌려 품질 점수 최대값을 채택하는 "비교 레이어" +
텍스트레이어 없을 때 다중 OCR fallback. NestJS가 이 스크립트를 CLI로 호출하고
stdout의 JSON 한 줄을 파싱한다.

usage:  extractor_worker.py <path> <mime> [--ocr]
stdout: {"status","extractor","text","textChars","qualityScore","warnings",
         "candidates":[{extractor,chars,score}], "structured": bool}

원칙(창원 changwon-parsing-pipeline 스킬 이식):
  - PDF: pymupdf4llm(레이아웃+표→markdown) / pymupdf / pdfminer / pdfplumber 병렬
    → 최대 텍스트량 + 표 검출 가산 → 최고 채택. 텍스트 없으면 다중 tesseract OCR.
  - HWPX: section XML 순회(PrvText 1023자 절단 회피).
  - HWP: olefile BodyText(zlib) → 실패 시 미지원.
  - 이미지: 다중 tesseract(psm 3/4/6).
  - 모든 파서는 bytes stream 전달(한글 경로 안전), NUL 제거, NFC 정규화.
"""
import io
import json
import sys
import re
import unicodedata
import zipfile
import contextlib

MAX_CHARS = 200_000


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\u0000", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_CHARS]


def score_text(status: str, extractor: str, chars: int, structured: bool, warnings) -> int:
    if status == "skipped":
        return 0
    if status == "failed":
        return 10
    score = 86 if chars >= 1000 else 78 if chars >= 200 else 70 if chars >= 80 else 60 if chars >= 10 else 30
    if extractor in ("pymupdf4llm", "pdfplumber-table"):
        score += 6  # 레이아웃/표 구조 보존
    if extractor in ("pymupdf", "pdftotext", "hwpx-xml", "text/plain"):
        score += 4
    if extractor.startswith("ocr"):
        score -= 8
    if structured:
        score += 4
    if "short_text" in warnings:
        score -= 8
    if "korean_text_detected" in warnings:
        score += 3
    return max(0, min(100, score))


# ---------- PDF: 다단 파서 비교 레이어 ----------

def pdf_candidates(data: bytes):
    """여러 텍스트-레이어 파서를 돌려 (extractor, text, structured) 후보 리스트 반환."""
    out = []
    # 1) pymupdf4llm — 레이아웃/표를 markdown으로(표가 |---|로 보존).
    try:
        import pymupdf
        import pymupdf4llm
        doc = pymupdf.open(stream=data, filetype="pdf")
        md = pymupdf4llm.to_markdown(doc, show_progress=False)
        if md and md.strip():
            structured = "|" in md and "---" in md  # 표 검출
            out.append(("pymupdf4llm", md, structured))
    except Exception:
        pass
    # 2) pymupdf 순수 텍스트.
    try:
        import pymupdf
        doc = pymupdf.open(stream=data, filetype="pdf")
        txt = "".join(p.get_text() for p in doc)
        if txt.strip():
            out.append(("pymupdf", txt, False))
    except Exception:
        pass
    # 3) pdfplumber — 표 추출 특화.
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            parts, has_table = [], False
            for page in pdf.pages:
                t = page.extract_text() or ""
                if t:
                    parts.append(t)
                for tbl in page.extract_tables():
                    has_table = True
                    for row in tbl:
                        parts.append(" | ".join(c or "" for c in row))
            joined = "\n".join(parts)
            if joined.strip():
                out.append(("pdfplumber-table" if has_table else "pdfplumber", joined, has_table))
    except Exception:
        pass
    # 4) pdfminer.
    try:
        from pdfminer.high_level import extract_text
        txt = extract_text(io.BytesIO(data)) or ""
        if txt.strip():
            out.append(("pdfminer", txt, False))
    except Exception:
        pass
    return out


def ocr_multi(data: bytes):
    """스캔형 PDF/이미지 다중 tesseract OCR(psm 3/4/6 최대값)."""
    best = ("", "ocr")
    try:
        import pymupdf
        from PIL import Image
        import pytesseract
        doc = pymupdf.open(stream=data, filetype="pdf")
        pages_text = []
        for page in doc:
            pix = page.get_pixmap(dpi=250)
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            runs = []
            for psm in (3, 4, 6):
                try:
                    runs.append(pytesseract.image_to_string(img, lang="kor+eng", config=f"--psm {psm}"))
                except Exception:
                    pass
            pages_text.append(max(runs, key=len) if runs else "")
        text = "\n".join(pages_text)
        if len(text) > len(best[0]):
            best = (text, "ocr-multi")
    except Exception:
        pass
    return best


def image_ocr(data: bytes):
    try:
        from PIL import Image
        import pytesseract
        img = Image.open(io.BytesIO(data))
        runs = []
        for psm in (3, 4, 6):
            try:
                runs.append(pytesseract.image_to_string(img, lang="kor+eng", config=f"--psm {psm}"))
            except Exception:
                pass
        return (max(runs, key=len), "ocr-image") if runs else ("", "ocr-image")
    except Exception:
        return ("", "ocr-image")


# ---------- HWPX / HWP ----------

def hwpx_structured(data: bytes) -> str:
    """HWPX section XML 전체 순회(PrvText 1023자 절단 회피)."""
    parts = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = sorted(n for n in z.namelist() if re.search(r"Contents/section\d+\.xml$", n))
            if not names:
                names = [n for n in z.namelist() if n.endswith(".xml")]
            for n in names:
                xml = z.read(n).decode("utf-8", errors="replace")
                text = re.sub(r"<[^>]+>", " ", xml)
                text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
                parts.append(text)
    except Exception:
        return ""
    return re.sub(r"\s+", " ", "\n".join(parts))


def hwp_binary(data: bytes) -> str:
    """HWP olefile BodyText(zlib) — 한컴 공식 방식."""
    try:
        import olefile
        import zlib
        ole = olefile.OleFileIO(io.BytesIO(data))
        # 압축 여부는 FileHeader에 있으나 실무상 zlib raw(-15) 시도.
        texts = []
        for entry in ole.listdir():
            if entry and entry[0] == "BodyText":
                stream = ole.openstream(entry).read()
                try:
                    dec = zlib.decompress(stream, -15)
                except Exception:
                    dec = stream
                # UTF-16LE 한글 텍스트 추출(제어문자 제거).
                try:
                    t = dec.decode("utf-16-le", errors="ignore")
                    t = re.sub(r"[\x00-\x08\x0b-\x1f]", "", t)
                    texts.append(t)
                except Exception:
                    pass
        return "\n".join(texts)
    except Exception:
        return ""


def finalize(status, extractor, raw, structured, seed_warnings):
    text = normalize(raw)
    chars = len(text.strip())
    warnings = list(seed_warnings)
    if chars == 0 and status == "indexed":
        warnings.append("empty_text")
    if 0 < chars < 80:
        warnings.append("short_text")
    if chars >= 80:
        warnings.append("length_ok")
    if re.search(r"[가-힣]", text):
        warnings.append("korean_text_detected")
    eff = "failed" if (status == "indexed" and chars == 0) else status
    return {
        "status": eff,
        "extractor": extractor,
        "text": text,
        "textChars": chars,
        "qualityScore": score_text(eff, extractor, chars, structured, warnings),
        "warnings": sorted(set(warnings))[:20],
        "structured": structured,
    }


def extract(path: str, mime: str):
    with open(path, "rb") as f:
        data = f.read()
    lower = path.lower()

    if mime.startswith("text/"):
        return finalize("indexed", "text/plain", data.decode("utf-8", errors="replace"), False, ["text_layer"]), []

    if mime == "application/pdf" or lower.endswith(".pdf"):
        cands = pdf_candidates(data)
        results = [finalize("indexed", ex, tx, st, ["text_layer"]) for ex, tx, st in cands]
        # 텍스트레이어가 빈약하면 OCR 추가.
        best_chars = max((r["textChars"] for r in results), default=0)
        if best_chars < 80:
            octext, oex = ocr_multi(data)
            if octext.strip():
                results.append(finalize("indexed", oex, octext, False, ["ocr_fallback"]))
        if not results:
            return finalize("failed", "pdf", "", False, ["all_parsers_failed"]), []
        best = max(results, key=lambda r: r["qualityScore"])
        cand_summary = [{"extractor": r["extractor"], "chars": r["textChars"], "score": r["qualityScore"]} for r in results]
        return best, cand_summary

    if lower.endswith(".hwpx") or "hwpx" in mime:
        return finalize("indexed", "hwpx-xml", hwpx_structured(data), True, ["hwpx_section_xml"]), []

    if lower.endswith(".hwp") or "hwp" in mime:
        txt = hwp_binary(data)
        if txt.strip():
            return finalize("indexed", "hwp-bodytext", txt, False, ["hwp_binary"]), []
        return finalize("failed", "hwp", "", False, ["hwp_parse_failed"]), []

    if mime.startswith("image/"):
        octext, oex = image_ocr(data)
        return finalize("indexed", oex, octext, False, ["ocr_image"]), []

    return finalize("skipped", None, "", False, ["unsupported_mime"]), []


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"status": "failed", "extractor": None, "text": "", "textChars": 0, "qualityScore": 0, "warnings": ["bad_args"], "structured": False, "candidates": []}))
        return
    path, mime = sys.argv[1], sys.argv[2]
    # 파서 라이브러리들이 stdout에 진행/디버그 메시지를 뿜으므로(pymupdf4llm 등),
    # 추출 동안 stdout을 stderr로 리다이렉트하고 최종 JSON만 진짜 stdout에 쓴다.
    real_stdout = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result, candidates = extract(path, mime)
            result["candidates"] = candidates
        payload = json.dumps(result, ensure_ascii=False)
    except Exception as e:  # 절대 크래시하지 않고 실패 투명 기록.
        payload = json.dumps({"status": "failed", "extractor": None, "text": "", "textChars": 0, "qualityScore": 0, "warnings": [f"worker_error:{type(e).__name__}"], "structured": False, "candidates": []}, ensure_ascii=False)
    real_stdout.write(payload)
    real_stdout.write("\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()

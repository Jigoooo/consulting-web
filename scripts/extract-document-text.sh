#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  cat >&2 <<'USAGE'
Usage: scripts/extract-document-text.sh <input.pdf|image|hwp|hwpx> <output.txt>

Local document-intelligence extraction ladder:
1) PDF text layer: pdftotext -layout
2) scanned PDF/image OCR: tesseract kor+eng
3) HWPX: unzip XML text
4) HWP: hwp5txt when installed

Normal stdout: concise status line. Extracted text is written to output.txt.
USAGE
  exit 2
fi

IN="$1"
OUT="$2"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$(dirname "$OUT")"
: > "$OUT"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 127; }
}

char_count() {
  python3 - "$1" <<'PY'
import sys, pathlib
p=pathlib.Path(sys.argv[1])
print(len(p.read_text('utf-8', errors='ignore').strip()) if p.exists() else 0)
PY
}

ext="${IN##*.}"
ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

if [[ "$ext" == "pdf" ]]; then
  need pdftotext
  pdftotext -layout -enc UTF-8 "$IN" "$TMP/text.txt" || true
  text_len=$(char_count "$TMP/text.txt")
  if [[ "$text_len" -ge 80 ]]; then
    cp "$TMP/text.txt" "$OUT"
    echo "extractor=pdftotext chars=$text_len output=$OUT"
    exit 0
  fi

  need pdftoppm
  need tesseract
  pdftoppm -r 250 -png "$IN" "$TMP/page" >/dev/null
  shopt -s nullglob
  pages=("$TMP"/page-*.png)
  if [[ ${#pages[@]} -eq 0 ]]; then
    echo "no rendered pages for OCR" >&2
    exit 1
  fi
  for page in "${pages[@]}"; do
    tesseract "$page" stdout -l kor+eng --psm 3 >> "$OUT" 2>/dev/null || true
    printf '\n\n' >> "$OUT"
  done
  chars=$(char_count "$OUT")
  echo "extractor=ocr chars=$chars output=$OUT"
  exit 0
fi

if [[ "$ext" == "hwpx" ]]; then
  need unzip
  unzip -p "$IN" '*.xml' \
    | python3 -c "import html,re,sys; print(re.sub(r'\\s+', ' ', re.sub(r'<[^>]+>', ' ', html.unescape(sys.stdin.read()))).strip())" \
    > "$OUT"
  chars=$(char_count "$OUT")
  echo "extractor=hwpx chars=$chars output=$OUT"
  exit 0
fi

if [[ "$ext" == "hwp" ]]; then
  need hwp5txt
  hwp5txt "$IN" > "$OUT"
  chars=$(char_count "$OUT")
  echo "extractor=hwp5txt chars=$chars output=$OUT"
  exit 0
fi

need tesseract
tesseract "$IN" stdout -l kor+eng --psm 3 > "$OUT" 2>/dev/null || true
chars=$(char_count "$OUT")
echo "extractor=ocr chars=$chars output=$OUT"

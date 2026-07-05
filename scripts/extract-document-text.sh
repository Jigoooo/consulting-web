#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  cat >&2 <<'USAGE'
Usage: scripts/extract-document-text.sh <input.pdf|image> <output.txt>

Local document-intelligence extraction ladder:
1) PDF text layer: pdftotext -layout
2) scanned PDF/image OCR: tesseract kor+eng

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

ext="${IN##*.}"
ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

if [[ "$ext" == "pdf" ]]; then
  need pdftotext
  pdftotext -layout -enc UTF-8 "$IN" "$TMP/text.txt" || true
  text_len=$(python3 - "$TMP/text.txt" <<'PY'
import sys, pathlib
p=pathlib.Path(sys.argv[1])
print(len(p.read_text('utf-8', errors='ignore').strip()) if p.exists() else 0)
PY
)
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
else
  need tesseract
  tesseract "$IN" stdout -l kor+eng --psm 3 > "$OUT" 2>/dev/null || true
fi

chars=$(python3 - "$OUT" <<'PY'
import sys, pathlib
p=pathlib.Path(sys.argv[1])
print(len(p.read_text('utf-8', errors='ignore').strip()) if p.exists() else 0)
PY
)
echo "extractor=ocr chars=$chars output=$OUT"

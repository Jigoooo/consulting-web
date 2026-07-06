# apps/api — multi-stage build (pnpm monorepo aware)
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY tooling ./tooling
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @consulting/shared --filter @consulting/contracts --filter @consulting/db-schema --filter @consulting/api-client build \
 && pnpm --filter @consulting/api build
# prune dev deps for the runtime image
RUN pnpm --filter @consulting/api --prod deploy --legacy /out

FROM node:22-alpine AS runtime
RUN apk add --no-cache \
    pandoc typst weasyprint chromium font-noto-cjk \
    poppler-utils tesseract-ocr tesseract-ocr-data-kor tesseract-ocr-data-eng unzip \
    python3 py3-pip \
  && addgroup -S app && adduser -S app -G app
ENV CHROME_BIN=/usr/bin/chromium-browser
ENV TESSDATA_PREFIX=/usr/share/tessdata
WORKDIR /app
# 축6: 문서 추출 파이썬 사이드카(pymupdf4llm 레이아웃/표 + 다중 파서 비교 +
# 다중 OCR). alpine musllinux wheel이 전부 존재해 소스빌드 없이 설치된다.
COPY apps/api/extractor/requirements.txt ./extractor/requirements.txt
RUN python3 -m venv ./extractor/.venv \
  && ./extractor/.venv/bin/pip install --no-cache-dir -r ./extractor/requirements.txt
COPY apps/api/extractor/extractor_worker.py ./extractor/extractor_worker.py
COPY --from=build /out .
COPY --from=build /repo/apps/api/dist ./dist
# migration runner needs SQL files + a runtime-only JS script (no tsx/dev deps)
COPY --from=build /repo/packages/db-schema/drizzle ./drizzle-migrations
COPY --from=build /repo/apps/api/docker-migrate.mjs ./docker-migrate.mjs
RUN chown -R app:app /app && chmod 0644 /app/docker-migrate.mjs /app/drizzle-migrations/*.sql
USER app
EXPOSE 3000
CMD ["node", "dist/main.js"]

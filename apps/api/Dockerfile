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

# 축6: 문서 추출 파이썬 사이드카 venv를 python 3.12-alpine에서 빌드.
# node:22-alpine의 python은 3.14라 일부 wheel(pymupdf_layout)이 없어 실패하므로
# 검증된 3.12 musllinux wheel 조합으로 별도 stage에서 만들어 런타임에 복사한다.
# venv 절대경로가 박히므로 런타임과 동일 경로(/app/extractor/.venv)로 생성.
FROM python:3.12-alpine AS pybuild
WORKDIR /app/extractor
COPY apps/api/extractor/requirements.txt ./requirements.txt
RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir -r requirements.txt

FROM node:22-alpine AS runtime
RUN apk add --no-cache \
    pandoc typst weasyprint chromium font-noto-cjk \
    poppler-utils tesseract-ocr tesseract-ocr-data-kor tesseract-ocr-data-eng unzip \
    libstdc++ \
  && addgroup -S app && adduser -S app -G app
ENV CHROME_BIN=/usr/bin/chromium-browser
ENV TESSDATA_PREFIX=/usr/share/tessdata
WORKDIR /app
# 축6: 파이썬 사이드카 — python 3.12 인터프리터 전체(/usr/local)와 venv를 복사.
# venv의 bin/python은 /usr/local/bin/python3.12 를 가리키므로 인터프리터도 함께
# 가져와야 실행된다(런타임 node 이미지엔 3.14만 있어 무관하게 독립 동작).
COPY --from=pybuild /usr/local /usr/local
COPY --from=pybuild /app/extractor/.venv ./extractor/.venv
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

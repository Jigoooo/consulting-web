# apps/api — multi-stage build (pnpm monorepo aware)
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS base
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

# 축6 + GraphRAG bridge: 문서 추출 venv와 dialogue_memory 런타임 의존성을
# python 3.12 slim(glibc)에서 빌드한다. Alpine/musl에는 onnxruntime wheel이 없어
# cross-encoder rerank가 영구 fallback되므로 glibc 기반이 필수다.
# venv 절대경로가 박히므로 런타임과 동일 경로(/app/extractor/.venv)로 생성.
FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b AS pybuild
WORKDIR /app/extractor
COPY apps/api/extractor/requirements.txt ./requirements.txt
COPY apps/api/requirements-graphrag.txt /tmp/requirements-graphrag.txt
RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir -r requirements.txt \
  && python3 -m pip install --no-cache-dir -r /tmp/requirements-graphrag.txt

FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS runtime
ARG TYPST_VERSION=0.14.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils \
    pandoc weasyprint chromium fonts-noto-cjk \
    poppler-utils tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng unzip libstdc++6 \
  && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
    | tar -xJ -C /tmp \
  && install -m 0755 "/tmp/typst-x86_64-unknown-linux-musl/typst" /usr/local/bin/typst \
  && rm -rf /var/lib/apt/lists/* /tmp/typst-x86_64-unknown-linux-musl
ENV CHROME_BIN=/usr/bin/chromium
ENV TESSDATA_PREFIX=/usr/share/tessdata
WORKDIR /app
# 축6: 파이썬 사이드카 — python 3.12 인터프리터 전체(/usr/local)와 venv를 복사.
# venv의 bin/python은 /usr/local/bin/python3.12 를 가리키므로 인터프리터도 함께
# 가져와야 실행된다(런타임 node 이미지엔 3.14만 있어 무관하게 독립 동작).
COPY --from=pybuild /usr/local /usr/local
COPY --from=pybuild /app/extractor/.venv ./extractor/.venv
COPY apps/api/extractor/extractor_worker.py ./extractor/extractor_worker.py
COPY apps/api/scripts ./scripts
COPY --from=build /out .
COPY --from=build /repo/apps/api/dist ./dist
# migration runner needs SQL files + a runtime-only JS script (no tsx/dev deps)
COPY --from=build /repo/packages/db-schema/drizzle ./drizzle-migrations
COPY --from=build /repo/apps/api/docker-migrate.mjs ./docker-migrate.mjs
RUN chown -R node:node /app && chmod 0644 /app/docker-migrate.mjs /app/drizzle-migrations/*.sql /app/scripts/*.py
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

# apps/web — build static bundle, serve via nginx with /api reverse proxy
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY tooling ./tooling
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @consulting/shared --filter @consulting/contracts --filter @consulting/api-client build \
 && pnpm --filter @consulting/web build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# Normalize permissions: COPY preserves host modes; a 600 file (umask quirk)
# would 403 under the non-root nginx workers. Make world-readability structural.
RUN find /usr/share/nginx/html -type d -exec chmod 755 {} + \
 && find /usr/share/nginx/html -type f -exec chmod 644 {} +
EXPOSE 80

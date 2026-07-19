# Consulting Web 이미지 복구

`docker-compose.prod.yml`의 기본 web image는 검증된 로컬 image ID로 고정된다. 해당 image가 prune됐거나 새 호스트에서 존재하지 않으면 다음 절차로 현재 commit의 web image를 다시 만든다.

## 전제 조건

- 복구 대상 commit의 clean checkout
- Docker와 pnpm lockfile 접근 가능
- `.env.docker`의 운영 secret 준비
- API가 `healthy` 상태

## 빌드

```bash
set -euo pipefail
commit=$(git rev-parse --short=12 HEAD)
tag="consulting-web:recovery-$commit"
docker build --pull=false -f apps/web/Dockerfile -t "$tag" .
image_id=$(docker image inspect "$tag" --format '{{.Id}}')
printf 'CONSULTING_WEB_IMAGE=%s\n' "$image_id" > "$HOME/.hermes/secrets/consulting-web-image.env"
chmod 600 "$HOME/.hermes/secrets/consulting-web-image.env"
```

base image는 Dockerfile digest로, JavaScript 의존성은 `pnpm-lock.yaml`로 고정된다. 빌드가 끝나기 전에는 기존 web 컨테이너를 제거하지 않는다.

## 후보 검증

```bash
docker run --rm --network consulting-web_default "$tag" nginx -t
```

image 내부에 외부 제품 proxy가 없는지도 확인한다.

```bash
if docker run --rm --network consulting-web_default "$tag" nginx -T 2>&1 \
  | grep -Eq 'listen 81|stock-insight|stock_insight'; then
  exit 1
fi
```

## 적용

```bash
set -a
. "$HOME/.hermes/secrets/consulting-web-image.env"
set +a
docker compose --env-file .env.docker -f docker-compose.prod.yml \
  up -d --no-deps --force-recreate web
curl -fsS http://127.0.0.1:8088/ >/dev/null
curl -fsS https://consulting.jigooo.com/ >/dev/null
```

검증된 image ID가 source 기본값과 다르면 다음 운영 커밋에서 `CONSULTING_WEB_IMAGE` 기본 digest를 새 ID로 갱신한다. 그전에는 모든 compose 적용에서 `consulting-web-image.env`를 source한 shell을 사용한다.

## 되돌리기

이전 image ID가 남아 있으면 같은 env 파일의 값만 이전 ID로 바꾼 뒤 `web` 서비스만 force-recreate한다. API·DB·중립 edge gateway는 재생성하지 않는다.

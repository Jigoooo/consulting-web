# Consulting Brain 명명 정합화 + GraphRAG 미배선 인계 설계서

> **For Hermes:** 새 세션에서는 먼저 `consulting-web-architecture`, `consulting-advanced-graphrag-hardening`, 필요 시 `ts-monorepo-docker-deployment` 스킬을 로드한 뒤 이 문서를 기준으로 이어간다. 이 문서는 이미 완료된 작업과 아직 남은 구현/승인 게이트를 혼동하지 않게 하기 위한 handoff + 설계서다.

**작성 시각:** 2026-07-07 15:20:29 KST  
**주요 repo:**
- Web/API interface: `/home/jigoo/.hermes/workspace/consulting-web`
- Shared core brain: `/home/jigoo/.hermes/workspace/consulting`

**핵심 결론:** `/home/jigoo/.hermes/workspace/consulting`은 폐기될 legacy가 아니라 Telegram/Discord/Web이 함께 쓰는 **shared consulting brain**이다. `consulting-web`은 이 두뇌 위의 Web/API interface다. 따라서 런타임 명칭은 `legacy`가 아니라 `brain`이어야 한다.

---

## 0. 절대 혼동 금지

| 구분 | 금지/이전 표현 | 현재 정식 표현 |
|---|---|---|
| env root | `CONSULTING_LEGACY_ROOT` | `CONSULTING_BRAIN_ROOT` |
| container mount | `/legacy/consulting` | `/brain/consulting` |
| env file path | `/legacy/hermes.env` | `/brain/hermes.env` |
| Hermes config path | `/legacy/hermes.config.yaml` | `/brain/hermes.config.yaml` |
| repo 의미 | legacy consulting repo | shared consulting brain / core brain |
| web 의미 | legacy replacement | brain 위의 web/API interface |

**주의:** `pnpm --legacy`는 pnpm 공식 deploy 옵션이므로 consulting brain 명명과 무관하다. 이 옵션은 바꾸면 안 된다.

---

## 1. 지금까지 완료한 것

### 1.1 consulting-web 런타임 경로/환경변수 정합화

완료된 변경:
- `apps/api/src/consulting/consulting-graphrag-bridge.service.ts`
  - 기본 container root 감지: `/brain/consulting`
  - env: `process.env.CONSULTING_BRAIN_ROOT`
- `apps/api/scripts/ingest_web_dialogue.py`
  - 기본 root: `/brain/consulting`
  - env: `CONSULTING_BRAIN_ROOT`
  - 문서 문자열: shared consulting brain으로 정정
- `apps/api/scripts/graphrag_eval_gate.py`
  - `DEFAULT_BRAIN_ROOT`
  - CLI arg: `--brain-root`
- `apps/api/scripts/ralph_graphrag_hardening.py`
  - `BRAIN_ROOT`, `BRAIN_TESTS`, `brain_db_contracts`
  - Docker runtime probe도 `/brain/consulting` 기준
- `apps/api/requirements-graphrag.txt`
  - 주석 경로 `/brain/consulting`
- `docker-compose.prod.yml`
  - `HERMES_CONFIG_PATH=/brain/hermes.config.yaml`
  - `CONSULTING_BRAIN_ROOT=/brain/consulting`
  - `HERMES_ENV_FILE=/brain/hermes.env`
  - volumes도 `/brain/*` 기준
- `packages/db-schema/src/schema/consulting-bridge.ts`
  - legacy/authoritative 표현 제거, shared consulting brain으로 정정

관련 커밋 상태:
- `consulting-web` 최근 커밋:
  - `c5d3691 docs: align consulting brain terminology`
  - `b9f9cdd chore: rename consulting brain runtime paths`
  - `f424971 Polish context panel collapse behavior`
  - `8e50396 Package consulting GraphRAG runtime for Docker`
  - `1db6fd5 Harden consulting GraphRAG bridge and gates`
- `consulting-web` working tree: clean 확인됨.

### 1.2 테스트명/문서/스킬 정합화

완료된 변경:
- 테스트명에서 `legacy CLI/ingest` 표현을 `consulting brain CLI/ingest`로 수정.
- `plans/consulting-web-roadmap.md`에서 `/brain/*`, shared GraphRAG bridge 표현으로 수정.
- `.hermes/plans/2026-07-07_*` handoff 문서의 구 경로 예시를 `/brain/*`로 수정.
- Hermes skill 문서 갱신:
  - `consulting-web-architecture`
  - `consulting-advanced-graphrag-hardening`
  - 관련 reference 파일들 안의 `/legacy/consulting`, `CONSULTING_LEGACY_ROOT`, legacy brain 표현 제거.

검증:
```bash
# consulting-web repo old refs
 git grep -n -E 'CONSULTING_LEGACY_ROOT|/legacy/consulting|/legacy/hermes|legacy CLI|legacy ingest|legacy GraphRAG|legacy recall|legacy JSON|legacy `consulting`|legacy/authoritative|legacy dialogue_memory|legacy repo|legacy DB|legacy tests|legacy_root|DEFAULT_LEGACY|LEGACY_ROOT|LEGACY_TESTS|legacy_db' -- . ':(exclude)pnpm-lock.yaml'
# 결과: 0건

# skill refs
search_files(... consulting-web-architecture ...)
search_files(... consulting-advanced-graphrag-hardening ...)
# 결과: 0건
```

### 1.3 consulting shared brain repo 주석 정합화

완료된 변경:
- `/home/jigoo/.hermes/workspace/consulting/scripts/advanced_graphrag_layers.py`
  - `consulting legacy SQLite SoT` → `shared consulting brain SQLite SoT`
- `/home/jigoo/.hermes/workspace/consulting/scripts/advanced_graphrag_write_guard.py`
  - `legacy consulting.db source-of-truth` → `shared consulting brain consulting.db source-of-truth`

현재 상태:
- `consulting` repo에는 위 2파일이 **아직 uncommitted** 상태다.
- 변경은 주석/문구 정합화만이며 기능 변경은 아니다.

현재 `consulting` status:
```text
 M scripts/advanced_graphrag_layers.py
 M scripts/advanced_graphrag_write_guard.py
```

---

## 2. 실제 검증 결과

### 2.1 focused gate

명령:
```bash
cd /home/jigoo/.hermes/workspace/consulting-web
pnpm --filter @consulting/api exec vitest run \
  test/consulting-graphrag-bridge-advanced.test.ts \
  test/consulting-graphrag-bridge.test.ts \
  test/consulting-web-ingest-worker.test.ts --reporter=dot \
  && pnpm --filter @consulting/api typecheck \
  && docker compose --env-file .env.docker -f docker-compose.prod.yml config --quiet
```

결과:
```text
Test Files  3 passed (3)
Tests       7 passed (7)
tsc --noEmit passed
compose config passed
```

### 2.2 full-ish build/deploy gate

명령:
```bash
pnpm build
pnpm lint
docker compose --env-file .env.docker -f docker-compose.prod.yml build api
```

결과:
- `pnpm build`: passed
- `pnpm lint`: passed
- API image build: `consulting-web-api:latest` built

### 2.3 API 컨테이너 교체 및 health

명령:
```bash
docker compose --env-file .env.docker -f docker-compose.prod.yml up -d --force-recreate --no-deps api
```

결과:
```text
api_health=healthy
```

현재 API env/mount:
```text
HERMES_CONFIG_PATH=/brain/hermes.config.yaml
HERMES_ENV_FILE=/brain/hermes.env
CONSULTING_BRAIN_ROOT=/brain/consulting
---MOUNTS---
/home/jigoo/.hermes/.env => /brain/hermes.env
/home/jigoo/.hermes/config.yaml => /brain/hermes.config.yaml
/home/jigoo/.hermes/workspace/consulting => /brain/consulting
```

Health endpoint:
```bash
curl -fsS http://127.0.0.1:8088/api/health/ready
```

결과 요약:
```json
{
  "status": "ok",
  "components": {
    "api": "ok",
    "db": "ok",
    "redis": "ok",
    "bullmq": "ok",
    "hermes": "ok"
  }
}
```

### 2.4 컨테이너 내부 GraphRAG recall runtime proof

명령:
```bash
docker exec -e CONSULTING_EMBED_FAKE=1 -e CONSULTING_RERANK_PRUNE=4 consulting-web-api-1 sh -lc '
  cd /brain/consulting
  python3 scripts/dialogue_memory_cli.py recall \
    --topic changwon-org-mgmt-diagnosis \
    --q "정원 인건비 조직진단" \
    --top-k 2 \
    --format json \
    --rerank > /tmp/brain-recall.json
  python3 - <<'"'"'PY'"'"'
import json
j=json.load(open("/tmp/brain-recall.json", encoding="utf-8"))
h=(j.get("hits") or [{}])[0]
assert j.get("rerank")=="cross-encoder", j.get("rerank")
assert not j.get("rerank_error"), j.get("rerank_error")
assert "signal_breakdown" in h, h
print(json.dumps({"rerank":j.get("rerank"),"hits":len(j.get("hits") or []),"status":"ok"}, ensure_ascii=False))
PY'
```

결과:
```json
{"rerank": "cross-encoder", "hits": 2, "status": "ok"}
```

### 2.5 ralph smoke

명령:
```bash
python3 apps/api/scripts/ralph_graphrag_hardening.py \
  --iterations 1 \
  --skip-docker \
  --output artifacts/ralph-brain-rename-smoke.json
```

결과:
```json
{
  "ok": true,
  "iterations": 1,
  "static_failures": [],
  "brain_db": {
    "ok": true,
    "failed_consulting_web_embeddings": 0,
    "dialogue_fts_orphans": 0,
    "changwon_claims": 15,
    "context_only_cross_topic_links": 2
  }
}
```

### 2.6 core brain pytest

명령:
```bash
cd /home/jigoo/.hermes/workspace/consulting
.venv/bin/python3 -m pytest \
  scripts/tests/test_advanced_graphrag_write_guard.py \
  scripts/tests/test_community_report_layer.py -q
```

결과:
```text
5 passed in 0.03s
```

---

## 3. DB/코드 기준 현재 미배선 상태

운영 DB 실측:
```sql
select edge_type, origin, count(*)
from context_edges
where deleted_at is null
group by edge_type, origin;
```

결과:
```text
parent_of | system | 36
```

추가 실측:
```text
topic_memory: 9/13 non-null
topic_links: active 2
```

해석:
- `context_edges` schema에는 `related_to`, `references`, `shares_memory_with`가 있지만 live edge는 아직 없다.
- 즉 scope tree의 부모-자식 관계는 살아 있지만, 범용 cross-reference graph는 아직 완전 배선되지 않았다.
- `topics.memory_topic_id`는 일부만 채워져 있다. core bridge는 작동하지만 모든 topic이 consulting brain topic에 완전 연결된 상태는 아니다.

---

## 4. Leiden/igraph 설명 및 현재 상태

### 4.1 무엇인가

- `igraph`: 그래프 노드/엣지를 효율적으로 다루는 그래프 라이브러리.
- `leidenalg`: Leiden 알고리즘으로 그래프에서 “서로 강하게 연결된 커뮤니티”를 찾는 라이브러리.
- GraphRAG에서는 claim/entity/chunk graph를 큰 주제 묶음으로 나누고 community summary를 만들 때 사용한다.

### 4.2 왜 무거운 의존성인가

- native extension/wheel이 들어가 Docker 빌드와 런타임 호환성 리스크가 생긴다.
- API 이미지 크기와 빌드 시간이 증가한다.
- community summary를 SoT인 `consulting.db`에 쓰면 데이터 계보/검증/롤백 문제가 생긴다.

### 4.3 현재 구현 상태

현재는 true Leiden이 아니라 안전 fallback만 사용한다.

파일:
- `/home/jigoo/.hermes/workspace/consulting/scripts/advanced_graphrag_layers.py`

현재 방식:
- `connected_components_no_dep`
- 외부 의존성 없이 연결 컴포넌트 기반 community report 생성 가능
- `metadata_json.method = "connected_components_no_dep"`

승인 가드:
- `/home/jigoo/.hermes/workspace/consulting/scripts/advanced_graphrag_write_guard.py`

중요 env:
```bash
CONSULTING_ADVANCED_GRAPHRAG_DEPS_APPROVED=YES   # igraph/leidenalg 같은 새 무거운 의존성 승인
CONSULTING_ADVANCED_GRAPHRAG_WRITE_APPROVED=YES  # consulting.db SoT write 승인
```

현재 판단:
- Leiden/igraph는 아직 설치/배선하지 않는 것이 맞다.
- 먼저 no-dep fallback과 context graph 배선을 안정화한 뒤, 품질 개선이 명확할 때 별도 승인으로 진행한다.

---

## 5. 남은 구현/배선 설계

### Lane A — core brain 주석 정합화 마무리

**목표:** 현재 `consulting` repo의 uncommitted 주석 변경을 검증 후 커밋할지 결정.

파일:
- `/home/jigoo/.hermes/workspace/consulting/scripts/advanced_graphrag_layers.py`
- `/home/jigoo/.hermes/workspace/consulting/scripts/advanced_graphrag_write_guard.py`

검증 명령:
```bash
cd /home/jigoo/.hermes/workspace/consulting
.venv/bin/python3 -m pytest \
  scripts/tests/test_advanced_graphrag_write_guard.py \
  scripts/tests/test_community_report_layer.py -q

git diff --check
```

권장 커밋:
```bash
git add scripts/advanced_graphrag_layers.py scripts/advanced_graphrag_write_guard.py
git commit -m "docs: align consulting brain GraphRAG terminology"
```

주의:
- 주인님이 명시 요청하기 전 push 금지.

### Lane B — context_edges 범용 graph 활성화

**목표:** schema-only 상태인 `related_to`, `references`, `shares_memory_with`를 실제 write/read 흐름에 연결.

현재 근거:
- `packages/db-schema/src/schema/context-graph.ts`
  - `contextEdges` table 있음
  - `edgeType` enum에 관련 타입 있음
- 운영 DB live edge는 `parent_of/system`뿐.

필요 작업:
1. `related_to/manual` 생성 usecase/API
2. `references/manual|system` 생성 usecase/API
3. `context_edges` read traversal service
4. Chat context builder에 1-hop related scopes 주입
5. cross-project 라벨과 confidence 감쇠 유지
6. archived/deleted scope는 read traversal에서 제외

예상 파일:
- `apps/api/src/spaces/*context-edge*.service.ts` 또는 신규 `context-graph` module
- `apps/api/src/consulting/consulting-memory-context.builder.ts`
- `packages/contracts/src/*`
- `packages/api-client/src/client.ts`
- 관련 API/web tests

검증:
```bash
pnpm --filter @consulting/api exec vitest run test/*context* test/consulting-memory-context.builder.test.ts --reporter=dot
pnpm --filter @consulting/api typecheck
```

### Lane C — tag-overlap classifier 배선

**목표:** `ScopeTagSeedService`로 seed된 tag를 사용해 자동 `related_to/classifier` edge를 생성.

현재 상태:
- `apps/api/src/spaces/scope-tag-seed.service.ts` 존재
- seed/preview는 있음
- tag overlap → `related_to` edge 생성 job/usecase는 아직 미완

필요 작업:
1. seed preview/readiness API 추가 또는 내부 command 추가
2. workspace 내 scope tag 교집합 계산
3. 공유 tag ≥2개면 `related_to/classifier` edge 생성
4. cross-project edge에는 감쇠/라벨 부여
5. idempotent 보장

검증 SQL:
```sql
select edge_type, origin, count(*)
from context_edges
where deleted_at is null
group by edge_type, origin;
```

기대:
```text
parent_of | system     | ...
related_to | classifier | N
```

### Lane D — memory_topic_id / consulting_topic_links 완전성 점검

**목표:** active topic 13개 중 9개만 `memory_topic_id`가 있는 이유를 분류하고, 필요한 것만 매핑.

현재 실측:
```text
topic_memory: 9/13
consulting_topic_links active: 2
```

필요 판단:
- 모든 topic이 consulting brain topic에 연결되어야 하는가?
- 아니면 실제 컨설팅 brain 연동 대상만 연결하면 되는가?

권장 방식:
1. read-only 목록 출력
2. null 4개 topic의 이름/slug/project 확인
3. 자동 매핑하지 말고 주인님 확인 또는 안전 규칙으로 분류

금지:
- 의미 모르는 topic을 기존 changwon brain에 억지 연결하지 말 것.

### Lane E — true Leiden/igraph 선택 의존성 승인 후 구현

**목표:** no-dep connected component보다 품질 높은 community detection 도입.

전제:
- `CONSULTING_ADVANCED_GRAPHRAG_DEPS_APPROVED=YES` 명시 승인
- Docker build/size/compatibility 승인
- 실제 품질 이득이 검증 가능해야 함

구현 방향:
1. requirements에 `igraph`, `leidenalg` 후보 추가
2. Docker image build 검증
3. `require_dependency_approval("leiden", ["igraph", "leidenalg"])` 통과
4. fallback은 유지
5. `metadata_json.method`에 `leiden` vs `connected_components_no_dep` 명시

검증:
```bash
docker run --rm consulting-web-api:latest python3 - <<'PY'
import igraph, leidenalg
print('leiden-import-ok')
PY
```

품질 검증:
- community count
- source_chunk_ids non-empty
- citation/source lineage 유지
- RAGAS/ralph metric 악화 없음

### Lane F — advanced GraphRAG SoT write 운영화

**목표:** RAPTOR/community derived rows를 실제 shared brain DB에 쓰는 운영 절차 확정.

전제:
- `CONSULTING_ADVANCED_GRAPHRAG_WRITE_APPROVED=YES` 명시 승인
- additive-only, idempotent, source_chunk_ids 보존

현재 구현:
- `write_raptor_summaries`
- `write_community_reports`
- `search_tog2_deep`
- `advanced_graphrag_nodes` table ensure

미완/주의:
- live 운영에서 어떤 topic에 언제 write할지 runbook 필요
- rollback/delete policy 필요
- generated advanced rows를 UI/보고서에서 어떻게 라벨링할지 필요

---

## 6. 새 세션 시작 절차

새 세션에서 아래 순서로 시작한다.

### Step 1 — 스킬 로드

```text
skill_view('consulting-web-architecture')
skill_view('consulting-advanced-graphrag-hardening')
skill_view('ts-monorepo-docker-deployment')  # Docker deploy를 건드릴 때만
```

### Step 2 — 상태 재확인

```bash
cd /home/jigoo/.hermes/workspace/consulting-web
git status --short
git log --oneline -5

git -C /home/jigoo/.hermes/workspace/consulting status --short
git -C /home/jigoo/.hermes/workspace/consulting log --oneline -5
```

### Step 3 — 런타임 경로 확인

```bash
docker inspect consulting-web-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}---MOUNTS---{{range .Mounts}}{{println .Source "=>" .Destination}}{{end}}' \
  | grep -E 'CONSULTING_(BRAIN|LEGACY)_ROOT|HERMES_ENV_FILE|HERMES_CONFIG_PATH|/brain|/legacy|---MOUNTS---' || true
```

기대:
```text
CONSULTING_BRAIN_ROOT=/brain/consulting
HERMES_ENV_FILE=/brain/hermes.env
HERMES_CONFIG_PATH=/brain/hermes.config.yaml
# legacy는 없어야 함
```

### Step 4 — DB 미배선 실측

```bash
cat >/tmp/consulting_web_unwired_probe.sql <<'SQL'
select 'edge_type' as section, edge_type::text as key, origin::text as subkey, count(*)::text as value
from context_edges
where deleted_at is null
group by edge_type, origin
order by edge_type, origin;

select 'topic_memory' as section, 'non_null' as key, 'total' as subkey,
       (count(*) filter (where memory_topic_id is not null))::text || '/' || count(*)::text as value
from topics
where deleted_at is null;

select 'topic_links' as section, status as key, '' as subkey, count(*)::text as value
from consulting_topic_links
group by status
order by status;
SQL

docker cp /tmp/consulting_web_unwired_probe.sql consulting-web-pg-1:/tmp/unwired_probe.sql
docker exec consulting-web-pg-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/unwired_probe.sql'
```

현재 baseline:
```text
edge_type: parent_of/system = 36
topic_memory: 9/13
topic_links: active = 2
```

---

## 7. 위험/금지사항

- `CONSULTING_LEGACY_ROOT` 또는 `/legacy/consulting`를 코드/compose에 다시 넣지 말 것.
- Leiden/igraph는 explicit approval 전 설치하지 말 것.
- `CONSULTING_ADVANCED_GRAPHRAG_WRITE_APPROVED=YES` 없이 live `consulting.db`에 derived rows 쓰지 말 것.
- Changwon Telegram 비개발자 토픽에는 내부 구조, CLI, 파일 경로를 노출하지 말 것.
- `consulting-web`을 core brain의 대체물처럼 설명하지 말 것.
- DB credential/API key/env 내용을 출력하지 말 것.
- push는 주인님 명시 요청 전 금지.

---

## 8. 추천 다음 순서

1. `consulting` repo의 주석 정합화 2파일을 검증 후 커밋할지 결정.
2. `context_edges` graph activation 설계/구현:
   - manual `related_to/references`
   - read traversal
   - chat context injection
3. `ScopeTagSeedService` 기반 classifier edge 생성.
4. `memory_topic_id` null 4개 topic 분류.
5. 이후 true Leiden/igraph 필요성 재평가.

**추천 판단:** 지금 바로 Leiden/igraph로 가지 말고, 먼저 context graph의 write/read 배선을 완성하는 것이 더 안전하다. 현재 운영 DB는 `parent_of/system`만 있으므로 Leiden을 넣어도 web scope 간 cross-reference 품질 문제를 바로 해결하지 못한다.

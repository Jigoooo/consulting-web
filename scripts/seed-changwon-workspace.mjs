#!/usr/bin/env node
const baseUrl = process.env.CONSULTING_BASE_URL || 'https://consulting.jigooo.com/api';
const email = process.env.CHANGWON_SEED_EMAIL;
const password = process.env.CHANGWON_SEED_PASSWORD;
const displayName = process.env.CHANGWON_SEED_NAME || '창원시 컨설팅 운영자';
if (!email || !password) {
  console.error('CHANGWON_SEED_EMAIL and CHANGWON_SEED_PASSWORD are required');
  process.exit(2);
}
async function request(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} failed ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
async function loginOrSignup() {
  try {
    await request('/auth/signup', { method: 'POST', body: { email, password, displayName } });
  } catch (e) {
    if (e.status !== 409) throw e;
  }
  const session = await request('/auth/login', { method: 'POST', body: { email, password } });
  return session.tokens.accessToken;
}
function byName(items, name) { return items.find((x) => x.name === name || x.title === name); }
const slugs = new Map([
  ['창원시 컨설팅', 'changwon-consulting'],
  ['자료수집', 'source-collection'],
  ['공공시설 기초자료', 'facility-baseline'],
  ['회의·요청사항', 'meeting-requests'],
  ['분석', 'analysis'],
  ['시설 적정성 진단', 'facility-adequacy'],
  ['이관·통합 검토', 'transfer-integration'],
  ['보고서', 'reports'],
  ['중간보고서', 'interim-report'],
  ['최종보고서', 'final-report'],
  ['질의응답', 'qna'],
  ['실무자 질문', 'practitioner-questions'],
]);
function slugFor(name) { return slugs.get(name) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item'; }
async function main() {
  const token = await loginOrSignup();
  const workspaces = await request('/spaces/workspaces', { token });
  const ws = workspaces.workspaces[0];
  if (!ws) throw new Error('no workspace after signup');
  let tree = await request(`/spaces/workspaces/${ws.id}/tree`, { token });
  let project = byName(tree.projects, '창원시 컨설팅');
  if (!project) {
    const created = await request('/spaces/projects', { method: 'POST', token, body: { workspaceId: ws.id, name: '창원시 컨설팅', slug: slugFor('창원시 컨설팅') } });
    project = { id: created.id, name: '창원시 컨설팅' };
  }
  const desired = [
    ['자료수집', [['공공시설 기초자료', '자료 원본과 출처를 정리합니다.'], ['회의·요청사항', '회의 중 나온 요청과 확인사항을 남깁니다.']]],
    ['분석', [['시설 적정성 진단', '선별지표와 최종판정을 분리해서 검토합니다.'], ['이관·통합 검토', '상대우위와 서비스 연속성 근거를 확인합니다.']]],
    ['보고서', [['중간보고서', '중간 공유용 산출물을 버전으로 관리합니다.'], ['최종보고서', '대외 공유 문구와 근거를 정리합니다.']]],
    ['질의응답', [['실무자 질문', '비개발자 질문과 답변을 한 곳에 모읍니다.']]],
  ];
  let createdCount = 0;
  for (const [channelName, topics] of desired) {
    tree = await request(`/spaces/workspaces/${ws.id}/tree`, { token });
    const fullProject = tree.projects.find((p) => p.id === project.id);
    let channel = byName(fullProject?.channels || [], channelName);
    if (!channel) {
      const res = await request('/spaces/channels', { method: 'POST', token, body: { projectId: project.id, name: channelName, slug: slugFor(channelName) } });
      channel = { id: res.id, name: channelName, topics: [] };
      createdCount++;
    }
    for (const [topicName, threadTitle] of topics) {
      tree = await request(`/spaces/workspaces/${ws.id}/tree`, { token });
      const p2 = tree.projects.find((p) => p.id === project.id);
      const c2 = byName(p2?.channels || [], channelName);
      let topic = byName(c2?.topics || [], topicName);
      if (!topic) {
        const res = await request('/spaces/topics', { method: 'POST', token, body: { channelId: channel.id, name: topicName, slug: slugFor(topicName) } });
        topic = { id: res.id, name: topicName };
        createdCount++;
      }
      const threads = await request(`/spaces/topics/${topic.id}/threads`, { token });
      if (!byName(threads.threads || [], threadTitle)) {
        await request('/spaces/threads', { method: 'POST', token, body: { topicId: topic.id, title: threadTitle } });
        createdCount++;
      }
    }
  }
  console.log(JSON.stringify({ ok: true, workspaceId: ws.id, projectId: project.id, createdCount }, null, 2));
}
main().catch((e) => {
  console.error(JSON.stringify({ ok: false, message: e.message, status: e.status, data: e.data }, null, 2));
  process.exit(1);
});

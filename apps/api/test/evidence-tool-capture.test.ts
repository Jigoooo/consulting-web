import { describe, expect, it, vi } from 'vitest';
import { captureToolEvidence, classifyTool, EvidenceStore, type CapturedToolUse } from '../src/chat/evidence.store.js';

describe('tool evidence capture', () => {
  it('captures only completed public-web results, not started arguments', () => {
    const uses: CapturedToolUse[] = [];

    captureToolEvidence(uses, {
      tool: 'web_search',
      phase: 'started',
      preview: '{"query":"승진소요최저연수"}',
    });
    expect(uses).toEqual([]);
    captureToolEvidence(uses, {
      tool: 'web_search',
      phase: 'completed',
      preview: '지방공무원 임용령: 승진소요최저연수는 승진임용에 필요한 재직기간이다. https://law.go.kr/example',
    });

    expect(uses).toEqual([{
      tool: 'web_search',
      preview: '지방공무원 임용령: 승진소요최저연수는 승진임용에 필요한 재직기간이다. https://law.go.kr/example',
    }]);
  });

  it('keeps concurrent same-tool completed results as independent evidence rows', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, { tool: 'web_search', phase: 'started', preview: 'query A' });
    captureToolEvidence(uses, { tool: 'web_search', phase: 'started', preview: 'query B' });
    captureToolEvidence(uses, { tool: 'web_search', phase: 'completed', preview: 'result B' });
    captureToolEvidence(uses, { tool: 'web_search', phase: 'completed', preview: 'result A' });

    expect(uses).toEqual([
      { tool: 'web_search', preview: 'result B' },
      { tool: 'web_search', preview: 'result A' },
    ]);
  });

  it('does not auto-persist completed GBrain, file, browser, or terminal output', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, { tool: 'mcp__gbrain__get_page', phase: 'completed', preview: 'private personal page' });
    captureToolEvidence(uses, { tool: 'read_file', phase: 'completed', preview: 'PASSWORD=secret' });
    captureToolEvidence(uses, { tool: 'browser_snapshot', phase: 'completed', preview: 'authenticated page' });
    captureToolEvidence(uses, { tool: 'terminal', phase: 'completed', preview: 'DATABASE_URL=secret' });
    captureToolEvidence(uses, { tool: 'mcp__gbrain__web_search_private', phase: 'completed', preview: 'private nested tool output' });

    expect(uses).toEqual([]);
    expect(classifyTool('mcp__gbrain__query')).toBe('gbrain');
  });

  it('redacts common secrets and email addresses from public-web results', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'web_extract',
      phase: 'completed',
      preview: 'Authorization: Bearer sk-live-example password=hunter2 contact=user@example.com',
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).toContain('[REDACTED]');
    expect(uses[0]?.preview).not.toMatch(/«redacted:sk-…»|hunter2|user@example\.com/u);
  });

  it('redacts sensitive JSON keys and quoted authorization headers', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'functions.web_extract',
      phase: 'completed',
      preview: '{"api_key":"json-key-value","password":"json-password-value","Authorization":"Bearer json-bearer-value","nested":{"access_token":"json-token-value"}}',
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).not.toMatch(/json-key-value|json-password-value|json-bearer-value|json-token-value/u);
    expect(uses[0]?.preview).toContain('[REDACTED]');
  });

  it('redacts a truncated PEM private key through the end of the preview', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'web_extract',
      phase: 'completed',
      preview: '-----BEGIN PRIVATE KEY-----\nTRUNCATED_PRIVATE_KEY_BODY',
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts Basic auth, cookies, database URIs, and unlabeled JWTs', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'web_extract',
      phase: 'completed',
      preview: [
        'Authorization: Basic basic-secret-value',
        'Cookie: sid=cookie-secret-value; theme=dark',
        'Set-Cookie: refresh=set-cookie-secret-value; HttpOnly',
        'postgresql://dbuser:db-password-value@db.example.com/app',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.jwt-signature-secret',
      ].join('\n'),
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).not.toMatch(/basic-secret-value|cookie-secret-value|set-cookie-secret-value|db-password-value|jwt-signature-secret/u);
  });

  it('redacts credential JSON keys and signed URL query values', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'functions.web_search',
      phase: 'completed',
      preview: JSON.stringify({
        private_key: 'json-private-key-value',
        credential: 'json-credential-value',
        session: 'json-session-value',
        cookie: 'json-cookie-value',
        url: 'https://bucket.example.com/report.pdf?X-Amz-Credential=credential-value&X-Amz-Signature=signature-value',
      }),
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).not.toMatch(/json-private-key-value|json-credential-value|json-session-value|json-cookie-value|credential-value|signature-value/u);
    expect(uses[0]?.preview).toContain('REDACTED');
  });

  it('redacts malformed quoted headers, Google signatures, extended database URIs, and short JWTs', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'web_extract',
      phase: 'completed',
      preview: [
        'prefix {"Authorization":"Bearer malformed-bearer-secret","Cookie":"sid=malformed-cookie-secret"} suffix',
        'escaped {\\"Authorization\\":\\"Bearer escaped-bearer-secret\\",\\"Cookie\\":\\"sid=escaped-cookie-secret\\"}',
        'https://bucket.example/report?X-Goog-Credential=google-credential-secret&X-Goog-Signature=google-signature-secret',
        'neo4j://graph-user:graph-password-secret@graph.example/db',
        'postgresql+asyncpg://pg-user:pg-password-secret@db.example/app',
        'snowflake://snow-user:snow-password-secret@snow.example/db',
        'eyJhIjoxfQ.e30.short-signature-secret',
      ].join('\n'),
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).not.toMatch(/malformed-bearer-secret|malformed-cookie-secret|escaped-bearer-secret|escaped-cookie-secret|google-credential-secret|google-signature-secret|graph-password-secret|pg-password-secret|snow-password-secret|short-signature-secret/u);
  });

  it('redacts truncated plain and backslash-escaped auth or cookie headers through line end', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'web_extract',
      phase: 'completed',
      preview: [
        '{"Authorization":"Bearer truncated-bearer-secret',
        '{\\"Proxy-Authorization\\":\\"Basic escaped-proxy-secret',
        '{"Cookie":"sid=truncated-cookie-secret',
        '{\\"Set-Cookie\\":\\"sid=escaped-set-cookie-secret',
      ].join('\n'),
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).not.toMatch(/truncated-bearer-secret|escaped-proxy-secret|truncated-cookie-secret|escaped-set-cookie-secret/u);
  });

  it('redacts HTML-escaped and JSON-shaped AWS or Google signed URL credentials', () => {
    const uses: CapturedToolUse[] = [];
    captureToolEvidence(uses, {
      tool: 'web_extract',
      phase: 'completed',
      preview: [
        'https://bucket.example/report?x=1&amp;X-Amz-Signature=html-amz-secret',
        'https://bucket.example/report?x=1&#38;X-Goog-Signature=html-goog-secret',
        '{"X-Amz-Credential":"json-amz-credential","X-Goog-Signature":"json-goog-signature"}',
      ].join('\n'),
    });

    expect(uses).toHaveLength(1);
    expect(uses[0]?.preview).not.toMatch(/html-amz-secret|html-goog-secret|json-amz-credential|json-goog-signature/u);
  });

  it('re-sanitizes and allowlists tool previews at the persistence boundary', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) };
    const store = new (EvidenceStore as any)(db) as EvidenceStore;

    await store.saveRunEvidence({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      threadId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
      runId: null,
      toolUses: [
        {
          tool: 'web_extract',
          preview: 'https://bucket.example/report?x=1&amp;X-Goog-Signature=persistence-signature',
        },
        { tool: 'terminal', preview: 'Authorization: Bearer internal-secret' },
      ],
    });

    const rows = values.mock.calls[0]![0] as Array<{ excerpt: string; url: string | null; ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ref).toBe('web_extract');
    expect(rows[0]?.excerpt).not.toMatch(/persistence-secret|persistence-signature/u);
    expect(rows[0]?.url).not.toMatch(/persistence-signature/u);
  });
});

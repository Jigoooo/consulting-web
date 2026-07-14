import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildToolPolicyAudit,
  evaluateToolPolicy,
  HIGH_BLAST_RADIUS_TOOLSETS,
} from '../src/security/tool-policy.js';
import { toolPolicyChainHash } from '../src/security/tool-policy-audit.store.js';

const base = ['web', 'search', 'file', 'terminal'];
const sha = (p: string) => createHash('sha256').update(p).digest('hex');

describe('evaluateToolPolicy (fail-closed)', () => {
  it('allows when every enabled toolset is in the allowlist', () => {
    const r = evaluateToolPolicy({ enabledToolsets: ['web', 'file'], baseAllowlist: base });
    expect(r.decision).toBe('allow');
    expect(r.blockedToolsets).toEqual([]);
  });

  it('denies when an enabled toolset is outside the allowlist', () => {
    const r = evaluateToolPolicy({ enabledToolsets: ['web', 'discord'], baseAllowlist: base });
    expect(r.decision).toBe('deny');
    expect(r.blockedToolsets).toEqual(['discord']);
  });

  it('honors a valid tenant grant', () => {
    const r = evaluateToolPolicy({ enabledToolsets: ['image_gen'], baseAllowlist: base, tenantGrants: ['image_gen'] });
    expect(r.decision).toBe('allow');
    expect(r.allowedToolsets).toContain('image_gen');
  });

  it('rejects a high-blast-radius toolset even when granted', () => {
    const r = evaluateToolPolicy({ enabledToolsets: ['mcp'], baseAllowlist: base, tenantGrants: ['mcp'] });
    expect(r.decision).toBe('deny');
    expect(r.blockedToolsets).toEqual(['mcp']);
    expect(r.rejectedHighBlastGrants).toEqual(['mcp']);
  });

  it('every high-blast toolset is rejected as a grant', () => {
    for (const toolset of HIGH_BLAST_RADIUS_TOOLSETS) {
      const r = evaluateToolPolicy({ enabledToolsets: [toolset], baseAllowlist: base, tenantGrants: [toolset] });
      expect(r.decision).toBe('deny');
    }
  });

  it('rejects high-blast toolsets even when they leak into the base allowlist', () => {
    for (const toolset of HIGH_BLAST_RADIUS_TOOLSETS) {
      const r = evaluateToolPolicy({ enabledToolsets: [toolset], baseAllowlist: [...base, toolset] });
      expect(r.decision).toBe('deny');
      expect(r.allowedToolsets).not.toContain(toolset);
      expect(r.blockedToolsets).toContain(toolset);
    }
  });

  it('treats MCP provider variants as high-blast even when explicitly allowlisted', () => {
    const result = evaluateToolPolicy({ enabledToolsets: ['mcp-github'], baseAllowlist: [...base, 'mcp-github'] });
    expect(result.decision).toBe('deny');
    expect(result.blockedToolsets).toEqual(['mcp_github']);
  });

  it.each(['mcp.github', 'mcp/github', 'mcp:github', 'MCP.GitHub'])(
    'rejects MCP namespace separator alias %s from config alone',
    (toolset) => {
      const result = evaluateToolPolicy({
        enabledToolsets: [toolset],
        baseAllowlist: [...base, toolset],
      });
      expect(result.decision).toBe('deny');
      expect(result.blockedToolsets).toEqual(['mcp_github']);
    },
  );

  it.each([
    ['home-assistant', 'home_assistant'],
    ['home.assistant', 'home_assistant'],
    ['homeassistant', 'home_assistant'],
    ['x-search', 'x_search'],
    ['x/search', 'x_search'],
    ['xsearch', 'x_search'],
    ['text-to-speech', 'text_to_speech'],
    ['discord-admin', 'discord_admin'],
    ['mcpgithub', 'mcpgithub'],
    ['homeassistant-light', 'homeassistant_light'],
    ['homeassistantlight', 'homeassistantlight'],
    ['xsearch-api', 'xsearch_api'],
    ['texttospeech.speak', 'texttospeech_speak'],
    ['discordadmin', 'discordadmin'],
    ['home+assistant', 'home_assistant'],
    ['ｈｏｍｅａｓｓｉｓｔａｎｔ-light', 'homeassistant_light'],
    ['m.c+p/github', 'm_c_p_github'],
    ['mсp', 'invalid_non_ascii_toolset'],
    ['disсord', 'invalid_non_ascii_toolset'],
    ['homeаssistant', 'invalid_non_ascii_toolset'],
    ['wéb', 'invalid_non_ascii_toolset'],
    ['xadmin', 'xadmin'],
    ['xapi', 'xapi'],
    ['ｘadmin', 'xadmin'],
  ])('rejects high-blast spelling/family alias %s from config alone', (toolset, canonical) => {
    const result = evaluateToolPolicy({
      enabledToolsets: [toolset],
      baseAllowlist: [...base, toolset],
    });
    expect(result.decision).toBe('deny');
    expect(result.blockedToolsets).toEqual([canonical]);
    expect(result.allowedToolsets).not.toContain(canonical);
  });

  it('uses the same canonical form for safe inventory and allowlist membership', () => {
    const result = evaluateToolPolicy({ enabledToolsets: ['image-gen'], baseAllowlist: ['image_gen'] });
    expect(result.decision).toBe('allow');
    expect(result.allowedToolsets).toEqual(['image_gen']);
  });

  it('allows everything when enforcement is disabled (dev)', () => {
    const r = evaluateToolPolicy({ enabledToolsets: ['discord', 'admin'], baseAllowlist: base, enforced: false });
    expect(r.decision).toBe('allow');
    expect(r.enforced).toBe(false);
    expect(r.blockedToolsets).toEqual([]);
  });

  it('is fail-closed for an empty allowlist', () => {
    const r = evaluateToolPolicy({ enabledToolsets: ['web'], baseAllowlist: [] });
    expect(r.decision).toBe('deny');
    expect(r.blockedToolsets).toEqual(['web']);
  });

  it('normalizes and sorts blocked toolsets deterministically', () => {
    const r = evaluateToolPolicy({ enabledToolsets: [' zeta ', 'alpha', 'zeta'], baseAllowlist: base });
    expect(r.blockedToolsets).toEqual(['alpha', 'zeta']);
  });
});

describe('buildToolPolicyAudit', () => {
  it('produces a complete, deterministic audit record', () => {
    const result = evaluateToolPolicy({ enabledToolsets: ['web', 'discord'], baseAllowlist: base });
    const a = buildToolPolicyAudit({ workspaceId: 'w1', runId: 'run_1', decidedAtIso: '2026-07-12T00:00:00.000Z' }, result, ['web', 'discord'], sha);
    expect(a.decision).toBe('deny');
    expect(a.blockedToolsets).toEqual(['discord']);
    expect(a.auditHash).toMatch(/^[a-f0-9]{64}$/);

    // Same decision inputs → same hash (tamper-evidence), regardless of timestamp.
    const b = buildToolPolicyAudit({ workspaceId: 'w1', runId: 'run_1', decidedAtIso: '2026-07-12T09:00:00.000Z' }, result, ['discord', 'web'], sha);
    expect(b.auditHash).toBe(a.auditHash);
  });

  it('changes the hash when the decision differs', () => {
    const deny = evaluateToolPolicy({ enabledToolsets: ['discord'], baseAllowlist: base });
    const allow = evaluateToolPolicy({ enabledToolsets: ['web'], baseAllowlist: base });
    const at = { workspaceId: 'w1', runId: null, decidedAtIso: '2026-07-12T00:00:00.000Z' };
    const h1 = buildToolPolicyAudit(at, deny, ['discord'], sha).auditHash;
    const h2 = buildToolPolicyAudit(at, allow, ['web'], sha).auditHash;
    expect(h1).not.toBe(h2);
  });
});

describe('toolPolicyChainHash', () => {
  const event = {
    workspaceId: 'workspace-1',
    runId: 'run-1',
    policyHash: 'a'.repeat(64),
    previousHash: null,
    decidedAtIso: '2026-07-13T00:00:00.000Z',
  };

  it('is deterministic and commits to the previous event hash', () => {
    const first = toolPolicyChainHash(event);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(toolPolicyChainHash(event)).toBe(first);
    expect(toolPolicyChainHash({ ...event, previousHash: 'b'.repeat(64) })).not.toBe(first);
  });
});

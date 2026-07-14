/**
 * Tool Registry policy (P5) — centralized, testable, fail-closed decisions for
 * which toolsets an agent run may use, with tenant-scoped overrides and a
 * structured, immutable audit record for every decision.
 *
 * Pure and dependency-free. The existing runs-client fail-closed check
 * (enforceHermesToolPolicy) stays; this module extracts the DECISION logic so it
 * can be unit-tested, reused by MCP allowlist/approval flows, and audited.
 *
 * Fail-closed invariant: anything not explicitly allowed is denied. High-blast
 * -radius toolsets (mcp, messaging, admin, home-assistant, tts) are NEVER
 * auto-allowed and require an explicit per-tenant grant.
 */

export type ToolPolicyDecision = 'allow' | 'deny';

/** Toolsets that can never be granted by the default allowlist — explicit only. */
export const HIGH_BLAST_RADIUS_TOOLSETS = [
  'mcp', 'messaging', 'discord', 'admin', 'home_assistant', 'computer_use',
  'spotify', 'yuanbao', 'tts', 'text_to_speech', 'x', 'x_search',
] as const;

const COMPACT_TOOLSET_ALIASES: Readonly<Record<string, string>> = {
  homeassistant: 'home_assistant',
  texttospeech: 'text_to_speech',
  xsearch: 'x_search',
};

const HIGH_BLAST_COMPACT_PREFIXES = [
  'mcp',
  'messaging',
  'discord',
  'admin',
  'homeassistant',
  'computeruse',
  'spotify',
  'yuanbao',
  'tts',
  'texttospeech',
  'x',
  'xsearch',
] as const;

const INVALID_NON_ASCII_TOOLSET_ID = 'invalid_non_ascii_toolset';

export interface ToolPolicyInput {
  /** Toolsets the agent reports as enabled for this run. */
  enabledToolsets: string[];
  /** Base allowlist (e.g. the default consulting-web set). */
  baseAllowlist: string[];
  /** Optional per-tenant additional grants (operator-approved). */
  tenantGrants?: string[];
  /** When false, policy is not enforced (dev only) → everything allowed. */
  enforced?: boolean;
}

export interface ToolPolicyResult {
  decision: ToolPolicyDecision;
  allowedToolsets: string[];
  /** Enabled toolsets that violated the allowlist (sorted). */
  blockedToolsets: string[];
  /** Grants that were requested but rejected as high-blast-radius (sorted). */
  rejectedHighBlastGrants: string[];
  enforced: boolean;
}

export function canonicalizeToolsetId(value: string): string {
  const normalizedUnicode = value.normalize('NFKC');
  if ([...normalizedUnicode].some((character) => (character.codePointAt(0) ?? 0) > 0x7f)) {
    return INVALID_NON_ASCII_TOOLSET_ID;
  }
  const canonical = normalizedUnicode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_|_$/gu, '');
  return COMPACT_TOOLSET_ALIASES[canonical] ?? canonical;
}

function uniqSorted(items: string[]): string[] {
  return [...new Set(items.map(canonicalizeToolsetId).filter(Boolean))].sort();
}

export function isHighBlastRadiusToolset(name: string): boolean {
  const normalized = canonicalizeToolsetId(name);
  const compact = normalized.replace(/_/gu, '');
  return normalized === INVALID_NON_ASCII_TOOLSET_ID
    || HIGH_BLAST_RADIUS_TOOLSETS.some((prefix) =>
      normalized === prefix || normalized.startsWith(`${prefix}_`),
    )
    || HIGH_BLAST_COMPACT_PREFIXES.some((prefix) => compact.startsWith(prefix));
}

export function evaluateToolPolicy(input: ToolPolicyInput): ToolPolicyResult {
  const enforced = input.enforced !== false;

  // A tenant grant for a high-blast-radius toolset is rejected — those need a
  // dedicated approval path, not a plain grant list.
  const requestedGrants = uniqSorted(input.tenantGrants ?? []);
  const rejectedHighBlastGrants = requestedGrants.filter(isHighBlastRadiusToolset);
  const validGrants = requestedGrants.filter((g) => !isHighBlastRadiusToolset(g));
  const validBase = uniqSorted(input.baseAllowlist).filter((g) => !isHighBlastRadiusToolset(g));

  const allowed = new Set<string>([...validBase, ...validGrants]);

  if (!enforced) {
    return {
      decision: 'allow',
      allowedToolsets: [...allowed].sort(),
      blockedToolsets: [],
      rejectedHighBlastGrants,
      enforced: false,
    };
  }

  const enabled = uniqSorted(input.enabledToolsets);
  const blockedToolsets = enabled.filter((name) => !allowed.has(name));

  return {
    decision: blockedToolsets.length === 0 ? 'allow' : 'deny',
    allowedToolsets: [...allowed].sort(),
    blockedToolsets,
    rejectedHighBlastGrants,
    enforced: true,
  };
}

// ---------------------------------------------------------------------------
// Tamper-evident audit record for a tool-policy decision. Every field is required
// so a decision can never be logged with missing provenance.
// ---------------------------------------------------------------------------
export interface ToolPolicyAuditRecord {
  workspaceId: string;
  runId: string | null;
  decision: ToolPolicyDecision;
  enabledToolsets: string[];
  allowedToolsets: string[];
  blockedToolsets: string[];
  rejectedHighBlastGrants: string[];
  enforced: boolean;
  decidedAtIso: string;
  /** Stable content hash of the decision for tamper-evidence. */
  auditHash: string;
}

export function computeToolPolicyAuditHash(
  input: Omit<ToolPolicyAuditRecord, 'decidedAtIso' | 'auditHash'>,
  hasher: (payload: string) => string,
): string {
  return hasher(JSON.stringify({
    workspaceId: input.workspaceId,
    runId: input.runId,
    decision: input.decision,
    enabledToolsets: uniqSorted(input.enabledToolsets),
    allowedToolsets: uniqSorted(input.allowedToolsets),
    blockedToolsets: uniqSorted(input.blockedToolsets),
    rejectedHighBlastGrants: uniqSorted(input.rejectedHighBlastGrants),
    enforced: input.enforced,
  }));
}

/**
 * Build a deterministic audit record. The hash covers the decision-relevant
 * fields (not the timestamp) so identical decisions are detectable, while the
 * timestamp is preserved for ordering.
 */
export function buildToolPolicyAudit(
  input: { workspaceId: string; runId: string | null; decidedAtIso: string },
  result: ToolPolicyResult,
  enabledToolsets: string[],
  hasher: (payload: string) => string,
): ToolPolicyAuditRecord {
  const enabled = uniqSorted(enabledToolsets);
  const auditHash = computeToolPolicyAuditHash({
    workspaceId: input.workspaceId,
    runId: input.runId,
    decision: result.decision,
    enabledToolsets: enabled,
    allowedToolsets: result.allowedToolsets,
    blockedToolsets: result.blockedToolsets,
    rejectedHighBlastGrants: result.rejectedHighBlastGrants,
    enforced: result.enforced,
  }, hasher);
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    decision: result.decision,
    enabledToolsets: enabled,
    allowedToolsets: result.allowedToolsets,
    blockedToolsets: result.blockedToolsets,
    rejectedHighBlastGrants: result.rejectedHighBlastGrants,
    enforced: result.enforced,
    decidedAtIso: input.decidedAtIso,
    auditHash,
  };
}

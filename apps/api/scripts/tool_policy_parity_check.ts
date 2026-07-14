/**
 * Parity check: the extracted evaluateToolPolicy core must reach the SAME
 * allow/deny verdict as the runs-client inline enforcement for the real default
 * consulting-web allowlist. Proves the P5 extraction is faithful, not divergent.
 */
import { evaluateToolPolicy } from '../src/security/tool-policy.js';

// Mirror of DEFAULT_ALLOWED_HERMES_TOOLSETS in hermes-runs-client.ts.
const DEFAULT_ALLOW = [
  'web', 'search', 'terminal', 'file', 'browser', 'vision', 'image_gen',
  'skills', 'memory', 'session_search', 'cronjob', 'code_execution',
  'delegation', 'todo', 'safe',
];

// Legacy inline logic (copied shape): enabled toolsets not in the allowlist are blocked.
function legacyEnforce(enabled: string[], allow: string[]): { blocked: string[] } {
  const allowed = new Set(allow);
  return { blocked: enabled.filter((n) => !allowed.has(n)) };
}

const cases: string[][] = [
  ['web', 'file'],
  ['web', 'discord'],
  ['mcp'],
  ['terminal', 'code_execution', 'delegation'],
  ['messaging', 'admin', 'web'],
  [],
];

let mismatches = 0;
for (const enabled of cases) {
  const legacy = legacyEnforce(enabled, DEFAULT_ALLOW);
  const core = evaluateToolPolicy({ enabledToolsets: enabled, baseAllowlist: DEFAULT_ALLOW });
  const legacyDeny = legacy.blocked.length > 0;
  const coreDeny = core.decision === 'deny';
  const blockedMatch = JSON.stringify([...legacy.blocked].sort()) === JSON.stringify(core.blockedToolsets);
  if (legacyDeny !== coreDeny || !blockedMatch) {
    mismatches += 1;
    console.log(JSON.stringify({ enabled, legacy: legacy.blocked, core: core.blockedToolsets }));
  }
}

console.log(JSON.stringify({ ok: mismatches === 0, cases: cases.length, mismatches }));
if (mismatches > 0) process.exit(1);

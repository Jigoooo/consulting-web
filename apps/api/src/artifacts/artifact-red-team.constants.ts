import type { ArtifactRedTeamPersona } from './artifact-export-preflight-audit.js';

export const ARTIFACT_RED_TEAM_POLICY_VERSION = 'artifact_red_team_v1';
export const ARTIFACT_RED_TEAM_PERSONAS = ['감사원', '의회', '노조'] as const satisfies readonly ArtifactRedTeamPersona[];

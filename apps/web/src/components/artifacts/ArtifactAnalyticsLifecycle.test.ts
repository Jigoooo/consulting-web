import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isArtifactVersionAnalyticsPending } from './ArtifactsSurface';

const here = dirname(fileURLToPath(import.meta.url));
const surface = readFileSync(join(here, 'ArtifactsSurface.tsx'), 'utf8');

describe('artifact editor and analytics lifecycle', () => {
  it('clears the change note before binding a new version draft', () => {
    expect(surface).toMatch(/setVSoWhat\([^;]+;\s*setVNote\(''\);\s*setVSource\(createArtifactVersionSourceSnapshot\(shown\)\)/u);
  });

  it('attributes pending state only to the artifact version submitted', () => {
    expect(isArtifactVersionAnalyticsPending(true, { artifactVersionId: 'version-a' }, 'version-a')).toBe(true);
    expect(isArtifactVersionAnalyticsPending(true, { artifactVersionId: 'version-a' }, 'version-b')).toBe(false);
    expect(isArtifactVersionAnalyticsPending(false, { artifactVersionId: 'version-a' }, 'version-a')).toBe(false);
  });

  it('fails closed until support and source-thread send permission are proven', () => {
    expect(surface).toContain('artifactAnalytics.isSuccess');
    expect(surface).toContain('artifactAnalytics.data?.supported === true');
    expect(surface).toContain('canSendSourceThread');
    expect(surface).toContain('출처 대화 전송 권한이 없어');
    expect(surface).toContain("scorecardId: artifactAnalytics.data!.scorecard!.id");
    expect(surface).toContain('연결 결정표');
    expect(surface).toContain('정확히 연결된 결정표를 확인할 수 없어');
  });
});

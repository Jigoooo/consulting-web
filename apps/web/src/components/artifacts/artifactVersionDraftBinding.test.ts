import { describe, expect, it } from 'vitest';
import { isArtifactVersionDraftBound } from './ArtifactsSurface';

describe('artifact version draft binding', () => {
  it('shows and submits a draft only for its bound artifact and base version', () => {
    const binding = { artifactId: 'artifact-a', baseVersionId: 'version-a1' };

    expect(isArtifactVersionDraftBound(binding, 'artifact-a', 'version-a1')).toBe(true);
    expect(isArtifactVersionDraftBound(binding, 'artifact-b', 'version-a1')).toBe(false);
    expect(isArtifactVersionDraftBound(binding, 'artifact-a', 'version-a2')).toBe(false);
    expect(isArtifactVersionDraftBound(null, 'artifact-a', 'version-a1')).toBe(false);
  });
});

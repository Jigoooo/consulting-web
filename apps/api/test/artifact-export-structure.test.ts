import { describe, expect, it } from 'vitest';
import { normalizeArtifactMarkdown } from '../src/artifacts/artifact-export.service.js';

describe('artifact export decision structure', () => {
  it('renders the immutable governing message and so-what before the body', () => {
    const markdown = normalizeArtifactMarkdown({
      title: '사업 범위 검토',
      versionNo: 2,
      content: '## 분석 근거\n\n세부 본문',
      governingMessage: '핵심 결론은 사업 범위를 단계적으로 축소해야 한다는 것입니다.',
      soWhat: '따라서 이번 분기에 예산 우선순위와 실행 일정을 다시 확정해야 합니다.',
    });

    expect(markdown).toContain('## 핵심 결론');
    expect(markdown).toContain('> 핵심 결론은 사업 범위를 단계적으로 축소해야 한다는 것입니다.');
    expect(markdown).toContain('## 의사결정 의미');
    expect(markdown).toContain('> 따라서 이번 분기에 예산 우선순위와 실행 일정을 다시 확정해야 합니다.');
    expect(markdown.indexOf('## 핵심 결론')).toBeLessThan(markdown.indexOf('## 분석 근거'));
  });
});

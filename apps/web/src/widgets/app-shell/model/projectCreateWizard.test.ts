import { describe, expect, it } from 'vitest';
import {
  BASIC_INFO_EDIT_HELPER,
  CONNECTION_EDIT_HELPER,
  DEFAULT_TEMPLATE_CHANNEL_LABEL,
  EDIT_AFTER_CREATE_NOTICE,
  REVIEW_EDIT_HELPER,
  SUCCESS_EDIT_NOTICE,
  buildCreateProjectPayload,
  canSubmitProjectWizard,
  connectionStrengthToEdgeType,
  initialProjectWizardDraft,
} from './projectCreateWizard';

describe('project create wizard model', () => {
  it('maps user-facing connection strength to context_edges edge types', () => {
    expect(connectionStrengthToEdgeType('strong')).toBe('shares_memory_with');
    expect(connectionStrengthToEdgeType('weak')).toBe('related_to');
  });

  it('keeps the required post-create editability copy available to every step', () => {
    expect(EDIT_AFTER_CREATE_NOTICE).toContain('생성 후에도');
    expect(EDIT_AFTER_CREATE_NOTICE).toContain('프로젝트명');
    expect(EDIT_AFTER_CREATE_NOTICE).toContain('연결');
    expect(EDIT_AFTER_CREATE_NOTICE).toContain('자료');
    expect(BASIC_INFO_EDIT_HELPER).toBe('프로젝트명과 개요는 생성 후에도 프로젝트 설정에서 바꿀 수 있어요.');
    expect(CONNECTION_EDIT_HELPER).toBe('연결은 생성 후에도 프로젝트 설정에서 언제든 바꿀 수 있어요.');
    expect(REVIEW_EDIT_HELPER).toBe('생성 후에도 프로젝트명·개요·연결·자료를 다시 바꿀 수 있습니다.');
    expect(SUCCESS_EDIT_NOTICE).toBe('이름·연결·자료는 언제든 다시 바꿀 수 있어요.');
  });

  it('names every channel created by the default consulting template', () => {
    for (const channel of ['자료수집', '분석', '보고서', 'Q&A', '대화']) {
      expect(DEFAULT_TEMPLATE_CHANNEL_LABEL).toContain(channel);
    }
  });

  it('requires at least one selected project when the user chooses selected connections', () => {
    expect(canSubmitProjectWizard({ ...initialProjectWizardDraft(), name: '신규', connectionDecision: 'selected', connections: [] })).toBe(false);
    expect(canSubmitProjectWizard({
      ...initialProjectWizardDraft(),
      name: '신규',
      connectionDecision: 'selected',
      connections: [{ projectId: 'project-1', strength: 'strong' }],
    })).toBe(true);
  });

  it('builds a strict API payload and keeps review-step material notes editable after creation', () => {
    const payload = buildCreateProjectPayload({
      ...initialProjectWizardDraft(),
      name: ' 신규 프로젝트 ',
      slug: 'new-project',
      overview: '개요',
      goal: '목표',
      notes: '메모',
      materialNote: '생성 후 자료실에서 업로드',
      connectionDecision: 'selected',
      connections: [{ projectId: '00000000-0000-4000-8000-000000000002', strength: 'weak' }],
    }, '00000000-0000-4000-8000-000000000001');

    expect(payload).toEqual({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      name: '신규 프로젝트',
      slug: 'new-project',
      applyDefaultTemplate: true,
      templateKey: 'consulting_default',
      connectionDecision: 'selected',
      connections: [{ projectId: '00000000-0000-4000-8000-000000000002', strength: 'weak' }],
      profile: { overview: '개요', goal: '목표', notes: '메모\n\n생성 후 자료실에서 업로드' },
    });
    expect('materialNote' in payload).toBe(false);
  });

  it('sends an explicit default-template opt-out when the checkbox is off', () => {
    const payload = buildCreateProjectPayload({
      ...initialProjectWizardDraft(),
      name: '템플릿 없는 프로젝트',
      useDefaultTemplate: false,
    }, '00000000-0000-4000-8000-000000000001');

    expect(payload.applyDefaultTemplate).toBe(false);
    expect('templateKey' in payload).toBe(false);
  });
});

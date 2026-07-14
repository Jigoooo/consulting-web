import { ApiClientError } from '@consulting/api-client';
import { describe, expect, it } from 'vitest';
import { evidenceAddErrorMessage } from './evidenceAddError';

describe('evidence add error messages', () => {
  it('identifies an expired session instead of blaming the URL', () => {
    const error = new ApiClientError(401, { code: 'UNAUTHENTICATED', message: 'missing bearer token' });
    expect(evidenceAddErrorMessage(error)).toBe('로그인이 만료됐어요. 다시 로그인해주세요.');
  });

  it('explains validation failures as input problems', () => {
    const error = new ApiClientError(400, { code: 'VALIDATION', message: 'invalid request body' });
    expect(evidenceAddErrorMessage(error)).toContain('입력 내용을 확인');
  });

  it('distinguishes transport failures', () => {
    const error = new ApiClientError(0, { code: 'NETWORK', message: 'network unavailable' });
    expect(evidenceAddErrorMessage(error)).toContain('네트워크 연결');
  });

  it('uses a truthful generic fallback for unknown failures', () => {
    expect(evidenceAddErrorMessage(new Error('unexpected'))).toBe('근거를 추가하지 못했어요. 잠시 후 다시 시도해주세요.');
  });
});

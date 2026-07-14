import { describe, expect, it } from 'vitest';
import { PublicChatStreamSanitizer, sanitizePublicChatText } from '../src/chat/public-chat-content.js';
import { ChatMessageStore } from '../src/chat/chat-message.store.js';

describe('public chat content boundary', () => {
  it('redacts local MEDIA paths while preserving the file name and public URLs', () => {
    const text = [
      '내부 보고서',
      'MEDIA:/home/jigoo/hermes-work/report.pdf',
      '외부 문서',
      'MEDIA:C:\\Users\\jigoo\\Desktop\\public_advisory.docx',
      'MEDIA:https://files.example.test/report.pdf',
    ].join('\n');

    const publicText = sanitizePublicChatText(text);

    expect(publicText).not.toContain('/home/jigoo');
    expect(publicText).not.toContain('C:\\Users\\jigoo');
    expect(publicText).toContain('📎 report.pdf — 원래 대화 환경에 저장된 파일이라 웹에서 바로 열 수 없습니다. 이 채널에 다시 첨부해 주세요.');
    expect(publicText).toContain('📎 public_advisory.docx — 원래 대화 환경에 저장된 파일이라 웹에서 바로 열 수 없습니다. 이 채널에 다시 첨부해 주세요.');
    expect(publicText).toContain('MEDIA:https://files.example.test/report.pdf');
  });

  it('redacts local MEDIA paths embedded in prose, lists, and deeply indented lines', () => {
    const publicText = sanitizePublicChatText([
      '파일: MEDIA:/home/jigoo/private/report.pdf',
      '- MEDIA:~/private/brief.md',
      '         MEDIA:\\\\server\\share\\secret.docx',
    ].join('\n'));

    expect(publicText).not.toContain('/home/jigoo');
    expect(publicText).not.toContain('~/private');
    expect(publicText).not.toContain('\\\\server\\share');
    expect(publicText).toContain('파일: 📎 report.pdf');
    expect(publicText).toContain('- 📎 brief.md');
    expect(publicText).toContain('📎 secret.docx');
  });

  it('redacts a local MEDIA line even when its path is split across SSE chunks', () => {
    const sanitizer = new PublicChatStreamSanitizer();

    expect(sanitizer.push('보통 문장\nMEDIA:/home/ji')).toBe('보통 문장\n');
    expect(sanitizer.push('goo/hermes-work/report.pdf\n다음 문장')).toBe(
      '📎 report.pdf — 원래 대화 환경에 저장된 파일이라 웹에서 바로 열 수 없습니다. 이 채널에 다시 첨부해 주세요.\n',
    );
    expect(sanitizer.flush()).toBe('다음 문장');
  });

  it('keeps ambiguous tilde and UNC prefixes buffered across SSE chunks', () => {
    const sanitizer = new PublicChatStreamSanitizer();

    expect(sanitizer.push('파일: MEDIA:~')).toBe('');
    expect(sanitizer.push('/private/report.pdf\n- MEDIA:\\')).toContain('📎 report.pdf');
    const unc = sanitizer.push('\\server\\share\\secret.docx\n');
    expect(unc).toContain('📎 secret.docx');
    expect(unc).not.toContain('server\\share');
    expect(sanitizer.flush()).toBe('');
  });

  it('buffers an incomplete line so split secrets cannot escape', () => {
    const sanitizer = new PublicChatStreamSanitizer();
    expect(sanitizer.push('일반 응답입니다.')).toBe('');
    expect(sanitizer.flush()).toBe('일반 응답입니다.');
  });

  it('redacts PII, credentials, and private keys split across SSE chunks', () => {
    const sanitizer = new PublicChatStreamSanitizer();
    expect(sanitizer.push('연락처 010-12')).toBe('');
    expect(sanitizer.push('34-5678\napi_key=sk')).toBe('연락처 [REDACTED_PHONE]\n');
    expect(sanitizer.push('-abcdefghijklmnop\n')).toBe('api_key=[REDACTED]\n');
    expect(sanitizer.push('-----BEGIN PRIVATE')).toBe('');
    expect(sanitizer.push(' KEY-----\nraw-key-material\n')).toBe('[REDACTED_PRIVATE_KEY]\n\n');
    expect(sanitizer.push('-----END PRIVATE KEY-----\n정상\n')).toBe('\n정상\n');
    expect(sanitizer.flush()).toBe('');
  });

  it('sanitizes persisted content at the public message read-model boundary', () => {
    const store = Object.create(ChatMessageStore.prototype) as unknown as {
      toMessage(row: unknown): { content: string };
    };
    const message = store.toMessage({
      id: '11111111-1111-4111-8111-111111111111',
      role: 'assistant',
      content: '보고서 owner@example.com 010-1234-5678 api_key=sk-secret\nMEDIA:/home/jigoo/private/report.pdf',
      authorUserId: null,
      authorName: null,
      runId: 'run-1',
      finishState: 'complete',
      createdAt: new Date('2026-07-12T00:00:00.000Z'),
    });

    expect(message.content).toContain('📎 report.pdf');
    expect(message.content).not.toContain('/home/jigoo');
    expect(message.content).not.toContain('owner@example.com');
    expect(message.content).not.toContain('010-1234-5678');
    expect(message.content).not.toContain('sk-secret');
  });
});

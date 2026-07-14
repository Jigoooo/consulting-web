import { redactPii } from '../security/pii-redaction.js';
import { redactSensitiveText } from '../security/redact-sensitive-text.js';

const PUBLIC_FILE_NOTICE = '원래 대화 환경에 저장된 파일이라 웹에서 바로 열 수 없습니다. 이 채널에 다시 첨부해 주세요.';

export function sanitizePublicChatText(text: string): string {
  return redactPii(redactSensitiveText(text)).split('\n').map(sanitizeMediaLine).join('\n');
}

export class PublicChatStreamSanitizer {
  private pending = '';
  private insidePrivateKey = false;

  push(chunk: string): string {
    this.pending += chunk;
    let output = '';
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const sanitized = this.sanitizeLine(line);
      if (sanitized) output += sanitized;
      output += '\n';
      newline = this.pending.indexOf('\n');
    }
    return output;
  }

  flush(): string {
    const line = this.pending;
    this.pending = '';
    return this.sanitizeLine(line);
  }

  private sanitizeLine(line: string): string {
    if (this.insidePrivateKey) {
      if (/-----END [^-\r\n]*PRIVATE KEY-----/iu.test(line)) this.insidePrivateKey = false;
      return '';
    }
    if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/iu.test(line)) {
      if (!/-----END [^-\r\n]*PRIVATE KEY-----/iu.test(line)) this.insidePrivateKey = true;
      return '[REDACTED_PRIVATE_KEY]';
    }
    return sanitizePublicChatText(line);
  }
}

function sanitizeMediaLine(line: string): string {
  const match = line.match(/^(.*?)(?:MEDIA:)\s*((?:file:\/\/)?(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\).+)\r?$/i);
  if (!match) return line;
  const prefix = match[1] ?? '';
  const target = match[2] ?? '';
  const fileName = safeFileName(target);
  return `${prefix}📎 ${fileName} — ${PUBLIC_FILE_NOTICE}`;
}

function safeFileName(target: string): string {
  const withoutScheme = target.replace(/^file:\/\//i, '');
  const withoutSuffix = withoutScheme.replace(/[?#].*$/, '');
  const candidate = withoutSuffix.split(/[\\/]/).filter(Boolean).at(-1) ?? '파일';
  const safe = candidate.replace(/[\r\n\t*`<>\u005b\u005d]/g, ' ').replace(/\s+/g, ' ').trim();
  return safe || '파일';
}

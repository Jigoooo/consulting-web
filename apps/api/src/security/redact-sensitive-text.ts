export function redactSensitiveText(value: string): string {
  return redactSignedUrlQueries(value)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/giu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>/:@]+:[^@\s"'<>]+@[^\s"'<>]+/gu, '[REDACTED_DATABASE_URL]')
    .replace(/\b(?:postgres(?:ql)?(?:\+[a-z0-9._-]+)?|mysql(?:\+[a-z0-9._-]+)?|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqps?|mssql|neo4j(?:\+[a-z0-9._-]+)?|bolt(?:\+[a-z0-9._-]+)?|snowflake|cockroachdb):\/\/[^\s"'<>]+/giu, '[REDACTED_DATABASE_URL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/gu, '[REDACTED_JWT]')
    .replace(/(\b(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)(?:\\["']|["'])?\s*[:=]\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(/(\b(?:x[-_](?:amz|goog)[-_](?:signature|credential|security[-_]?token)|googleaccessid)(?:\\["']|["'])?\s*[:=]\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(/((?:\?|&amp;|&#(?:0*38|x0*26);|\\u0026|&)(?:x-(?:amz|goog)-(?:signature|credential|security-token)|googleaccessid|signature|sig|token|credential|key)=)[^&#\s"'<>]*/giu, '$1REDACTED')
    .replace(/((?:["']?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|private[_-]?key|credential(?:s)?|session(?:[_-]?(?:id|key|token))?|database[_-]?url|db[_-]?url|dsn|connection[_-]?string)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu, '$1[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[REDACTED_AWS_KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu, '[REDACTED_TOKEN]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]');
}

export function redactLogText(value: string, maxChars = 2_000): string {
  return redactSensitiveText(value)
    .replace(/\p{Cc}+/gu, ' ')
    .slice(0, maxChars);
}

function redactSignedUrlQueries(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, (candidate) => {
    const normalized = candidate.replace(/&(?:amp|#0*38|#x0*26);|\\u0026/giu, '&');
    if (!/[?&](?:x-(?:amz|goog)-(?:signature|credential|security-token)|googleaccessid|signature|sig|token|credential|key)=/iu.test(normalized)) {
      return candidate;
    }
    const queryIndex = candidate.indexOf('?');
    return queryIndex < 0 ? '[REDACTED_SIGNED_URL]' : `${candidate.slice(0, queryIndex)}?signed_query=REDACTED`;
  });
}

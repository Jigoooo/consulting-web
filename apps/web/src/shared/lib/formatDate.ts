/**
 * 채팅 메시지의 날짜 표기 유틸(축2). KST/로컬 달력 기준으로 오늘/어제/상대표기.
 * 순수함수 — TDD(formatDate.test.ts). 시간대는 브라우저 로컬(주인님 Asia/Seoul).
 */

function toDate(input: Date | string | number): Date | null {
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

/** 로컬 달력 기준 같은 날인가. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 로컬 달력일 키(YYYY-M-D). 날짜 경계 divider 그룹핑용. */
export function dayKey(input: Date | string | number): string {
  const d = toDate(input);
  if (!d) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 스크롤 위치 날짜 pill / 경계 divider 라벨.
 * 오늘 / 어제 / (같은 해) M월 D일 / (다른 해) YYYY년 M월 D일.
 */
export function formatDateLabel(input: Date | string | number, now: Date = new Date()): string {
  const d = toDate(input);
  if (!d) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** hover 툴팁용 전체 날짜+시간. */
export function formatFullDateTime(input: Date | string | number): string {
  const d = toDate(input);
  if (!d) return '';
  return d.toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

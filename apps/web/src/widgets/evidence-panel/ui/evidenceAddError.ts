import { ApiClientError } from '@consulting/api-client';

export function evidenceAddErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    return '근거를 추가하지 못했어요. 잠시 후 다시 시도해주세요.';
  }

  switch (error.code) {
    case 'UNAUTHENTICATED':
      return '로그인이 만료됐어요. 다시 로그인해주세요.';
    case 'FORBIDDEN':
      return '이 대화에 근거를 추가할 권한이 없어요.';
    case 'VALIDATION':
      return '입력 내용을 확인해주세요. URL을 입력했다면 http:// 또는 https://로 시작해야 해요.';
    case 'NOT_FOUND':
      return '대화를 찾을 수 없어요. 새로고침 후 다시 시도해주세요.';
    case 'NETWORK':
      return '네트워크 연결을 확인하고 다시 시도해주세요.';
    case 'TIMEOUT':
      return '서버 응답이 늦어요. 잠시 후 다시 시도해주세요.';
    default:
      return '근거를 추가하지 못했어요. 잠시 후 다시 시도해주세요.';
  }
}

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

/**
 * 첨부 바이너리를 authed blob → object URL 로 로드(축3 파일 뷰어).
 * PDF/이미지 등 바이너리 렌더용. 언마운트 시 revoke. 텍스트 원문은 별도
 * useAttachmentExtraction(추출 텍스트)로 가져온다.
 */
export function useAttachmentBlobUrl(id: string | undefined, enabled: boolean): {
  url: string | null;
  loading: boolean;
  error: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!id || !enabled) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoading(true);
    setError(false);
    void api
      .downloadAttachment(id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, enabled]);

  return { url, loading, error };
}

import { useSearchState, searchStore } from '../../chat-thread/model/searchStore';
import { Icon } from '../../../shared/icons/Icon';
import s from './EvidencePanel.module.css';

const sourceLabel: Record<string, string> = {
  gbrain: '지식그래프',
  web: '웹',
  file: '파일근거',
  tool: '도구',
  manual: '직접 첨부',
};

/**
 * F3: full search-result list for the right context panel. When a chat search
 * returns many hits, the header dropdown only previews the top 5 — this shows
 * every result. Clicking a row jumps the chat to that message (via searchStore
 * focus index, which the chat thread observes).
 */
export function SearchResultsPanel({ onJump }: { onJump: (index: number) => void }) {
  const search = useSearchState();
  const results = search.results;
  const files = search.files;
  const evidence = search.evidence;
  const total = results.length + files.length + evidence.length;

  if (!search.query) {
    return (
      <div className={s.empty}>
        헤더의 대화 검색을 사용하면
        <br />
        결과가 여기에 모두 표시됩니다.
      </div>
    );
  }
  if (total === 0) {
    return <div className={s.empty}>“{search.query}”에 대한 결과가 없어요.</div>;
  }

  return (
    <div className={s.searchList}>
      <div className={s.searchListHead}>
        <span>“{search.query}” · 총 {total}개</span>
        <span className={s.searchListSub}>대화 {results.length} · 문서 {files.length} · 근거 {evidence.length}</span>
      </div>
      {results.length > 0 ? <div className={s.searchSectionLabel}>대화</div> : null}
      {results.map((hit, index) => (
          <button
            key={hit.id}
            type="button"
            className={`${s.searchRow} ${index === search.focusedIndex ? s.searchRowOn : ''} cwTap`}
            onClick={() => {
              searchStore.focusIndex(index);
              onJump(index);
            }}
          >
            <span className={s.searchRowMeta}>
              <span className={s.searchRowRole}>{hit.role === 'assistant' ? '지구' : '나'}</span>
              {hit.matchKind && hit.matchKind !== 'text' ? (
                <span className={s.searchRowKind}>{hit.matchKind === 'chosung' ? '초성' : '자모'}</span>
              ) : null}
              <span className={s.searchRowTime}>
                {new Date(hit.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            </span>
            <span className={s.searchRowText}>{hit.snippet}</span>
            <span className={s.searchRowGo} aria-hidden="true">
              <Icon name="arrow-left" size="xs" decorative />
            </span>
          </button>
        ))}

      {files.length > 0 ? <div className={s.searchSectionLabel}>문서</div> : null}
      {files.map((hit) => (
        <button
          key={hit.id}
          type="button"
          className={`${s.searchRow} ${!hit.messageId ? s.searchRowMuted : ''} cwTap`}
          onClick={() => {
            if (hit.messageId) searchStore.jumpMessage(hit.messageId);
          }}
        >
          <span className={s.searchRowMeta}>
            <span className={s.searchRowRole}>문서</span>
            {hit.status ? <span className={s.searchRowKind}>{hit.status === 'indexed' ? '분석됨' : hit.status}</span> : null}
            <span className={s.searchRowTime}>{new Date(hit.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </span>
          <span className={s.searchRowText}><strong>{hit.fileName}</strong> · {hit.snippet}</span>
          {hit.messageId ? <span className={s.searchRowGo} aria-hidden="true"><Icon name="arrow-left" size="xs" decorative /></span> : null}
        </button>
      ))}

      {evidence.length > 0 ? <div className={s.searchSectionLabel}>근거</div> : null}
      {evidence.map((hit) => (
        <button
          key={hit.id}
          type="button"
          className={`${s.searchRow} ${!hit.messageId && !hit.url ? s.searchRowMuted : ''} cwTap`}
          onClick={() => {
            if (hit.messageId) searchStore.jumpMessage(hit.messageId);
            else if (hit.url) window.open(hit.url, '_blank', 'noreferrer,noopener');
          }}
        >
          <span className={s.searchRowMeta}>
            <span className={s.searchRowRole}>{sourceLabel[hit.sourceType] ?? hit.sourceType}</span>
            <span className={s.searchRowKind}>{hit.ref}</span>
            <span className={s.searchRowTime}>{new Date(hit.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </span>
          <span className={s.searchRowText}>{hit.snippet}</span>
          {hit.messageId || hit.url ? <span className={s.searchRowGo} aria-hidden="true"><Icon name="arrow-left" size="xs" decorative /></span> : null}
        </button>
      ))}
    </div>
  );
}

import { useSearchState, searchStore } from '../../chat-thread/model/searchStore';
import { Icon } from '../../../shared/icons/Icon';
import s from './EvidencePanel.module.css';

/**
 * F3: full search-result list for the right context panel. When a chat search
 * returns many hits, the header dropdown only previews the top 5 — this shows
 * every result. Clicking a row jumps the chat to that message (via searchStore
 * focus index, which the chat thread observes).
 */
export function SearchResultsPanel({ onJump }: { onJump: (index: number) => void }) {
  const search = useSearchState();
  const results = search.results;

  if (!search.query) {
    return (
      <div className={s.empty}>
        헤더의 대화 검색을 사용하면
        <br />
        결과가 여기에 모두 표시됩니다.
      </div>
    );
  }
  if (results.length === 0) {
    return <div className={s.empty}>“{search.query}”에 대한 결과가 없어요.</div>;
  }

  return (
    <div className={s.searchList}>
      <div className={s.searchListHead}>
        <span>“{search.query}” · {results.length}개</span>
      </div>
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
    </div>
  );
}

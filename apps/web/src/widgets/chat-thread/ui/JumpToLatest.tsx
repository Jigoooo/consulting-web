import { Icon } from '../../../shared/icons/Icon';
import s from '../../thread-view/ui/ThreadView.module.css';

/**
 * Scroll-to-latest FAB (A2). Appears when the user is not at the tail — after
 * scrolling up, or after a search jump (mode==='around'). Shows an unseen-count
 * pill when new messages arrived while scrolled away. Clicking returns to the
 * live tail: for a search-jump window that means replacing the window with the
 * latest page (O(1)), not paging all the way down.
 */
export function JumpToLatest({
  visible,
  unseen,
  streaming,
  onJump,
}: {
  visible: boolean;
  unseen: number;
  streaming: boolean;
  onJump: () => void;
}) {
  if (!visible) return null;
  const label = unseen > 0 ? `새 메시지 ${unseen}` : streaming ? '응답 작성 중' : '';
  return (
    <button
      type="button"
      className={`${s.jumpFab} ${unseen > 0 ? s.jumpFabPulse : ''} cwTap`}
      onClick={onJump}
      aria-label="최신 메시지로 이동"
    >
      {label ? <span className={s.jumpFabLabel}>{label}</span> : null}
      <Icon name="arrow-down" size="sm" decorative />
    </button>
  );
}

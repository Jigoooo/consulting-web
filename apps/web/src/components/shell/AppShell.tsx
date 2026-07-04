import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import s from './AppShell.module.css';

/**
 * AppShell — the persistent 4-pane frame (rail / sidebar / center / context).
 * Phase 1-K: static demo data to validate the shell; Phase 1-M wires real
 * workspace/project/topic data + live SSE into the center pane.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={s.app}>
      <Rail />
      <Sidebar />
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-canvas)' }}>
        {children}
      </div>
      <ContextPanel />
    </div>
  );
}

function Rail() {
  return (
    <div className={s.rail}>
      <div className={`${s.wsWrap} ${s.active}`}>
        <span className={s.wsBar} />
        <Link to="/" className={s.ws}>지</Link>
      </div>
      <div className={s.wsWrap}>
        <span className={s.wsBar} />
        <div className={s.ws}>창</div>
      </div>
      <div className={s.grpLabel}>공유</div>
      <div className={s.wsWrap}>
        <span className={s.wsBar} />
        <div className={s.ws}>A</div>
      </div>
      <div className={s.wsWrap}>
        <span className={s.wsBar} />
        <div className={s.ws}>B</div>
      </div>
      <div className={s.spacer} />
      <div className={s.rbtn} title="workspace 추가">+</div>
      <div className={s.rbtn} title="설정">⚙</div>
    </div>
  );
}

function Sidebar() {
  return (
    <div className={s.sidebar}>
      <div className={s.wsHead}>
        <div className={s.wsIco}>지</div>
        <div>
          <div className={s.wsName}>지구 Workspace</div>
          <div className={s.wsSub}>owner · 개인</div>
        </div>
      </div>
      <div className={s.search}>
        <span>검색 또는 이동…</span>
        <span className={s.searchKey}>⌘K</span>
      </div>
      <div className={s.tree}>
        <div className={s.secLabel}>프로젝트</div>
        <div className={s.projRow}>▾ 창원시 적정성 검토</div>
        <div className={s.chanRow}># 진단</div>
        <div className={s.topic}><span className={s.hash}>#</span> 인구·재정 지표</div>
        <div className={`${s.topic} ${s.active}`}><span className={s.hash}>#</span> 서비스 연속성 <span className={s.live} /></div>
        <div className={s.topic}><span className={s.hash}>#</span> 이관 타당성 <span className={s.unread}>3</span></div>
        <div className={s.chanRow}># 보고서</div>
        <div className={s.topic}><span className={s.hash}>#</span> 초안 v2</div>
        <div className={s.newProj}>+ 새 프로젝트</div>
      </div>
    </div>
  );
}

function ContextPanel() {
  return (
    <div className={s.context}>
      <div style={{ padding: '14px 16px', fontSize: 13, fontWeight: 600 }}>🧭 맥락 패널</div>
    </div>
  );
}

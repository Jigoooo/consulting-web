import { useEntrance } from '../../../lib/motion';
import { Icon } from '../../../shared/icons/Icon';
import s from './ThreadView.module.css';

/**
 * ThreadView — center pane. Phase 1-K: static demo of the message stream +
 * composer to validate the shell. Phase 1-M swaps demo messages for real
 * thread data and wires the composer to api.streamChat (SSE via api-client).
 */
export function ThreadView() {
  const streamRef = useEntrance([]);
  return (
    <>
      <div className={s.head}>
        <div>
          <div className={s.crumb}>
            창원시 적정성 검토 <span className={s.sep}>›</span> 진단 <span className={s.sep}>›</span> 서비스 연속성
          </div>
          <div className={s.title}>이관 시 서비스 연속성 리스크 정리</div>
        </div>
        <div className={s.right}>
          <div className={s.statusChip}>
            <span className={s.pulse} /> 응답 생성 중
          </div>
        </div>
      </div>

      <div className={s.stream} ref={streamRef as React.RefObject<HTMLDivElement>}>
        <div className={s.dayDiv}>오늘</div>
        <div className={s.msg}>
          <div className={`${s.avatar} ${s.avatarUser}`}>주</div>
          <div className={s.body}>
            <div className={s.meta}>
              <span className={s.who}>주인님</span>
              <span className={s.time}>오후 2:14</span>
            </div>
            <div className={s.text}>
              서비스 연속성 관점에서 이관 시 주민 편익이 훼손되지 않는지 핵심 리스크만 3가지로 정리해줘.
            </div>
          </div>
        </div>
        <div className={s.msg}>
          <div className={`${s.avatar} ${s.avatarAi}`}><Icon name="bot" size="sm" decorative /></div>
          <div className={s.body}>
            <div className={s.meta}>
              <span className={s.who}>지구</span>
              <span className={s.time}>오후 2:14</span>
              <span className={s.runid}>run_a91f…c2</span>
            </div>
            <div className={s.text}>
              서비스 연속성 핵심 리스크는 세 가지입니다. 첫째, 인수인계 공백기 동안의 민원 처리 지연. 둘째, 기존 위탁계약의
              승계 불확실성. 셋째, 현장 인력의 숙련도 이전 리스크<span className={s.cursor} />
            </div>
            <div className={s.toolStrip}>
              <span className={s.sp} /> 근거 문서 검색 중 · <b>창원시 위탁계약 현황.pdf</b>
            </div>
          </div>
        </div>
      </div>

      <div className={s.composer}>
        <div className={s.box}>
          <div className={s.boxTop}>
            <textarea className={s.textarea} rows={1} placeholder="메시지를 입력하세요…" />
          </div>
          <div className={s.bar}>
            <span className={s.hint}>Enter 전송 · Shift+Enter 줄바꿈</span>
            <div className={s.sendWrap}>
              <button className={`${s.btn} ${s.btnGhost}`} type="button">
                ■ 중단
              </button>
              <button className={`${s.btn} ${s.btnPrimary}`} type="button">
                전송 ↵
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

import type { ChatRuntimeModel } from '@consulting/contracts';
import { Button } from '../../../shared/ui/button/Button';
import { Icon } from '../../../shared/icons/Icon';
import { SheetContent, SheetRoot } from '../../../shared/ui/dialog/Dialog';
import s from '../../thread-view/ui/ThreadView.module.css';

export function ModelPickerSheet({
  open,
  onOpenChange,
  models,
  selectedModel,
  defaultModel,
  loading,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: ChatRuntimeModel[];
  selectedModel: string;
  defaultModel?: string | undefined;
  loading: boolean;
  onSelect: (modelId: string) => void;
}) {
  const effectiveModel = selectedModel || defaultModel || models[0]?.route || '';
  const selected = models.find((m) => m.route === effectiveModel);
  return (
    <SheetRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        title="모델 변경"
        description="다음 메시지부터 사용할 모델을 고릅니다."
      >
        <div className={s.modelSheet}>
          <div className={s.modelHero}>
            <div className={s.modelHeroKicker}>현재 선택</div>
            <div className={s.modelHeroName}>{selected?.label ?? (effectiveModel || '기본값 확인 중')}</div>
            <div className={s.modelHeroDesc}>선택한 모델은 이 브라우저에만 저장됩니다.</div>
          </div>

          {loading ? (
            <div className={s.modelEmpty}>모델 목록을 불러오는 중…</div>
          ) : models.length > 0 ? (
            <>
              <div className={s.modelList}>
                {models.map((model) => (
                  <button
                    key={`${model.id}:${model.route}`}
                    type="button"
                    aria-current={effectiveModel === model.route ? 'true' : undefined}
                    className={`${s.modelRow} ${effectiveModel === model.route ? s.modelRowOn : ''}`}
                    onClick={() => onSelect(model.route)}
                  >
                    <span>
                      <strong>{model.label}</strong>
                      <em>{model.provider} · {model.route}{defaultModel === model.route ? ' · 기본값' : ''}</em>
                    </span>
                    <b className={s.modelRowCheck} aria-hidden="true">
                      {effectiveModel === model.route ? <Icon name="check" size="xs" decorative /> : null}
                    </b>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className={s.modelEmpty}>표시할 모델 route가 아직 없습니다.</div>
          )}

          <div className={s.modelActions}>
            <Button variant="ghost" type="button" onClick={() => onSelect('')} disabled={!selectedModel}>
              기본값으로
            </Button>
            <Button variant="primary" type="button" onClick={() => onOpenChange(false)}>
              적용
            </Button>
          </div>
        </div>
      </SheetContent>
    </SheetRoot>
  );
}

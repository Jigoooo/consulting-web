import type { RunDecisionAnalyticsRequestInput } from '@consulting/contracts';

export type ImpactDriverDraft = {
  id: string;
  label: string;
  min: string;
  mode: string;
  max: string;
};

type ImpactInput = NonNullable<RunDecisionAnalyticsRequestInput['impact']>;

export type ImpactRequestResult =
  | { ok: true; impact: ImpactInput }
  | { ok: false; message: string };

const MAX_DRIVER_VALUE = 1_000_000_000_000;

function finiteNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildImpactRequest(fixedMultiplierDraft: string, drafts: ImpactDriverDraft[]): ImpactRequestResult {
  const fixedMultiplier = finiteNumber(fixedMultiplierDraft);
  if (fixedMultiplier === null || fixedMultiplier <= 0 || fixedMultiplier > 1_000_000) {
    return { ok: false, message: '고정 배수는 0보다 크고 1,000,000 이하여야 합니다.' };
  }
  if (drafts.length === 0) return { ok: false, message: '영향 축을 1개 이상 입력해주세요.' };
  if (drafts.length > 6) return { ok: false, message: '영향 축은 최대 6개까지 입력할 수 있습니다.' };
  if (new Set(drafts.map((draft) => draft.id)).size !== drafts.length) {
    return { ok: false, message: '영향 축 식별자는 서로 달라야 합니다.' };
  }
  const drivers: ImpactInput['drivers'] = [];
  for (const draft of drafts) {
    const label = draft.label.trim();
    if (!label) return { ok: false, message: '각 축 이름을 입력해주세요.' };
    const min = finiteNumber(draft.min);
    const mode = finiteNumber(draft.mode);
    const max = finiteNumber(draft.max);
    if (min === null || mode === null || max === null) {
      return { ok: false, message: '최솟값·기준값·최댓값은 모두 숫자로 입력해주세요.' };
    }
    if (min < 0 || mode < 0 || max < 0 || min > MAX_DRIVER_VALUE || mode > MAX_DRIVER_VALUE || max > MAX_DRIVER_VALUE) {
      return { ok: false, message: '영향 값은 0 이상 1조 이하로 입력해주세요.' };
    }
    if (min > mode || mode > max) {
      return { ok: false, message: '각 축은 최솟값 ≤ 기준값 ≤ 최댓값 순서여야 합니다.' };
    }
    drivers.push({ id: draft.id, label, min, mode, max });
  }
  return {
    ok: true,
    impact: { unit: 'KRW', model: 'multiplicative', fixedMultiplier, drivers },
  };
}

export function formatKrw(value: number): string {
  return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(Math.round(value))}원`;
}

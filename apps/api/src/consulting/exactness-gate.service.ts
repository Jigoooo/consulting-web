import { Injectable } from '@nestjs/common';

export type ExactnessCheckKind = 'sum_equals_total' | 'percentage_change' | 'ratio_percent';
export type ExactnessRunStatus = 'skipped' | 'passed' | 'blocked';
export type ExactnessCheckStatus = 'passed' | 'mismatch' | 'invalid_input';

export interface ExactnessCheckInput {
  id: string;
  kind: ExactnessCheckKind;
  parts?: string[];
  expectedTotal?: string;
  oldValue?: string;
  newValue?: string;
  numerator?: string;
  denominator?: string;
  tolerance?: string;
}

export interface ExactnessPassLog {
  method: 'decimal_formula' | 'decimal_invariant';
  value: string;
  detail: string;
}

export interface ExactnessCheckResult {
  id: string;
  kind: ExactnessCheckKind;
  status: ExactnessCheckStatus;
  value: string | null;
  expected: string | null;
  oldValue?: string;
  newValue?: string;
  numerator?: string;
  denominator?: string;
  passes: ExactnessPassLog[];
  reason: string;
}

export interface ExactnessGateResult {
  gate: 'exactness_gate_v1';
  required: boolean;
  status: ExactnessRunStatus;
  checks: ExactnessCheckResult[];
  summary: string;
  answerInstruction: string;
}

const EXACTNESS_TRIGGER_RE = /(계산|산정|비율|증감률|총액|합계|평균|중위값|가중치|인건비|승진|정원|기간|근속|row count|카운트|검산|DB|테이블|법령|조항|페이지|원문)/iu;
const DECIMAL_TOKEN = '([+-]?\\d[\\d,]*(?:\\.\\d+)?)';
const PERCENTAGE_CHANGE_RE = new RegExp(`${DECIMAL_TOKEN}\\s*(?:명|개|원|천원|만원|억원|%)?\\s*에서\\s*${DECIMAL_TOKEN}\\s*(?:명|개|원|천원|만원|억원|%)?\\s*(?:으로|로)`, 'iu');

function extractChecks(query: string, answer: string): ExactnessCheckInput[] {
  const haystack = `${query}\n${answer}`;
  const percentageChange = PERCENTAGE_CHANGE_RE.exec(haystack);
  if (percentageChange && /(증감률|증가율|감소율|비율|퍼센트|%)/iu.test(haystack)) {
    const oldValue = percentageChange[1];
    const newValue = percentageChange[2];
    if (typeof oldValue === 'string' && typeof newValue === 'string') return [{ id: 'percentage_change_1', kind: 'percentage_change', oldValue, newValue }];
  }
  return [];
}

@Injectable()
export class ExactnessGateService {
  evaluateAnswer(input: { query: string; answer: string }): ExactnessGateResult {
    return this.evaluate({ query: `${input.query}\n${input.answer}`, checks: extractChecks(input.query, input.answer) });
  }

  evaluate(input: { query: string; checks: ExactnessCheckInput[] }): ExactnessGateResult {
    const required = input.checks.length > 0 || EXACTNESS_TRIGGER_RE.test(input.query);
    if (!required) {
      return {
        gate: 'exactness_gate_v1',
        required: false,
        status: 'skipped',
        checks: [],
        summary: 'exactness_not_required',
        answerInstruction: '정성 요청이므로 Exactness Gate를 생략한다.',
      };
    }

    const checks = input.checks.map((check) => this.runCheck(check));
    const missingChecks = checks.length === 0;
    const blocked = missingChecks || checks.some((check) => check.status !== 'passed');
    return {
      gate: 'exactness_gate_v1',
      required: true,
      status: blocked ? 'blocked' : 'passed',
      checks,
      summary: checks.length > 0
        ? checks.map((check) => `${check.id}=${check.value ?? 'null'}${check.kind === 'percentage_change' || check.kind === 'ratio_percent' ? '%' : ''}`).join('; ')
        : 'exactness_required_but_no_checks_supplied',
      answerInstruction: blocked
        ? '검산 불일치 또는 입력 부족이 있으므로 최종 수치를 단정하지 말고 “검산 불일치/자료 부족”으로 답한다.'
        : '검산 통과. 최종 답변에는 계산 기준, 검산 결과, 주의점을 짧게 포함한다.',
    };
  }

  private runCheck(check: ExactnessCheckInput): ExactnessCheckResult {
    try {
      if (check.kind === 'sum_equals_total') return this.sumEqualsTotal(check);
      if (check.kind === 'percentage_change') return this.percentageChange(check);
      return this.ratioPercent(check);
    } catch (error) {
      return {
        id: check.id,
        kind: check.kind,
        status: 'invalid_input',
        value: null,
        expected: check.expectedTotal ?? null,
        passes: [],
        reason: error instanceof Error ? error.message : 'invalid_input',
      };
    }
  }

  private sumEqualsTotal(check: ExactnessCheckInput): ExactnessCheckResult {
    const parts = (check.parts ?? []).map(parseDecimal);
    if (parts.length === 0) throw new Error('parts_required');
    const total = parts.reduce((sum, value) => add(sum, value), zero());
    const expected = parseDecimal(required(check.expectedTotal, 'expectedTotal_required'));
    const tolerance = parseDecimal(check.tolerance ?? '0');
    const status = absCompare(sub(total, expected), tolerance) <= 0 ? 'passed' : 'mismatch';
    const value = formatDecimal(total);
    return {
      id: check.id,
      kind: check.kind,
      status,
      value,
      expected: formatDecimal(expected),
      passes: [
        { method: 'decimal_formula', value, detail: `sum(${check.parts!.join('+')})` },
        { method: 'decimal_invariant', value, detail: `computed_total == expected_total ± ${formatDecimal(tolerance)}` },
      ],
      reason: status === 'passed' ? 'sum_matches_total' : 'sum_total_mismatch',
    };
  }

  private percentageChange(check: ExactnessCheckInput): ExactnessCheckResult {
    const oldValue = parseDecimal(required(check.oldValue, 'oldValue_required'));
    const newValue = parseDecimal(required(check.newValue, 'newValue_required'));
    if (oldValue.int === 0n) throw new Error('oldValue_zero');
    const delta = sub(newValue, oldValue);
    const value = divToScale(mul(delta, fromInt(100n)), oldValue, 6);
    const rounded = trimScale(value, 4);
    const formatted = formatDecimal(rounded);
    return {
      id: check.id,
      kind: check.kind,
      status: 'passed',
      value: formatted,
      expected: null,
      ...(check.oldValue !== undefined ? { oldValue: check.oldValue } : {}),
      ...(check.newValue !== undefined ? { newValue: check.newValue } : {}),
      passes: [
        { method: 'decimal_formula', value: formatted, detail: '(new-old)/old*100' },
        { method: 'decimal_invariant', value: formatted, detail: `old*(1+pct/100)≈new; old=${formatDecimal(oldValue)} new=${formatDecimal(newValue)}` },
      ],
      reason: 'percentage_change_verified',
    };
  }

  private ratioPercent(check: ExactnessCheckInput): ExactnessCheckResult {
    const numerator = parseDecimal(required(check.numerator, 'numerator_required'));
    const denominator = parseDecimal(required(check.denominator, 'denominator_required'));
    if (denominator.int === 0n) throw new Error('denominator_zero');
    const value = divToScale(mul(numerator, fromInt(100n)), denominator, 6);
    const rounded = trimScale(value, 4);
    const formatted = formatDecimal(rounded);
    return {
      id: check.id,
      kind: check.kind,
      status: 'passed',
      value: formatted,
      expected: null,
      passes: [
        { method: 'decimal_formula', value: formatted, detail: 'numerator/denominator*100' },
        { method: 'decimal_invariant', value: formatted, detail: `0<=percent<=100 checked=${compare(rounded, zero()) >= 0 && compare(rounded, fromInt(100n)) <= 0}` },
      ],
      reason: 'ratio_percent_verified',
    };
  }
}

interface DecimalValue { int: bigint; scale: number }

function required(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === '') throw new Error(message);
  return value;
}

function zero(): DecimalValue {
  return { int: 0n, scale: 0 };
}

function fromInt(int: bigint): DecimalValue {
  return { int, scale: 0 };
}

function parseDecimal(raw: string): DecimalValue {
  const trimmed = raw.trim().replace(/,/gu, '');
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(trimmed)) throw new Error(`invalid_decimal:${raw}`);
  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/u, '');
  const [whole = '0', frac = ''] = unsigned.split('.');
  const int = BigInt(`${whole}${frac}` || '0') * (negative ? -1n : 1n);
  return normalize({ int, scale: frac.length });
}

function normalize(value: DecimalValue): DecimalValue {
  let { int, scale } = value;
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale -= 1;
  }
  return { int, scale };
}

function align(a: DecimalValue, b: DecimalValue): [DecimalValue, DecimalValue] {
  if (a.scale === b.scale) return [a, b];
  const scale = Math.max(a.scale, b.scale);
  return [
    { int: a.int * 10n ** BigInt(scale - a.scale), scale },
    { int: b.int * 10n ** BigInt(scale - b.scale), scale },
  ];
}

function add(a: DecimalValue, b: DecimalValue): DecimalValue {
  const [aa, bb] = align(a, b);
  return normalize({ int: aa.int + bb.int, scale: aa.scale });
}

function sub(a: DecimalValue, b: DecimalValue): DecimalValue {
  const [aa, bb] = align(a, b);
  return normalize({ int: aa.int - bb.int, scale: aa.scale });
}

function mul(a: DecimalValue, b: DecimalValue): DecimalValue {
  return normalize({ int: a.int * b.int, scale: a.scale + b.scale });
}

function divToScale(a: DecimalValue, b: DecimalValue, outputScale: number): DecimalValue {
  const numerator = a.int * 10n ** BigInt(outputScale + b.scale);
  const denominator = b.int * 10n ** BigInt(a.scale);
  if (denominator === 0n) throw new Error('divide_by_zero');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = abs(remainder * 2n) >= abs(denominator) ? quotient + (quotient >= 0n ? 1n : -1n) : quotient;
  return normalize({ int: rounded, scale: outputScale });
}

function trimScale(value: DecimalValue, maxScale: number): DecimalValue {
  if (value.scale <= maxScale) return normalize(value);
  const factor = 10n ** BigInt(value.scale - maxScale);
  const quotient = value.int / factor;
  const remainder = value.int % factor;
  const rounded = abs(remainder * 2n) >= factor ? quotient + (quotient >= 0n ? 1n : -1n) : quotient;
  return normalize({ int: rounded, scale: maxScale });
}

function compare(a: DecimalValue, b: DecimalValue): number {
  const [aa, bb] = align(a, b);
  return aa.int > bb.int ? 1 : aa.int < bb.int ? -1 : 0;
}

function absCompare(a: DecimalValue, b: DecimalValue): number {
  return compare({ int: abs(a.int), scale: a.scale }, { int: abs(b.int), scale: b.scale });
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function formatDecimal(value: DecimalValue): string {
  const normalized = normalize(value);
  const negative = normalized.int < 0n;
  const digits = abs(normalized.int).toString().padStart(normalized.scale + 1, '0');
  if (normalized.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -normalized.scale) || '0';
  const frac = digits.slice(-normalized.scale).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

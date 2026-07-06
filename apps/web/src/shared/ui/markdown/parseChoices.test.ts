import { describe, expect, it } from 'vitest';
import { parseChoiceBlock } from './parseChoices';

describe('parseChoiceBlock (G11-a choices directive)', () => {
  it('returns null when there is no ::choices block', () => {
    expect(parseChoiceBlock('그냥 일반 답변입니다.')).toBeNull();
  });

  it('extracts numbered options inside a ::choices ... :: fence', () => {
    const text = ['다음 중 무엇을 원하세요?', '', '::choices', '1. 예산 검토', '2. 현장 실사', '::'].join('\n');
    const parsed = parseChoiceBlock(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.before.trim()).toBe('다음 중 무엇을 원하세요?');
    expect(parsed!.choices).toEqual(['예산 검토', '현장 실사']);
    expect(parsed!.after).toBe('');
  });

  it('accepts dash/bullet markers as well as numbers', () => {
    const text = ['::choices', '- 옵션 A', '* 옵션 B', '3) 옵션 C', '::'].join('\n');
    const parsed = parseChoiceBlock(text);
    expect(parsed!.choices).toEqual(['옵션 A', '옵션 B', '옵션 C']);
  });

  it('preserves text after the closing fence', () => {
    const text = ['질문:', '::choices', '1. 하나', '2. 둘', '::', '', '추가 설명입니다.'].join('\n');
    const parsed = parseChoiceBlock(text);
    expect(parsed!.before.trim()).toBe('질문:');
    expect(parsed!.choices).toEqual(['하나', '둘']);
    expect(parsed!.after.trim()).toBe('추가 설명입니다.');
  });

  it('does NOT treat an ordinary ordered list as choices (strict marker)', () => {
    const text = ['할 일:', '1. 첫째', '2. 둘째'].join('\n');
    expect(parseChoiceBlock(text)).toBeNull();
  });

  it('ignores an unterminated ::choices fence (still streaming)', () => {
    const text = ['질문', '::choices', '1. 아직 스트리밍 중'].join('\n');
    expect(parseChoiceBlock(text)).toBeNull();
  });

  it('drops empty option lines and trims whitespace', () => {
    const text = ['::choices', '1.   앞뒤 공백  ', '', '2. 정상', '::'].join('\n');
    const parsed = parseChoiceBlock(text);
    expect(parsed!.choices).toEqual(['앞뒤 공백', '정상']);
  });

  it('returns null when the fence has no valid options', () => {
    const text = ['::choices', '아무 마커 없는 줄', '::'].join('\n');
    expect(parseChoiceBlock(text)).toBeNull();
  });
});

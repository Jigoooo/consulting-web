# Consulting Web editorial product design research

## 결론

Consulting Web은 장식적인 AI SaaS가 아니라 **근거를 읽고 판단하고 행동하는 편집형 업무 도구**여야 한다. 화면의 90%는 웜 뉴트럴 레이어로 구성하고, 저채도 코발트 한 색만 primary action·focus·selected state에 사용한다. 정적 콘텐츠는 여백·정렬·타입 위계로 묶고, border와 shadow는 실제 그룹 관계나 z축 중첩을 설명할 때만 사용한다.

## 조사한 근거

| 근거 | 핵심 원칙 | Consulting Web 적용 |
| --- | --- | --- |
| [NN/g — Aesthetic and Minimalist Design](https://www.nngroup.com/articles/aesthetic-minimalist-design/) | 불필요한 정보와 장식은 핵심 정보와 경쟁한다. font/color 변형을 과용하지 말고 “communicate; don’t decorate.” | glow·aurora blob·장식 gradient 제거. 결론·필수조치·다음 행동을 첫 시선에 배치. |
| [NN/g — Common Region](https://www.nngroup.com/articles/common-region/) | border/background는 강한 grouping 신호다. 여백으로 충분한 곳의 박스 남용은 clutter와 false floor를 만든다. | 카드 안 카드 제거. 인접 메트릭·리스트는 whitespace와 divider로 묶고, 경계는 입력·실제 컨테이너에만 둔다. |
| [NN/g — Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | 고급·저빈도 기능은 요청 시 노출해야 학습과 오류가 줄어든다. | trace raw metadata, 기술 ID, 상세 verifier 정보는 details/secondary panel에 둔다. 기본 화면은 판정과 행동 중심. |
| [Material 3 — Elevation](https://m3.material.io/styles/elevation/applying-elevation) | 기본 surface 분리는 tonal difference를 사용한다. shadow는 실제 overlap·distance를 설명한다. 높은 elevation은 상호작용 상태용이다. | 정적 문서·trace·sidebar search shadow 제거. dialog·popover·FAB에만 pop shadow 유지. |
| [Material 3 — Shape](https://m3.material.io/styles/shape/overview) | shape와 큰 radius는 기능·감정·강조의 순간에 의도적으로 사용한다. | 보통 버튼 8px, section 10px, dialog 14px. pill은 짧은 status/chip에만 사용. |
| [Carbon — Color](https://carbondesignsystem.com/elements/color/overview/) | 중립 gray value 차이로 영역과 깊이를 만들고, blue는 primary action에 쓴다. 색은 role token으로 관리한다. | 웜 아이보리/charcoal layering + 저채도 cobalt. component의 직접 red/amber/green hex 제거. |
| [Carbon — Typography](https://carbondesignsystem.com/elements/typography/overview/) | weight와 size 조합이 위계를 만든다. running text는 neutral, primary blue는 action에 사용한다. | Wanted Sans 한 family, 400/510/590/650. 상태 본문까지 색칠하지 않고 badge/icon/rule에만 semantic color. |
| [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | size·weight·color로 hierarchy를 만들고 typeface 수를 최소화한다. 작은 글자의 light weight를 피한다. | 폰트 추가 금지. 10–11px 남용 축소, 12px 이상과 충분한 contrast 확보. |
| [Apple HIG — Layout](https://developer.apple.com/design/human-interface-guidelines/layout) | 중요한 정보에 충분한 공간을 주고, alignment·negative space·separator로 관계를 표현한다. secondary 정보는 별도 view로 보낸다. | 좌상단 결론 → 근거 → 행동 순서. 카드 그리드보다 공통 baseline과 section rhythm 우선. |
| [WCAG 2.2 — Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) | 색만으로 상태를 전달하면 안 된다. | PASS/WARN/BLOCKED에 텍스트·아이콘·label을 항상 병행. |
| [WCAG 2.2 — Contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | 일반 텍스트 4.5:1, 큰 텍스트 3:1. hue/saturation보다 명도 대비가 핵심이다. | muted text contrast 측정, focus ring 유지, 상태 배경 채도를 낮춰도 텍스트 대비 유지. |
| [Google Research — Visual complexity & prototypicality](https://research.google/pubs/the-role-of-visual-complexity-and-prototypicality-regarding-first-impression-of-websites-working-towards-understanding-aesthetic-judgments/) | 시각 복잡도와 전형성이 웹사이트 첫인상에 영향을 준다. | 익숙한 B2B shell 패턴을 유지하고 장식적 novelty보다 읽기 속도를 우선. |
| [Baymard — Line length](https://baymard.com/blog/line-length-readability) | 본문은 대체로 50–75자 범위가 읽기 좋다. | 산출물·검토 설명·긴 답변에 읽기 폭을 제한하고 메타데이터는 별도 행으로 분리. |
| [온니디자인](https://www.instagram.com/onnydesign/) | “예쁜 디자인”보다 고객의 시선이 멈추고 신뢰가 생기며 행동하는 동선을 설계한다. 한 카드에는 한 지배색, 강한 type hierarchy, 작은 반복 로고를 사용한다. | 신뢰(판정/출처) → 이해(결론/근거) → 행동(수정/발행/검토)의 흐름을 화면 위계로 만든다. 소셜 카드의 고채도 스타일 자체는 제품 UI에 복제하지 않는다. |

## 제품 설계 계약

### 색과 배경

- 웜 아이보리 canvas, 한 단계 진한 sidebar/panel, 밝은 document surface의 3단 뉴트럴 레이어.
- `--accent`는 저채도 cobalt 한 색. primary CTA, focus, selected rail에만 사용.
- green/amber/red는 상태 label·아이콘·3px rule에만 사용하고 넓은 면적을 칠하지 않는다.
- 순수 `#000`과 밝은 보라/청록 네온, 장식용 gradient/glow를 제품 표면에서 사용하지 않는다.

### border, shadow, radius

- proximity와 alignment로 이해되는 묶음에는 border를 추가하지 않는다.
- 입력·표·실제 region·sticky chrome에는 1px hairline을 쓴다.
- 정적 카드에는 shadow를 쓰지 않는다. popover/dialog/FAB처럼 다른 surface 위에 실제로 뜨는 요소만 elevation을 가진다.
- 버튼 8px, section/card 10px, dialog 14px. pill은 상태·짧은 chip·원형 icon control만 허용한다.

### typography

- Wanted Sans Variable 한 family를 유지한다. monospace는 ID/code에만 사용한다.
- 본문 400, UI 510, 강조 590, display 650. 800/850 같은 과중한 weight를 제거한다.
- 긴 본문은 50–75자 폭, line-height 1.55–1.68. 작은 메타도 12px 이하 남용을 피한다.

### layout와 UX flow

- 화면 첫 영역: 현재 대상·판정·핵심 결론·다음 행동.
- 두 번째 영역: 근거와 상태 요약.
- raw ID·metadata·고급 도구는 요청 시 펼치는 progressive disclosure.
- selected state는 배경 전체 채색보다 얇은 cobalt rail + weight 변화로 표시한다.
- 색을 제거해도 label과 구조만으로 모든 상태를 이해할 수 있어야 한다.

## 검증 기준

1. 제품 source policy test: BrandMark/Auth/Rail/Thread primary surface에 gradient·glow 없음.
2. static card에 elevation shadow 없음; popover/dialog shadow는 유지.
3. 직접 semantic hex 제거 및 token 사용.
4. light/dark 360/768/1440px 실브라우저 스크린샷, overflow·console 0.
5. keyboard focus·reduced motion·24px hit target 회귀 유지.
6. 최종 Web test/typecheck/lint/build와 독립 UX review BLOCKER/HIGH 0.

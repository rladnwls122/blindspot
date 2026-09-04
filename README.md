# Blindspot

[![CI](https://github.com/rladnwls122/blindspot/actions/workflows/ci.yml/badge.svg)](https://github.com/rladnwls122/blindspot/actions/workflows/ci.yml)

**Blindspot은 코드 리뷰에서 개발자의 실제 주의(attention)를 측정하는 개발자 도구입니다.**

> `git blame`은 그 줄을 *누가 썼는지* 알려줍니다.
> Blindspot은 그 줄을 *누가 읽었는지* 알려줍니다.

diff의 각 줄에 당신의 시선이 실제로 머물렀는지를 IDE 이벤트만으로 추정하고,
커밋 직전에 **당신이 끝내 읽지 않은 부분**을 알려주는 VS Code 확장입니다.

*[English README](README.en.md)*

```
┌─────────────────────────────────┐
│     BLINDSPOT                   │
│                                 │
│ Review coverage     55%         │
│ Blindspot           45% ⚠       │
│                                 │
│  182 changed lines              │
│  101 reviewed                   │
│   81 unseen                     │
│                                 │
│ ⚠ CRITICAL                      │
│ src/auth/session.ts             │
│ lines 9-34 unread               │
│                                 │
│ [ Review Blindspot ]            │
└─────────────────────────────────┘
```

이 카드는 목업이 아닙니다. `npm run demo`를 실행하면 실제 스코어링 모델이
스크립트로 기록된 편집 세션을 재생하면서 저 숫자들을 계산해 냅니다.

## 왜 만들었나

우리에게는 *테스트*가 코드의 몇 %를 훑었는지 재는 지표가 있습니다.
하지만 *사람*이 코드의 몇 %를 봤는지 재는 지표는 없습니다.

코드를 쓰는 일이 느렸을 때는 그 공백이 문제가 되지 않았습니다. 지금은 아닙니다.
diff는 읽히는 속도보다 빠르게 생산되고, AI 보조 개발의 자연스러운 실패 모드는
**크고, 그럴듯하고, 아무도 읽지 않았는데 CI는 통과한 변경**입니다.

Blindspot은 아무도 재지 않는 것을 잽니다 — 주의(attention).

## 연구 배경

"사람이 코드 리뷰에서 어디를 얼마나 보는가"는 이미 학계에서 측정된 적이 있는
질문입니다. 다만 그 측정은 전용 eye-tracker를 전제로 했습니다.

| 선행 사례 | 무엇을 측정하나 | Blindspot과의 차이 |
| --- | --- | --- |
| [Eye Movements in Code Review](https://andrewbegel.com/papers/eye-movements-code-review.pdf) | 리뷰 중 개발자의 시선 이동과 결함 발견 과정 | 가장 가까운 학술적 선행연구. 제품이 아니라 실험 |
| [GANDER](https://portal.research.lu.se/en/publications/gander-a-platform-for-exploration-of-gaze-driven-assistance-in-co) / [Gazing at Code Reviews](https://portal.research.lu.se/en/projects/gazing-at-code-reviews/) | gaze 기반 리뷰 보조 기법 탐색 | eye-tracking 연구 플랫폼. 일상 개발 워크플로가 목표가 아님 |
| [CodeGRITS](https://codegrits.github.io/CodeGRITS/) | IDE 행동 + 실제 시선(gaze) 동시 추적 | 연구 데이터 수집용이고 Tobii 등 **전용 하드웨어**가 필요 |
| [The GitHub Gaze](https://digitalcommons.unl.edu/honorsembargoed/521/) | PR/이슈에서 개발자 시선이 어디 쏠리는지 | 플랫폼 UI 연구. diff 커버리지 도구가 아님 |
| Flow Review Coverage | PR의 몇 %가 리뷰됐는지 | **댓글이 달린 hunk 비율**을 셀 뿐, 사람이 읽었는지는 보지 않음 |
| [Vouch](https://marketplace.visualstudio.com/items?itemName=sanzhardanybayev.vouch-review-coverage) | 사람이 "reviewed"라고 **표시한** 범위 | 제품적으로 가장 가까움. 다만 자기신고(attestation)이고 행동 증거가 아님 |

Vouch와의 차이가 이 프로젝트의 핵심입니다.

```text
Vouch
"내가 이 코드를 검토했다고 표시했다"

        ↓

Blindspot
"네가 실제로 이 코드를 읽은 행동적 증거가 있었는가?"
```

그래서 이 프로젝트가 서 있는 자리는 이렇습니다.

```text
Eye-tracking 연구
        ↓
코드 리뷰 중 개발자의 시선은 측정 가능하다
        ↓
그러나 전용 eye tracker는 일상 개발에 비현실적이다
        ↓
Blindspot은 IDE 상호작용 신호만으로 리뷰 주의를 근사한다
        ↓
그 결과를 실행 가능한 diff 커버리지로 바꾼다
```

**하드웨어는 쓰지 않습니다.** 카메라도, eye tracker도, 외부 전송도 없습니다.
VS Code가 이미 알고 있는 것 — 어떤 줄이 화면에 있었고, 커서가 어디였고,
뷰포트가 언제 멈췄는지 — 만으로 추정합니다.

`visible / focused / dwell / caret / edited / revisit`라는 evidence model은
그 자체가 대단한 발명이라기보다 **위 연구 가설을 하드웨어 없이 구현한 것**입니다.

## "읽었다"의 정의

이 프로젝트의 진짜 연구 질문이고, 모델 전체는
[`src/core/evidence.ts`](src/core/evidence.ts)의 약 30줄이 전부입니다.
여섯 개 신호에 가중치를 주고, 임계값을 둡니다.

| 신호 | 의미 | 점수 |
| --- | --- | --- |
| visible | 화면에 300ms 이상 (줄의 읽기 비용에 비례해 조정) | 1 |
| focused | 창이 포커스된 상태에서 활성 에디터에 800ms 이상 | 1 |
| dwell | 그 줄이 화면에 있는 동안 뷰포트가 1초 이상 멈춤 | 1 |
| caret | 커서를 올렸거나 선택했거나, **마우스가 그 줄 위에 멈췄음** | 1 |
| edited | 그 줄에 직접 타이핑했음 | 2 |
| revisit | 떠났다가 나중에 돌아와 다시 읽었음 | 1 |

**3점이면 reviewed**입니다. 이 임계값은 프로젝트가 출발점으로 삼은 세 명제가
문자 그대로 참이 되도록 고른 값이고, 그 명제들은
[`test/evidence.test.ts`](test/evidence.test.ts)에 그대로 단언되어 있습니다.

```
스크롤로 지나감           →  1점   ≠ reviewed
0.2초 동안 보임           →  0점   ≠ reviewed
보임 + 멈춤 + 커서        →  3점   ≈ reviewed
```

창이 포커스를 잃은 동안, 뷰포트가 사람이 읽을 수 없는 속도(기본 45줄/초)로
움직이는 동안, 2초보다 긴 tick 동안에는 아무것도 적립되지 않습니다.
그렇지 않으면 노트북을 덮어 둔 한 시간이 성실한 독서 시간으로 보고됩니다.

## eye tracker 없이 정확도를 올리는 방법

뷰포트를 그대로 "읽은 기록"으로 취급하면 모델은 거짓말을 합니다.
60줄이 떠 있는 에디터에서 커서 주변 10줄과 화면 맨 아래 줄이 같은 비율로
읽혔을 리 없기 때문입니다. 그래서 세 가지를 명시적으로 모델링합니다
([`src/core/attention.ts`](src/core/attention.ts)).

### 1. Focal weighting — 주의는 국소적이다

읽기의 perceptual span은 몇 줄 폭이고, 그 창은 **작업 중인 지점**에 붙어
다닙니다. 그래서 한 tick의 크레딧을 뷰포트 전체에 균등 배분하지 않고,
**초점에서 멀어질수록 감쇠**시켜 나눠 줍니다.

초점은 커서입니다 — 에디터가 알려 주는, 가장 최근의 의도적 행동 위치.
커서가 화면 밖으로 스크롤된 경우에만 뷰포트 중앙으로 대체합니다.

```
        커서
         │
  가중치 │  ────────────          full credit (±5줄)
         │              ╲
         │               ╲        선형 감쇠
         │                ╲___    peripheral floor (0.2)
         └──────────────────────  초점으로부터의 거리
                        24줄
```

0이 아니라 바닥값(0.2)으로 수렴하는 것이 중요합니다. 화면에 있던 줄은
읽혔을 가능성이 *어느 정도는* 있고, 0이라고 말하는 것도 1이라고 말하는 것만큼
거짓입니다.

멈춤(dwell)도 같은 원리로 초점 근방에만 적립됩니다. 뷰포트가 멈췄다는 건
당신이 **어딘가에서** 멈췄다는 증거이지, **모든 곳에서** 멈췄다는 증거가 아닙니다.

### 2. 줄마다 읽기 비용이 다르다

읽기 연구에서 fixation 수는 줄 수가 아니라 **토큰 수**를 따라갑니다.
고정된 300ms 임계값은 `}`에는 과하게 후하고, 140자짜리 표현식에는 부당하게
박합니다. 그래서 식별자 런과 연산자로 토큰 수를 추정해 시간 임계값을
비례 조정합니다.

```ts
readCost('}')                                        // 0.35 → 105ms면 충분
readCost('const x = 1;')                             // 0.75
readCost('const totals = rows.reduce((a, r) => …);') // 1.4  → 420ms 필요
```

### 3. 다시 읽은 것은 강한 이해 신호다

코드 읽기 연구에서 **regression(되돌아 읽기)** 은 이해 과정과 가장 강하게
연결되는 행동 중 하나입니다. 어떤 줄을 20초 이상 떠났다가 다시 보면
새로운 viewing episode로 세고, revisit 신호를 줍니다.

단, revisit은 **focused 시간이 있을 때만** 점수가 됩니다. 그렇지 않으면
백그라운드 split에 열어 둔 파일을 두 번 스크롤한 것이 재독 크레딧이 됩니다.

### 4. 마우스는 두 번째 시선 센서다

초점을 커서로만 근사하면, 커서를 파일 맨 위에 두고 **마우스 휠과 포인터로**
읽는 가장 흔한 읽기 방식이 통째로 빠집니다. 크레딧은 전부 커서 근처로 가고,
실제로 읽은 줄은 blindspot으로 남습니다.

VS Code는 마우스 위치를 알려 주지 않지만, 포인터가 토큰 위에 멈추면 hover
provider를 호출합니다. 그 호출이 "마우스가 이 줄에 있었다"는 유일한 관측이고,
마우스 위치와 시선의 상관관계는 HCI에서 오래 측정된 사실입니다. 그래서 hover
요청은 두 가지로 쓰입니다.

- **초점 선택** — 커서와 마우스 중 *더 최근에* 움직인 쪽이 attention budget의
  초점이 됩니다. 스크롤하면 마우스 아래의 텍스트가 바뀌므로 그 순간 무효화됩니다.
- **navigated 신호** — 커서를 올린 것과 같은 행위를 다른 센서로 본 것이므로
  같은 점수를 받습니다. hover 설명에는 `1× caret, 2× mouse`처럼 따로 나옵니다.

`editor.hover.enabled`를 끈 사용자에게는 이 센서가 없고, 그러면 예전처럼
커서만으로 돌아갑니다. 없다고 틀리지는 않고, 있으면 정확해집니다.

### 5. 숫자를 얼마나 믿어도 되는지 같이 보여준다

같은 "116줄 읽음"이라도 커서·마우스·타이핑이 닿은 줄과 화면 시간만으로 통과한
줄은 신뢰도가 다릅니다. 그래서 보고서는 reviewed 줄 중 **interacted** 줄 수를
따로 셉니다. 그리고 읽은 속도도 냅니다.

```
Read      64    116/182 lines, 71 interacted with
Focus     41    5m 12s of attention
Activity  80    19 actions
Pace            ≈ 22 lines/min   faster than reviewers catch defects at
```

attention은 초당 `attentionLines`줄어치로 보존되는 예산이므로, 대상 줄에 적립된
focused 시간을 그 처리량으로 나누면 실제로 쓴 시간이 대략 복원됩니다. 리뷰 연구가
결함 발견율이 급락한다고 보는 시간당 300–500줄을 넘으면 `fast`로 표시됩니다 —
그 커버리지 숫자는 믿지 말라는 뜻입니다.

삭제된 줄은 여전히 점수에 들어가지 않지만, 이제 파일마다 `−12 deleted`로
**보입니다**. 조용히 지워진 null 체크가 버그가 되는 곳이니까요.

### 이 모델은 껐다 켤 수 있습니다

`focalModel`, `contentScaling`을 끄면 예전의 평평한 뷰포트 모델로 돌아갑니다.
차이가 **주장**이 아니라 **측정 가능**해야 하기 때문에 남겨 둔 스위치입니다.
[`test/attention.test.ts`](test/attention.test.ts)에는 같은 세션을 두 모델로
재생해 결과가 갈리는 케이스가 단언으로 들어 있습니다.

### 왜 안 읽었다고 하는지 물어볼 수 있어야 한다

반박할 수 없는 커버리지 숫자는 아무도 믿지 않습니다. 안 읽은 줄에 마우스를
올리면 그 줄이 실제로 얻은 신호와 못 얻은 신호가 그대로 나옵니다.

```
blindspot — 2/3 pts
✓ on screen (5000ms)
✓ focused (5000ms)
· paused (0×)
· navigated (0× caret, 0× mouse)
· edited (0×)
· re-read (0× returned)
· read time 5.0s of 2.0s (100%)
```

"나 이거 읽었는데"와 모델의 판단이 갈릴 때, 그 자리에서 어느 쪽이 맞는지
확인할 수 있어야 모델을 고칠 수도 있습니다. `blindspot.explainOnHover`.

## 두 가지 모드: Diff / Reading

같은 엔진, 같은 보고서, 대상만 다릅니다. 상태 표시줄, `Blindspot: Switch Mode`,
`Blindspot: Toggle Diff / Reading Mode`에서 바꿉니다.

| | Diff | Reading |
| --- | --- | --- |
| 대상 | 내가 바꾼 줄 — 마지막으로 완료한 리뷰 이후, 없으면 `baseRef`(HEAD) 이후 | 이 폴더에서 연 모든 파일의 모든 줄 |
| 헤드라인 | **36% unread** — 아직 답하지 않은 질문 | **62% read** — 진척 |
| 거터 마커 | 주황(위험하면 빨강) | 파랑 |
| Review Score | 있음 | 없음 (새 코드도 위험도 가중도 의미가 없음) |
| 필요한 것 | git | 폴더 |

Diff 모드에서 무엇을 기준으로 잴지는 `Blindspot: Choose What the Diff Is Measured
Against`로 고릅니다 — 마지막 완료 리뷰, `baseRef`, 또는 아무 ref나. `Complete Review`는 기준을 HEAD로 옮깁니다.

모드가 Reading이어도 **커밋 직전 경고는 항상 diff를 잽니다.** 코드를 읽는 중이었다는
이유로 커밋 경고가 조용히 꺼지는 것이 이 스위치의 유일한 위험이었고, 그래서
스테이징 순간에는 diff 보고서를 따로 계산합니다.

사이드바(Source Control 뷰 아래 **Blindspot**)에는 안 읽은 파일이 위험도 순으로,
그 아래 정확한 줄 범위가 트리로 놓입니다. 클릭하면 그 줄로 갑니다.

### 정의를 움직여 볼 수 있습니다

보고서 패널은 [`demo/index.html`](demo/index.html)과 같은 페이지이고, 다른 점은
데이터가 지금 이 세션의 증거라는 것뿐입니다. 슬라이더로 "읽었다"의 임계 점수를
바꾸면 커버리지, 파일 랭킹, Review Score가 브라우저 안에서 다시 계산됩니다 —
확장이 기록한 것과 동일한 per-line 신호에서요. 저장은 되지 않습니다. 정의를
바꾸려면 `blindspot.reviewThresholdPoints` 설정이나 팀 전체 정의인
`.blindspot/config.json`을 고치세요.

## 퍼센트만으로는 아무 의미가 없다

"36% 안 읽음"은 그 자체로는 아무것도 뜻하지 않습니다.
README 40줄을 안 읽은 건 괜찮고, `auth/session.ts` 3줄을 안 읽은 건 안 괜찮습니다.

그래서 모든 변경 줄은 위험도로도 분류됩니다 — 경로(`auth/`, `billing/`,
`migrations/`, `.github/workflows/`)와 내용(`eval(`, `process.env`, 문자열로
조립한 SQL, `innerHTML`) 양쪽에서. 그리고 보고서는 **위험도 우선, 분량은 그
다음**으로 정렬됩니다.

critical 파일 안의 주석은 한 단계 강등됩니다. 주석에 auth 버그를 실어 보낼 수는
없으니까요.

종합 **Review Score**는 커버리지를 "무엇에 대한 커버리지였는지"로 가중한 값입니다.

```
Review Score

████░░░░░░ 43

Coverage         55%
Critical         21%     ← 점수가 55가 아니라 43인 이유
New code         55%
Machine-written  43%
```

측정할 대상이 없는 항목은 빠지고 가중치는 나머지에 재분배됩니다.
critical 코드를 건드리지 않은 diff가 그 이유로 벌점을 받지는 않습니다.

## AI 코드는 '제품'이 아니라 '버킷'이다

AI가 생성한 코드만 추적하면 더 나쁜 도구가 됩니다. 문제는 **누가 썼든 아무도
읽지 않은 코드**니까요. 모든 변경 줄이 측정되고, 기계 저작 여부는 커버리지를
*대체*하는 게 아니라 *나란히* 보고됩니다.

provenance는 모델에 대한 추측이 아니라 실제로 관측된 것만 기록합니다.

- `typed` — 사람 키 입력으로 쌓인 줄
- `bulk` — 한 번의 기계 속도 삽입으로 들어온 줄 (에이전트, 붙여넣기, codemod)
- `declared-ai` — 도구가 `.blindspot/ai-regions.json`으로 명시적으로 선언한 줄
- `unknown` — 추적 이전부터 있던 줄

## 설치

쓰려는 경우 — `.vsix`를 만들어 설치합니다.

```bash
npm install
npm run package                              # blindspot-0.3.1.vsix 생성
code --install-extension blindspot-0.3.1.vsix
```

git 저장소가 열려 있으면 바로 상태 표시줄과 Activity Bar의 Blindspot 뷰에
커버리지가 뜹니다. 저장소가 아닌 폴더에서도 명령은 등록되며, 무엇이 없는지 알려
줍니다.

개발하려는 경우:

```bash
npm install
npm run build
npm test           # 221개 테스트 (모델, CLI, 실제 git 저장소, 그리고 확장 자체)
npm run demo       # 스크립트 세션을 실제 모델로 재생
npm run demo:page  # demo/index.html 재생성 — 인터랙티브 버전
npm run icon       # media/icon.png 재생성
```

확장을 디버그하려면 이 폴더를 VS Code로 열고 <kbd>F5</kbd>를 누르세요.

[`demo/index.html`](demo/index.html)은 같은 보고서에 임계값 슬라이더를 붙인
것입니다. 슬라이더를 움직이면 커버리지, 파일 랭킹, Review Score가 전부
확장이 기록하는 것과 동일한 per-line 신호에서 다시 계산됩니다.
`media/page.html`에서 생성되므로 그 안의 숫자가 모델과 어긋날 수 없습니다.

### 명령

| 명령 | 하는 일 |
| --- | --- |
| `Blindspot: Show Review Report` | 위의 패널 |
| `Blindspot: Switch Mode (Diff / Reading)` | 무엇을 잴지 |
| `Blindspot: Choose What the Diff Is Measured Against` | 마지막 리뷰 / `baseRef` / 임의의 ref |
| `Blindspot: Review Blindspot` | 안 읽은 hunk로 점프, 위험도 높은 순 |
| `Blindspot: Mark File As Reviewed` | "이건 GitHub UI에서 읽었다" (사이드바에서도) |
| `Blindspot: Stop Measuring This File` | 실수로 연 파일을 분모에서 뺀다 (사이드바 휴지통) |
| `Blindspot: Complete Review` | 기준을 HEAD로 — 여기까지는 봤다 |
| `Blindspot: Install pre-commit Hook` | 커밋 시점에 카드 출력 |
| `Blindspot: Toggle Unread Line Markers` | 거터 마커 |
| `Blindspot: Reset Review Evidence` | 처음부터 다시 |

### CLI

```bash
blindspot check --staged            # 지금 커밋하려는 것에 대한 카드 출력
blindspot report                    # 파일별 표 + Read/Focus/Activity/Pace
blindspot read                      # Reading 모드가 보는 것 — 연 파일 전체. git 불필요
blindspot read src/core             # 그중 한 파일이나 폴더만
blindspot forget vendor/            # 분모에서 뺀다 (증거 삭제 + 이후로도 재지 않음)
blindspot forget --list             # 뺀 목록 · --undo <path> 로 되돌림
blindspot check --min-coverage 70   # 70% 미만이면 exit 1 (CI나 엄격한 훅용)
blindspot check --json              # 기계가 읽는 형식
blindspot check --staged --trailer  # 커밋 트레일러 한 줄: Blindspot: 36% (66/182 lines unread)
blindspot install-hook --trailer    # prepare-commit-msg 훅도 설치 — 커밋마다 그 줄을 남김 (옵트인)
blindspot --version                 # 버전
```

설치되는 pre-commit 훅은 기본적으로 **경고하고 exit 0** 합니다. 커밋을 막는
리뷰 도구는 일주일 안에 제거되고, 참인 사실을 알려 주는 도구는 남습니다.
강제는 `--min-coverage` / `--max-critical`로 옵트인입니다.

커밋 트레일러도 **옵트인**입니다. 증거는 `.git` 안에 머물고 클론과 함께
사라지지만, 트레일러는 커밋과 함께 저장소를 떠나는 유일한 숫자이기 때문입니다.
대신 그 덕분에 나중에 "버그 수정이 고친 줄은 들어올 때 읽히지 않은 줄이었나"를
물을 수 있습니다 — 이 지표가 의미가 있는지를 가르는 실험의 데이터가 여기서
나옵니다. merge / squash / amend 메시지는 건드리지 않고, `--no-verify`로도
꺼지지 않습니다: 그 플래그는 검사를 건너뛰는 것이고, 이건 검사가 아니라 기록입니다.

## 설정

에디터 설정은 `blindspot.*` 아래에 있습니다. `blindspot.mode`(`auto` / `diff` /
`reading`)와 `blindspot.diffSince`(`lastReview` / `baseRef`)는 패널과 명령이 대신
써 주는 값이고, 나머지는 측정 모델의 손잡이입니다. 프로젝트 전체 규칙 — *이*
코드베이스에서 무엇이 위험한가 — 은 커밋되는 `.blindspot/config.json`에 두어 팀이
하나의 정의를 공유합니다.

```json
{
  "reviewThresholdPoints": 3,
  "minCoverage": 70,
  "maxCriticalBlindspotLines": 0,
  "focalModel": true,
  "focalSpanLines": 2,
  "focalDecayLines": 10,
  "peripheralFloor": 0.05,
  "contentScaling": true,
  "revisitGapMs": 20000,
  "pathRules": [
    { "pattern": "(^|/)payments/", "level": "critical", "reason": "money movement" }
  ]
}
```

## 데이터가 사는 곳

`.git/blindspot/state.json` — git 디렉터리 안이라 clone마다 따로 있고, 실수로
커밋될 수 없고, clone과 함께 지워집니다. 리뷰 주의 기록은 **당신에 대한 개인
텔레메트리**입니다. 공유 브랜치로 새어 나가면 안 됩니다. 아무것도 기기 밖으로
나가지 않습니다.

증거는 줄 번호가 아니라 **줄 내용의 해시**에 붙습니다. 읽은 줄 위에 import 하나를
끼워 넣어도 그 크레딧이 안 읽은 줄로 넘어가지 않습니다. 들여쓰기를 바꾸면 증거가
유지되고, 토큰을 바꾸면 사라집니다.

## 아키텍처

```
src/core/        모델 — vscode를 import하지 않음, 전부 유닛 테스트됨
  attention.ts     focal weighting, 읽기 비용, 재독 — eye tracker의 대역
  evidence.ts      여섯 신호 → 점수 → reviewed
  risk.ts          경로 + 내용 → 위험도
  ledger.ts        편집과 재로드를 가로지르는 줄 정체성
  coverage.ts      diff × 증거 → 보고서 (interacted, pace, 삭제 줄 포함)
  score.ts         종합 점수
  labels.ts        패널·상태바·사이드바·CLI가 같은 말을 쓰게 하는 문구
  tree.ts          사이드바를 데이터로 — vscode 없이 테스트됨
src/extension/   에디터 접착부 (tracker, panel, tree, decorations, git)
src/cli/         `blindspot` — 훅과 CI 진입점
demo/            스크립트 세션을 실제 모델로 재생
```

`core` 경계는 의도적입니다. "읽었다"의 정의는 에디터 없이도 재조정하고 재생할 수
있어야 하고, 그렇지 않으면 검증 자체가 불가능합니다.

## 알려진 한계

- 초점은 커서와 마우스로 근사합니다. 둘 다 두고 눈만 다른 곳을 읽는 경우는
  잡지 못합니다. 이것이 eye tracker 없이 남는 가장 큰 오차원이고, 마우스 센서는
  `editor.hover`가 켜져 있을 때만 있습니다.
- 터미널이나 패널에 포커스가 있어도 VS Code는 마지막 에디터를 활성으로 보고합니다.
  그 시간은 `idleAfterMs`(30초)까지 커서 근처 몇 줄에 적립될 수 있습니다.
- 읽기 비용은 토큰 수 추정이지 이해 난이도가 아닙니다. 짧고 어려운 줄은
  과소평가됩니다.
- 화면 밖 리뷰(GitHub UI, 종이 출력, 페어 리뷰)는 관측되지 않습니다.
  그래서 `Mark Current File As Reviewed`가 있습니다.
- 모든 오차는 **"덜 읽었다고 말하는 쪽"** 으로 기울어 있습니다. 다시 읽으라고
  말하는 실수가, 읽었다고 말해 주는 실수보다 낫습니다.

무엇이 아직 틀렸고 어떻게 확인할지는 [`docs/RESEARCH.md`](docs/RESEARCH.md)에
있습니다.

## 상태

v0.3.1 이후 미출시 — 두 모드, 인터랙티브 페이지 패널과 사이드바, 마우스 센서,
interacted/pace가 `main`에 들어가 있습니다. 무엇이 바뀌었는지는
[`CHANGELOG.md`](CHANGELOG.md)에, 무엇을 더 재고 무엇을 더 만들지 따져 본 기록은
[`docs/BRAINSTORM.md`](docs/BRAINSTORM.md)에 있습니다. 다음 계획은
[`docs/PLAN.md`](docs/PLAN.md), 아직 열려 있는 결정은
[`docs/QUESTIONS.md`](docs/QUESTIONS.md)를 보세요.

## 참고 문헌

- Begel et al., [*Eye Movements in Code Review*](https://andrewbegel.com/papers/eye-movements-code-review.pdf)
- [GANDER: A Platform for Exploration of Gaze-Driven Assistance in Code Review](https://portal.research.lu.se/en/publications/gander-a-platform-for-exploration-of-gaze-driven-assistance-in-co) (Lund University)
- [Gazing at Code Review(s)](https://portal.research.lu.se/en/projects/gazing-at-code-reviews/) (Lund University)
- [CodeGRITS](https://codegrits.github.io/CodeGRITS/) — [github.com/codegrits/CodeGRITS](https://github.com/codegrits/CodeGRITS)
- Rasgorshek, [*The GitHub Gaze*](https://digitalcommons.unl.edu/honorsembargoed/521/)
- [Vouch — Review Coverage](https://marketplace.visualstudio.com/items?itemName=sanzhardanybayev.vouch-review-coverage)

## License

MIT

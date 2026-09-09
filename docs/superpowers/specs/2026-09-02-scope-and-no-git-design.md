# Scope 리뷰와 git 없는 워크스페이스 — 설계

> diff가 아닌 스코프로도 읽기 커버리지를 재고, git 저장소가 아닌 폴더에서도
> 동작하게 만든다. 2026-09-02.

## 문제

Blindspot은 지금 "커밋 전에 이 diff 중 안 읽은 게 얼마인가"만 답한다. 그
질문이 성립하려면 git이 세 가지를 동시에 제공해야 한다.

1. **스코프** — `git diff`가 "읽어야 할 줄"의 목록을 정해 준다
2. **저장 위치** — `.git/blindspot/state.json`
3. **경로 정체성** — repo toplevel 기준 상대경로

그래서 지금은 저장소가 아니면 확장이 아무것도 재지 못한다. 하지만 사람이 코드를
읽는 상황 대부분은 diff가 아니다. 낯선 코드베이스를 정독할 때, 의존성 라이브러리
한 파일을 뜯어볼 때, 강의 실습 코드를 볼 때 — 읽어야 할 것은 있는데 diff는 없다.

## 하지 않는 것

- 스코프와 diff의 숫자를 하나로 합치지 않는다. 400줄짜리 추적 파일이 12줄 diff를
  삼키면 커밋 직전 경고가 무의미해진다. 이 제품에서 가장 날카로운 순간이다.
- 모드 토글을 만들지 않는다. 커밋하는 순간 모드가 scope면 diff 경고를 놓친다.
  조용히 틀리는 쪽이다.
- `Ctrl+,` 설정 페이지를 webview로 복제하지 않는다. 네이티브가 검색·기본값
  복원·설정 동기화까지 이미 한다.
- 읽기 습관 분석(어디서 오래 머물렀나, 뭘 건너뛰었나)은 이 spec에 없다. 그건
  누적 카운터가 아니라 세션 타임라인을 요구하므로 별도 프로젝트다. 이 문서의
  저장소 작업이 그 선행 조건이다.

---

## §1 WorkspaceContext

`GitContext`를 `WorkspaceContext`로 교체한다. git은 필수 조건이 아니라 옵션
정보가 된다.

```ts
export interface GitInfo {
  gitDir: string;
  hooksDir: string;
}

export interface WorkspaceContext {
  /** 경로 정체성의 기준. git이면 repo toplevel, 아니면 열린 폴더. */
  root: string;
  /** 증거가 사는 곳. 생성 시점에 한 번 계산한다. */
  stateDir: string;
  /** null이면 저장소가 아니다 — diff·훅·커밋 감시가 없다는 뜻. */
  git: GitInfo | null;
}
```

`findWorkspaceContext(cwd)`:

```
git repo   -> { root: <toplevel>, stateDir: <gitDir>/blindspot, git: {...} }
plain dir  -> { root: <folder>,   stateDir: ~/.blindspot/<hash>, git: null }
```

`hash = sha256(정규화된 절대경로).slice(0, 12)`. 정규화는 `path.resolve` 후
win32에서 소문자 — `C:\Repo`와 `c:\repo`가 서로 다른 기록을 갖게 두면 안 된다.

**구현에서 한 단계 더 필요했다.** 대소문자만이 아니라 **이름 자체가 둘 이상**일 수
있다. 심볼릭 링크·junction·8.3 단축 이름으로 연 폴더는 `path.resolve`만으로는
다른 문자열이고, 그래서 다른 해시, 다른 기록이 된다. 같은 프로젝트를 다른 쪽으로
열면 "한 줄도 읽지 않았다"로 보인다. 그래서 `canonicalPath`(= `realpathSync.native`,
없는 경로는 가장 가까운 실재 조상을 통해)를 거친 이름을 해시한다.

이 변경은 별칭을 쓰지 않는 사람의 상태 위치도 옮긴다(홈이 심볼릭 링크인 경우 등).
따라서 `legacyStateDir` — 이전 버전이 같은 폴더의 상태를 두었을 자리 — 를 컨텍스트에
싣고, 새 자리가 비어 있을 때만 거기서 읽는다. 쓰지도, 지우지도 않는다. 롤백해도
잃는 것이 없어야 하기 때문이다.

`~/.blindspot/<hash>/`에는 `state.json`과 함께 `meta.json`을 쓴다. 원래 폴더
경로와 마지막 접근 시각을 담는다. 해시 디렉터리만 있으면 사람이 열어 봐도 무엇인지
알 수 없고 손으로 지울 수도 없다.

### 왜 홈에 두는가

세 후보를 비교했다.

| | CLI가 찾을 수 있나 | 실수로 커밋되나 | 폴더 지우면 |
| --- | --- | --- | --- |
| `~/.blindspot/<hash>` | 예 (폴더 경로에서 유도) | 아니오 | 남음 (30일 prune) |
| `<폴더>/.blindspot/` | 예 | **예** | 같이 사라짐 |
| VS Code globalStorage | **아니오** | 아니오 | 남음 |

리뷰 주의 기록은 사용자 개인에 대한 텔레메트리다. 공유 브랜치로 새어 나가면 안
된다는 것이 이 프로젝트의 명시적 원칙이므로 두 번째는 탈락한다. globalStorage는
CLI가 경로를 알 방법이 없어서 `blindspot read`가 확장 밖에서 죽는다.

### git 여부로 갈리는 지점

`gitDir`은 실제로 `stateDir()`과 `installHook()` 두 군데에서만 쓰인다. `root`는
곳곳에서 쓰이지만 git 없는 폴더도 root는 있다.

| 기능 | git이 없을 때 |
| --- | --- |
| `collectDiff` | 호출하지 않는다 — diff 리포트가 존재하지 않는다 |
| `CommitWatcher` | 시작하지 않는다 |
| `installHook` | "저장소가 아니라 훅을 걸 곳이 없다"고 알린다 |

tracker, ledger, risk, hover, decorations, panel, coverage는 `root`만 쓰므로 한
줄도 바뀌지 않는다.

기존 동작은 보존된다. git 저장소에서는 지금과 똑같이 `.git/blindspot/state.json`
— clone마다 따로, 커밋 불가, clone과 함께 삭제.

---

## §2 ReviewScope

선언은 경로 목록이다. 파일 하나 또는 폴더 하나. glob이 아니다.

```jsonc
// <stateDir>/scopes.json — state.json 옆. 개인 기록이므로 저장소에 들어가지 않는다.
{
  "version": 1,
  "entries": [
    { "path": "src/core/parser.ts", "declaredAt": 1788270000000 },
    { "path": "vendor/lib",         "declaredAt": 1788270100000 }
  ]
}
```

경로는 `root` 기준 상대경로다. ledger·리포트와 같은 키를 쓴다.

폴더를 걸을 때는 기존 `cfg.ignore`를 그대로 적용한다 (`node_modules`, `dist`,
`*.lock` …). 새 무시 규칙을 만들지 않는다.

### core에 추가되는 것

```ts
// src/core/scope.ts
/** 선언된 파일들을 "전부 읽어야 할 것"으로 표현한 FileDiff. */
export function scopeToDiffs(files: Array<{ file: string; lineCount: number }>): FileDiff[];
// -> [{ file, addedLines: [1..lineCount], modifiedLines: [], deletedLines: 0, binary: false }]
```

`buildReport`는 손대지 않는다. "파일 전체"는 모든 줄이 `addedLines`인 FileDiff일
뿐이다. 파일 걷기(fs)는 `src/extension/scan.ts`에 두고 확장과 CLI가 공유한다.
지금 CLI가 `../extension/git`을 import하는 구조와 같다.

### 살아있는 파일을 따라간다

스냅샷이 아니다. 파일이 자라면 새 줄이 미독 상태로 나타난다. 파일이 사라지면
리포트에서 빠진다. 편집으로 내용이 바뀐 줄은 기존 ledger 해시 앵커링이 이미 증거를
떨어뜨리므로 그대로 동작한다.

### 크기 제한

폴더 하나가 5,000개 파일이면 4초마다 5,000번 stat 한다. 조용히 잘라내면 "100%
읽음"이 거짓말이 되므로, 자르지 않고 선언을 거부한다.

```
Blindspot: vendor/ has 5,213 files (limit 400).
Narrow the scope, or raise blindspot.maxScopeFiles.
```

`blindspot.maxScopeFiles` 기본 400. mtime 캐시가 있으므로 400개면 지금 큰 diff와
같은 수준의 비용이다.

### 분모의 정직성

파일 전체가 분모가 되면 빈 줄과 `}`도 "읽어야 할 것"이 된다. 이미 `readCost`가
처리한다 — `}`는 105ms면 visible 점수를 얻으므로 스크롤만 해도 대부분 자동
통과한다. 분모를 부풀리지 않는다.

---

## §3 표면

폴더만 열려 있으면 확장이 동작한다. git이 없으면 diff 기능만 비활성이고, 지금의
"git 저장소가 필요하다" 경고는 diff 계열 명령에만 남는다.

### 명령

| 명령 | 동작 |
| --- | --- |
| `Blindspot: Track This File` | 활성 에디터 파일을 스코프에 추가 |
| `Blindspot: Track This Folder` | 탐색기 우클릭 메뉴 + 팔레트(활성 파일의 폴더) |

해제는 사이드바의 인라인 버튼이 담당한다(§4). 별도 QuickPick 명령을 만들지 않는다.

기존 `Show Review Report`가 두 섹션을 보여준다 — 위가 diff, 아래가 스코프(선언됐을
때만).

### 상태표시줄

두 숫자의 방향이 반대라는 것이 이 설계에서 유일하게 위험한 지점이다.

```
diff   $(eye-closed) 36% unread     ← 안 읽은 비율 (경고)
scope  $(book) 38% read             ← 읽은 비율 (진척)
```

아이콘과 단어를 둘 다 붙인다. 숫자만 두면 62%가 좋은 건지 나쁜 건지 알 수 없다.
우선순위는 diff가 먼저다. 커밋 직전 경고가 진척 표시에 밀리면 안 되므로, 변경분이
없을 때만 스코프를 보여준다.

### 마커와 hover

한 파일은 한 리포트에만 속한다. diff에 있으면 diff, 없으면 스코프. 마커 두 세트가
같은 줄에 겹치는 일이 없다. `EvidenceHover`는 두 리포트를 순서대로 조회하게만
바꾼다.

### CLI

```bash
blindspot read <path>   # 이 파일/폴더 읽기 커버리지
blindspot read          # 선언된 스코프 전부
blindspot track <path>
blindspot untrack <path>
```

`check` / `report` / 훅은 손대지 않는다. diff 전용으로 남는다. git 없는 폴더에서
`blindspot check`는 지금처럼 "not a git repository"를 낸다. 훅은 애초에 git이
있어야 존재한다.

---

## §4 GUI

### A. 사이드바 (Activity Bar, 네이티브 TreeView)

webview가 아니다. TreeView는 테마·키보드·스크린리더 지원이 공짜로 따라온다.

```
BLINDSPOT                        [+] [↻] [⚙]
├─ Diff  ·  36% unread
│  ├─ ⚠ src/auth/session.ts      24%   26 unread
│  ├─   src/api/orders.ts        67%   20 unread
│  └─   README.md                43%   16 unread
└─ Tracked  ·  38% read
   ├─ src/core/parser.ts         38%          [x]
   └─ vendor/lib  (12 files)     61%          [x]
```

- 클릭하면 그 파일의 첫 미독 줄로 이동한다 (`Review Blindspot`과 같은 동작)
- `[x]` 인라인 버튼이 untrack이다
- 타이틀 버튼: `[+]` track this file, `[↻]` refresh, `[⚙]` 리포트 패널 열기
- 트리 하나에 최상위 그룹 둘. view를 두 개 만들지 않는다

### B. 튜닝 패널 (리포트 webview 안)

네이티브 설정으로 불가능한 부분이다. `demo/index.html`이 이미 증명했다 —
슬라이더를 움직이면 내 실제 숫자가 다시 계산된다.

```
Tuning                                    ▾

  Review threshold      ●────────  3 pts
  Focal model           [on ]
    span / decay        5 / 24 lines
  Content scaling       [on ]

  Coverage  64% → 51%     ← 미리보기, 아직 저장되지 않음
  Score     49  → 38

  [ Apply to workspace ]  [ Reset ]
```

구현은 싼 쪽을 택한다. 슬라이더가 움직이면 webview가 메시지를 보내고, 확장이 바뀐
cfg로 `buildReport`를 다시 돌려 새 리포트를 돌려준다. per-line 신호를 브라우저로
통째로 넘기지 않는다. 왕복은 수 ms고, 계산은 실제 모델 그대로다.

저장 전에는 반드시 표시한다. 튜닝 중인 숫자는 상태표시줄·훅과 다르므로 배지로
`preview — not saved`를 붙인다. 조용히 다른 숫자를 보여주는 것은 이 도구가 고치려는
실패 모드를 그대로 저지르는 일이다.

`Apply to workspace`는 `.vscode/settings.json`에 쓴다
(`ConfigurationTarget.Workspace`). 팀 전체에 강요하는 `.blindspot/config.json`은
건드리지 않는다. 그건 손으로 커밋할 일이다.

---

## 테스트 계획

기존 원칙을 그대로 따른다. 모델은 유닛 테스트, 배관은 진짜 파일시스템, `vscode`가
필요한 부분은 스텁.

**core (`test/scope.test.ts`)**

- `scopeToDiffs`가 N줄 파일을 `addedLines = [1..N]`로 만든다
- 빈 파일과 1줄 파일에서 경계가 깨지지 않는다
- 스코프 리포트를 `buildReport`에 통과시키면 risk 랭킹이 diff 때와 동일하게 동작한다

**워크스페이스 (`test/workspace.test.ts`)**

- git 저장소에서 `stateDir`이 `<gitDir>/blindspot`이다 (기존 동작 회귀 방지)
- git 아닌 폴더에서 `~/.blindspot/<hash>`이고, 같은 폴더는 항상 같은 해시다
- win32에서 대소문자만 다른 경로가 같은 해시를 낸다
- `.git`이 없으면 `git === null`이고, 그 상태로도 컨텍스트가 만들어진다

**스코프 저장 (`test/scope-store.test.ts`)**

- 선언·해제가 `scopes.json`에 왕복한다
- 깨진 `scopes.json`은 에러가 아니라 "선언 없음"으로 degrade한다 (state.json과 같은 방침)
- `maxScopeFiles`를 넘는 폴더는 조용히 잘리지 않고 거부된다

**통합 (`test/integration.test.ts` 확장)**

- 진짜 git 아닌 임시 폴더에서 `blindspot read <file>`이 커버리지를 낸다
- `blindspot track` 후 `blindspot read`가 선언된 것을 집는다
- git 없는 폴더에서 `blindspot check`는 여전히 "not a git repository"다

**확장 (`test/activation.test.ts` 확장)**

- git 아닌 폴더에서도 컨트롤러가 뜬다 (지금은 fallback으로 떨어진다)
- 그 상태에서 diff 계열 명령만 "저장소가 필요하다"고 말한다

**GUI**

- TreeView provider는 리포트 두 개를 받아 그룹 두 개를 낸다 — 순수 함수로 분리해
  스텁 없이 테스트한다
- 튜닝 메시지 왕복: cfg 오버라이드를 받은 `buildReport`가 다른 숫자를 낸다는 것은
  이미 core 테스트가 보장한다. 패널 쪽은 "저장 전 배지가 붙는다"만 확인한다

## 열린 질문

- `~/.blindspot`의 30일 prune이 스코프 선언에도 적용되어야 하나. 증거는 오래되면
  버려도 되지만 "이 폴더를 추적 중"이라는 선언은 사용자의 의도다. 일단 선언은
  prune하지 않는 쪽으로 두고, 쌓이는 게 문제가 되면 그때 다시 본다.
  **→ 해당 없음이 되었다.** 선언이 없으므로(아래) prune할 선언도 없다. 반대편인
  `ignored`(forget 목록)는 prune하지 않는다. `pruneState`가 `files`만 건드린다.
- 스코프 리포트의 Review Score를 diff와 같은 가중치로 낼 것인가. `newCode` 항목이
  스코프에서는 의미가 없다 (전부 기존 코드다). 지금 `computeScore`는 측정할 대상이
  없는 항목을 빼고 가중치를 재분배하므로 자동으로 처리될 가능성이 높지만, 구현할 때
  확인이 필요하다. **→ 그대로 동작한다.** Reading 모드에서 `newCode`는 측정 대상이
  없어 빠지고 가중치가 재분배된다 (`test/score.test.ts`).

---

## 구현 결과 — 이 설계에서 바뀐 것

**§1 WorkspaceContext: 그대로 구현됨.** `src/extension/workspace.ts`.
git 저장소면 `.git/blindspot`, 아니면 `~/.blindspot/<hash>`. 해시는 정규화된
절대경로의 sha256 앞 12자, win32 대소문자 무시. `meta.json`도 설계대로 쓴다 —
원래 폴더 경로와 마지막 기록 시각. 저장소 쪽은 `.git/blindspot`이 스스로를
설명하므로 쓰지 않는다.

**§2–§4 ReviewScope: 만들지 않았다. Reading 모드가 대신한다.**
선언(`scopes.json`, `Track This File/Folder`, `maxScopeFiles`)이 필요했던 이유는
"diff가 아닌 읽기 대상을 어떻게 정하는가"였다. Reading 모드는 그 질문에 다르게
답한다 — **연 파일이 곧 대상**이다. 선언할 것이 없고, 걸을 폴더가 없으니
`maxScopeFiles`도 없고, 5,000개 stat 문제도 생기지 않는다.

대신 반대 방향의 문제가 생긴다. 선언이 없으므로 **빼는 방법**이 필요하다. 실수로
연 vendored 파일이 분모를 삼킨다. 그것이 `forget`이다 (`BRAINSTORM.md` 5번):
`blindspot forget <path>` / `--list` / `--undo`, `Blindspot: Stop Measuring This
File`, 사이드바 인라인 휴지통. 무시 목록은 `state.json`의 `ignored`에 있다 —
설계가 `scopes.json`을 "개인 기록이므로 저장소에 들어가지 않는다"고 한 것과 같은
이유로, 같은 자리다.

| 설계 | 실제 |
| --- | --- |
| `scopes.json` 선언 목록 | 없음. 연 파일이 대상 |
| `Track This File` / `Track This Folder` | 없음. 파일을 열면 대상 |
| 사이드바 `[x]` untrack | `Blindspot: Stop Measuring This File` + 인라인 휴지통 |
| `blindspot track` / `untrack` | `blindspot forget` / `--undo` |
| `blindspot read <path>` | 그대로 |
| `maxScopeFiles` | 해당 없음 |
| 상태표시줄 두 방향 숫자 | 모드가 하나뿐이라 한 방향. `blindspot.mode`가 고른다 |
| 튜닝 패널 | 리포트 페이지의 임계값 슬라이더. `Apply to workspace`는 없다 |

**남은 것:** 튜닝 패널의 `Apply to workspace` 버튼. 페이지는 슬라이더로 미리보기를
하지만 저장은 설정에서 해야 한다. 미리보기와 저장값이 다를 수 있다는 §4의 경고는
여전히 유효하므로, 버튼을 붙일 때 `preview — not saved` 배지도 함께 붙여야 한다.

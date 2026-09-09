# 읽기 비용이 낮은 라인 모양 카탈로그

읽기 인정시간은 `readAckMs × readCost(line)` 이다. `readCost`는 토큰 수
(`baselineTokens` = 8 기준)에 **모양 할인**(`shapeDiscount`)을 곱한 값으로,
`[minReadCost, maxReadCost]` = `[0.25, 2.5]` 로 클램프된다.
기본 `readAckMs` 2000ms 기준으로 바닥은 500ms, 천장은 5s.

이 문서는 "사람이 읽지 않고 **알아보는**" 라인, 즉 눈이 한 번 스치면 내용이
확정되는 라인들을 언어별로 모은 목록이다. 원칙:

1. 모양이 내용을 결정하면 싸다. 값이 리터럴이고 이름이 전부인 줄.
2. 우변에 **호출·연산·조건**이 있으면 코드다. 버그는 거기 있으니 할인 없음.
3. 확신이 없으면 할인하지 않는다. 오탐(진짜 코드를 싸게 침)이 미탐보다 나쁘다.
4. 언어 판별 없이 정규식만으로 잡는다. 언어 특정 문법은 겹치는 모양만 채택.

할인 등급:

| 등급 | 배율 | 뜻 |
|---|---|---|
| T0 | 바닥(`minReadCost`) | 읽을 게 없다. 닫는 괄호, 빈 줄 |
| T1 | 0.3 | 단독 키워드. 한 단어가 전부 |
| T2 | 0.4 | 의존성 선언. 이름 목록만 확인 |
| T3 | 0.5 | 리터럴 대입, 상수 정의, 단순 반환 |
| T4 | 0.6 | 타입 필드, 시그니처 조각, 주석, 로그 |
| — | 1.0 | 그 외 전부 |

---

## 1. 구조 기호만 있는 줄 — T0

토큰 추정만으로 이미 바닥에 닿음. 별도 패턴 불필요.

```
}            });          ];          )           end          fi
]            })           >           <?php ?>    endif        done
```

## 2. 단독 키워드 문장 — T1

```
return;      break;       continue;    pass         else         else:
try {        finally {    default:     do {         yield        throw;
Ok(())       None         nil          null         true         false
```

주의: `return x;` `return foo();`는 여기 아님. `return <literal>`은 T3, `return <expr>`은 1.0.

## 3. 의존성 / 모듈 선언 — T2

이름 목록을 스캔할 뿐 의미를 읽지 않는다.

| 언어 | 예 |
|---|---|
| JS/TS | `import { A, B } from './x';` `import x from 'y';` `export * from './x';` `export { A, B };` `const fs = require('fs');` |
| Python | `import os` `from a.b import c, d` `import numpy as np` |
| Java/Kotlin/Scala | `import java.util.List;` `package com.foo.bar;` `import static ...` |
| C# | `using System.Linq;` `namespace Foo.Bar;` `global using ...` |
| Go | `import "fmt"` 및 `import (` 블록 안의 `"net/http"` 줄, `package main` |
| Rust | `use std::collections::HashMap;` `mod foo;` `extern crate x;` `pub use ...` |
| C/C++ | `#include <stdio.h>` `#include "foo.h"` `using namespace std;` `#pragma once` |
| Swift/ObjC | `import Foundation` `@import UIKit;` |
| Ruby | `require 'json'` `require_relative '../x'` |
| PHP | `use App\Models\User;` `namespace App;` `require_once __DIR__ . '/x.php';` |
| Dart | `import 'package:flutter/material.dart';` `part of 'x.dart';` |
| Elixir | `alias Foo.Bar` `import Ecto.Query` `use GenServer` |
| Haskell | `import qualified Data.Map as M` `module Foo where` |
| Shell | `source ./env.sh` `. ./env.sh` |
| CSS/SCSS | `@import 'base';` `@use 'sass:math';` |

**예외**: `import` 뒤에 부작용만 있는 `import './polyfill';` — 이름이 없어서 오히려
"왜 있지?"를 읽어야 한다. 할인은 하되 T3(0.5)에 그친다.

## 4. 리터럴 대입 / 상수 정의 — T3

우변이 **리터럴, 식별자(점 경로 포함), 빈 컬렉션, 인수 없는 `new X()`** 일 때만.

| 언어 | 예 |
|---|---|
| JS/TS | `const MAX = 3;` `let done = false;` `export const NAME = 'x';` `const cfg = defaults;` `static readonly X = 1;` |
| Python | `MAX_RETRIES = 3` `name = "x"` `items = []` `DEBUG: bool = False` `self.count = 0` |
| Java/C# | `private static final int MAX = 3;` `public const string Name = "x";` `var list = new List<int>();` |
| Kotlin | `val max = 3` `var name: String = ""` `const val TAG = "Main"` `private val list = mutableListOf<Int>()` |
| Go | `const max = 3` `var name string` `x := 0` `count := len(xs)` ❌(호출) |
| Rust | `let x = 5;` `let mut v = Vec::new();` `const MAX: u32 = 3;` `static NAME: &str = "x";` |
| C/C++ | `int max = 3;` `static const char* name = "x";` `bool done = false;` `#define MAX 3` |
| Swift | `let max = 3` `var name = ""` `static let shared = Foo()` |
| Ruby | `MAX = 3` `@count = 0` `attr_reader :name, :age` |
| PHP | `$max = 3;` `const MAX = 3;` `private $name = '';` `public int $count = 0;` |
| Shell | `MAX=3` `NAME="x"` `export PATH="$PATH:/x"` |

"인수 없는 생성자"만 허용하는 이유: `new Foo(a, b)`부터는 무엇을 넘기는지가 내용이다.
`Vec::new()` `mutableListOf<Int>()` `[]` `{}` `dict()` `set()` `HashMap::new()`는 빈
컬렉션으로 취급.

### 4a. 단순 반환 — T3

```
return 0;       return null;     return this;     return self       return true
return name;    return _name;    return x         Ok(x)            Some(x)
```

`return a + b;` `return foo();` `return x ? a : b;`는 1.0.

### 4b. 단순 위임 / getter — T3

한 줄이 다른 한 이름을 그대로 넘기는 경우.

```
get name() { return this._name; }        def name(self): return self._name
public String getName() { return name; } fun getName() = name
this.foo = foo;                          self.foo = foo
```

`this.foo = foo;`류 생성자 필드 대입은 Java/TS/Python 생성자에서 수십 줄씩 나오며
가장 흔한 "읽지 않고 훑는" 줄이다.

## 5. 타입 정의의 필드 / 시그니처 조각 — T4

| 언어 | 예 |
|---|---|
| TS | `name: string;` `readonly id?: number;` `onChange: (v: string) => void;` |
| Python | `name: str` `age: int = 0` (dataclass/TypedDict/Pydantic 필드) |
| Go | `Name string \`json:"name"\`` `Age int` (struct 필드) |
| Rust | `pub name: String,` `age: u32,` (struct 필드), `Foo(u32),` (enum variant) |
| Java/Kotlin | `private String name;` `val name: String,` (data class 파라미터) |
| C/C++ | `int count;` `char* name;` (struct 멤버) |
| Swift | `let name: String` `var age: Int` (struct 멤버) |
| GraphQL/Proto | `name: String!` `string name = 1;` |
| SQL DDL | `name VARCHAR(255) NOT NULL,` `id SERIAL PRIMARY KEY,` |

enum 멤버 (`Red,` `RED = 'red',` `Active = 1,`) 도 여기.

주의: 함수 시그니처 자체 (`function foo(a: A, b: B): C {`) 는 **할인 없음** — 인자
순서와 타입이 리뷰 대상.

## 6. 주석 / 문서 — T4

```
// ...         /* ... */       * ...(JSDoc 본문)     # ...         """ ... """
/// ...        //! ...         -- ...(SQL/Haskell)   <!-- ... -->  % ...(LaTeX)
```

**할인하지 않는 주석**: `TODO` `FIXME` `HACK` `XXX` `SAFETY:` `eslint-disable`
`@ts-ignore` `noqa` `#pragma` `unsafe` 가 포함된 줄. 이건 경고문이라 읽어야 한다.
전처리기 `#if/#ifdef/#define/#include` 는 주석이 아니다.

## 7. 로깅 / 출력 / 디버그 — T4

문자열 리터럴 인수만 있을 때.

```
console.log('starting');        logger.info("x")        print("done")
log.Printf("x")                 println!("x");          fmt.Println("x")
System.out.println("x");        Log.d(TAG, "x")         echo "x"
```

포맷 인수가 붙는 순간 (`log.info("user %s", user.id)`) 1.0 — 어떤 값이 새는지가
보안 이슈다. 특히 `password` `token` `secret` 이 인수에 보이면 risk 규칙이 잡는다.

## 8. 데코레이터 / 어노테이션 / 속성 — 인수 없을 때 T3

```
@Override        @Injectable()      @dataclass        #[derive(Debug, Clone)]
@Test            @staticmethod      [Fact]            @objc
'use strict';    #!/usr/bin/env bash                  <?php
```

`@Column(name = "user_id", nullable = false)` 처럼 인수가 있으면 1.0.

## 9. 테스트 골격 — T3

```
describe('Foo', () => {      it('works', () => {       test_foo(self):
beforeEach(() => {           afterAll(async () => {    @pytest.fixture
#[test]                      func TestFoo(t *testing.T) {
```

설명 문자열은 읽지만 구조는 읽지 않는다. `expect(...)` `assert ...` 본문은 1.0.

## 10. 마크업 / 설정 — 언어별

| 종류 | 싼 줄 (T3) | 비싼 줄 (1.0) |
|---|---|---|
| JSON/YAML/TOML | `"name": "x",` `enabled: true` `[section]` `- item` | `env: ${{ secrets.X }}` `command: \| ...` 스크립트 블록 |
| HTML/JSX | `<div>` `</div>` `<br />` `<Foo />` | `onClick={...}` `dangerouslySetInnerHTML` `href={url}` |
| CSS | `display: flex;` `margin: 0;` `}` | `calc(...)` `var(--x, fallback)` `@media (...)` |
| SQL | `SELECT` `FROM users` `ORDER BY id` | `WHERE ...` `JOIN ... ON ...` `DELETE` `UPDATE ... SET` |
| Dockerfile | `FROM node:20` `WORKDIR /app` `EXPOSE 3000` | `RUN ...` `COPY --from=...` `ENTRYPOINT [...]` |
| Makefile | `.PHONY: all` 타깃 헤더 `all:` | 레시피 줄 |
| Shell | `set -e` `cd dir` `mkdir -p x` | 파이프, `rm -rf`, `eval`, `curl \| sh` |

## 11. 절대 할인하지 않는 것 (트랩 목록)

모양은 단순해 보여도 반드시 읽어야 하는 줄. `shapeDiscount` 패턴은 이것들을
통과시키면 안 되고, 테스트로 고정한다.

| 모양 | 왜 |
|---|---|
| `x = y` 인데 `y`가 `secret` `token` `password` `key` 를 포함 | 자격증명 흐름. risk 규칙과 겹침 |
| `const x = a \|\| b;` `?? ` `? :` | 기본값·분기 — 논리 |
| `x == y` `x === y` `!x` 를 포함한 대입 | 조건 |
| `if (...)` `while (...)` `for (...)` `match` `switch` `case X:` | 제어 흐름 전부 |
| `a.b = c.d;` 에서 좌변이 `this`/`self`가 아닌 외부 객체 | 상태 변조 |
| `delete` `drop` `rm` `unlink` `truncate` `kill` 을 포함하는 짧은 줄 | 파괴적 |
| `await x` `x.then(` `go f()` `spawn` `Thread` `lock` `mutex` | 동시성 |
| `unsafe` `@ts-ignore` `as any` `# type: ignore` `noqa` `eslint-disable` | 검사 회피 |
| `catch {}` `except: pass` `rescue nil` `_ = err` | 삼킨 에러 |
| `return x;` 인데 함수가 boolean 권한 검사 (`canX`, `isAllowed`) | 한 글자가 권한 |
| `export default` 한 줄짜리 `export default foo;` | 무엇이 공개되는지 |
| 숫자 리터럴이 `0` `1` `-1` `""` 이 아닌 매직 넘버 `const TIMEOUT = 300000;` | 단위·크기 오류. T3 유지하되 T2 이하로 내리지 않음 |

## 12. 현재 구현 — 전부 반영됨

`src/core/attention.ts`가 이 목록을 `TRAPS` → 파일 확장자 테이블 → `DISCOUNTS`
순으로 적용한다. 순서가 곧 원칙 3이다: 트랩이 먼저 이기고, 애매하면 할인하지 않는다.

| 항목 | 상태 |
| --- | --- |
| §2 단독 키워드 (`fi` `done` `esac` 등 포함) | T1 |
| §3 의존성 선언 (JS/TS·Python·Java·C#·Go·Rust·Ruby·PHP·Dart·Elixir·Haskell·Shell·CSS·C) | T2, `const x = require(...)` 포함 |
| §3 예외: 이름을 묶지 않는 side-effect import | T3 (일반 import 규칙보다 **먼저** 검사) |
| §4 리터럴·식별자·`new X()` 대입, 키워드 없는 형태(`MAX = 3`, `$max = 3`, `x := 0`) | T3 |
| §4a `return <literal\|identifier>` , `Ok(x)` `Some(x)` | T3 |
| §4b `this.x = x` `self.x = x`, 한 줄 getter/위임 | T3 |
| §5 TS/Kotlin 필드, Go struct 필드(태그 포함), Rust `pub name: String,`, C 멤버, enum 멤버 | T4 |
| §6 주석 | T4, **경고 주석(TODO/FIXME/HACK/XXX/SAFETY/@ts-ignore/eslint-disable/noqa/type: ignore)은 할인 없음** |
| §7 문자열 인수만 있는 로그 | T4 |
| §8 인수 없는 데코레이터·어노테이션·속성, 파일 서두 한 줄 | T3 |
| §9 테스트 골격 (`describe`/`it`/`beforeEach`/`#[test]`/`func TestX`/`@pytest.fixture`) | T3 |
| §10 마크업/설정 (JSON·YAML·TOML·CSS·SQL·Dockerfile·Makefile·HTML/JSX) | T3, 확장자별 테이블 + 각 테이블의 "비싼 줄"을 자체 트랩으로 |
| §11 트랩 목록 전부 | 할인 없음 |

§10은 파일 경로를 알아야 성립하므로 `readCost(text, cfg, file?)` /
`evaluate(ev, cfg, lineText?, file?)`에 선택 인자를 더했다. 인자가 없으면 예전과
똑같이 동작하므로 기존 호출부는 그대로다. 리포트는 `coverage.ts`가, hover는
`hover.ts`가 경로를 넘긴다.

### 구현하면서 좁힌 것

트랩이 통과시킨 세 줄을 테스트가 잡았고, 스펙의 지시대로 패턴을 고쳤다.

- `const fs = require('fs');` — §3인데 §4 대입 규칙에도 걸리지 않아 할인이 없었다.
  import 행에 묶는 형태를 추가.
- `let session = null;` — `session`이 트랩 목록에 없었다. `risk.ts`는 session
  코드를 critical로 치므로 두 모델이 어긋나 있었다. 자격증명 트랩에 `session`과
  `cookie`를 넣어 맞췄다.
- `// @ts-ignore` — `\b(?:…|@ts-ignore)\b`는 절대 매칭되지 않는다. `@` 앞에는
  단어 경계가 없기 때문. 비단어로 시작하는 마커는 그룹 밖으로 뺐다.

각 항목은 `test/attention.test.ts`의 `shape discounts`에 "싸야 하는 줄"과 "싸면 안
되는 줄"을 쌍으로 갖는다. 트랩이 하나라도 통과하면 그 패턴을 좁힌다 — 테스트를
지우지 않는다.

## 13. 참고: 근거

- 코드 읽기 eye-tracking (Busjahn et al. 2015, Peachock et al. 2017): 고정
  횟수는 라인 수가 아니라 토큰·식별자 수를 따르고, import/선언 블록에서는
  선형 스캔이 아니라 건너뛰기 패턴이 관찰됨.
- Google 코드리뷰 가이드 / SmartBear "Best Kept Secrets of Peer Code Review":
  리뷰어는 결함을 로직·조건·경계에서 찾고 선언부는 훑는다. 시간당 300~500 LOC
  가 상한이며 그 이상은 결함 발견율이 급락 — 이 도구의 `attentionLines` = 2줄/초
  상한 (7200 LOC/h)이 여전히 관대하다는 뜻이기도 하다.

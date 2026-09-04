import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import {
  attentionNorm,
  attentionShare,
  focalWeight,
  focusLine,
  readCost,
  shapeDiscount,
} from '../src/core/attention';
import { LineLedger } from '../src/core/ledger';
import { evaluate } from '../src/core/evidence';

const cfg = DEFAULT_CONFIG;
const NOW = 1_700_000_000_000;

/**
 * The claim these tests defend: without an eye tracker, a viewport is not a
 * reading record. A tall editor showing 80 lines cannot have been read at the
 * same rate as the 10 lines around the caret, and a model that says otherwise
 * reports coverage that was never earned.
 */
describe('focal weighting', () => {
  test('the perceptual span around the focus gets full credit', () => {
    assert.equal(focalWeight(100, 100, cfg), 1);
    assert.equal(focalWeight(100 + cfg.focalSpanLines, 100, cfg), 1);
  });

  test('credit decays with distance and never reaches zero', () => {
    const near = focalWeight(105, 100, cfg);
    const far = focalWeight(140, 100, cfg);
    assert.equal(near > far, true);
    assert.equal(Math.abs(far - cfg.peripheralFloor) < 1e-9, true);
    assert.equal(far > 0, true);
  });

  test('it is symmetric — code above the caret is not privileged', () => {
    assert.equal(focalWeight(80, 100, cfg), focalWeight(120, 100, cfg));
  });

  test('turning the model off restores the flat viewport', () => {
    const flat = { ...cfg, focalModel: false };
    assert.equal(focalWeight(1, 500, flat), 1);
  });

  test('a tall viewport no longer reports its edges as read', () => {
    // 60 lines on screen, caret at the top, held still for 12 seconds.
    const focus = { line: 1, norm: attentionNorm([[1, 60]], 1, cfg), cfg };
    const ledger = new LineLedger();
    ledger.resize(60);
    for (let i = 0; i < 48; i++) ledger.addVisible(1, 60, 250, true, NOW + i * 250, focus);
    ledger.addDwell(1, 60, NOW + 12000, focus);

    assert.equal(evaluate(ledger.at(1), cfg).reviewed, true);
    assert.equal(evaluate(ledger.at(60), cfg).reviewed, false);
    // ...and the flat model would have called the bottom line read too.
    const flatLedger = new LineLedger();
    flatLedger.resize(60);
    for (let i = 0; i < 48; i++) flatLedger.addVisible(1, 60, 250, true, NOW + i * 250);
    flatLedger.addDwell(1, 60, NOW + 12000);
    assert.equal(evaluate(flatLedger.at(60), cfg).reviewed, true);
  });

  test('attention is conserved: a tick buys attentionLines seconds of reading, not one per line', () => {
    const focus = { line: 20, norm: attentionNorm([[1, 60]], 20, cfg), cfg };
    const ledger = new LineLedger();
    ledger.resize(60);
    ledger.addVisible(1, 60, 1000, true, NOW, focus);
    let total = 0;
    for (let l = 1; l <= 60; l++) total += ledger.at(l).focusedMs;
    assert.equal(Math.abs(total - 1000 * cfg.attentionLines) < 1e-6, true);
    assert.equal(Math.abs(ledger.at(60).visibleMs - 1000 * cfg.peripheralFloor) < 1e-6, true);
    // Exposure is not budgeted: every line really was on screen for a second.
    assert.equal(ledger.at(20).visibleMs, 1000);
  });

  test('a static screen of 40 lines cannot be read in 20 seconds', () => {
    const focus = { line: 1, norm: attentionNorm([[1, 40]], 1, cfg), cfg };
    const ledger = new LineLedger();
    ledger.resize(40);
    for (let i = 0; i < 80; i++) ledger.addVisible(1, 40, 250, true, NOW + i * 250, focus);
    ledger.addDwell(1, 40, NOW + 20000, focus);
    let read = 0;
    for (let l = 1; l <= 40; l++) if (evaluate(ledger.at(l), cfg).reviewed) read += 1;
    // Throughput is capped at attentionLines per second, so 20 s buys at most
    // 40 line-seconds: a handful of lines around the caret, never the screen.
    assert.equal(read >= 5 && read <= 10, true, `${read} lines read after 20 s of staring at line 1`);
    assert.equal(attentionShare(40, focus) < 0.02, true);
  });
});

describe('focus line', () => {
  test('the caret is the focus when it is on screen', () => {
    assert.equal(focusLine(42, 20, 60), 42);
  });

  test('the viewport centre is the fallback when the caret is scrolled away', () => {
    assert.equal(focusLine(5, 100, 140), 120);
  });
});

describe('read cost', () => {
  test('a blank line is cheap and a dense line is expensive', () => {
    assert.equal(readCost('', cfg), cfg.minReadCost);
    assert.equal(readCost('  }', cfg), cfg.minReadCost);
    assert.equal(readCost('const x = 1;', cfg) < 1, true);
    assert.equal(
      readCost('const totals = rows.reduce((acc, row) => acc + row.amount * row.qty, 0);', cfg) > 1,
      true,
    );
  });

  test('boilerplate you recognise on sight is cheaper than code you must read', () => {
    const full = readCost('const total = rows.reduce((a, r) => a + r.qty, 0);', cfg);
    assert.equal(readCost("import { Foo, Bar, Baz } from './foo';", cfg) < full / 2, true);
    assert.equal(readCost('const MAX_RETRIES = 3;', cfg) < readCost('const retries = compute(3);', cfg), true);
    assert.equal(readCost('  readonly name: string;', cfg) < 0.5, true);
    assert.equal(readCost('// keep in sync with the server', cfg) < readCost('keep in sync with the server', cfg), true);
    assert.equal(readCost('return;', cfg), cfg.minReadCost);
    // A declaration whose value is a call is real code: no discount.
    assert.equal(shapeDiscount('const token = sign(payload, secret);'), 1);
    assert.equal(shapeDiscount('const x = a ? b : c;'), 1);
    assert.equal(shapeDiscount('if (user.role === "admin") {'), 1);
  });

  test('cost is clamped, so one pathological line cannot dominate', () => {
    const huge = 'a'.repeat(50).split('').join(' + ');
    assert.equal(readCost(huge, cfg) <= cfg.maxReadCost, true);
  });

  test('turning content scaling off restores one threshold for every line', () => {
    const flat = { ...cfg, contentScaling: false };
    assert.equal(readCost('}', flat), 1);
    assert.equal(readCost('a'.repeat(300), flat), 1);
  });
});

/**
 * The catalogue in
 * `docs/superpowers/specs/2026-09-03-low-read-cost-line-shapes.md`, as tests.
 *
 * Every entry is a pair: a line whose shape really does say what it contains,
 * and a line of the same shape that hides something. The second half is the
 * half that matters. A pattern that discounts a trap is a pattern that tells
 * somebody they read a line they skimmed, so if one gets through, the fix is
 * to narrow the pattern, never to delete the test.
 */
describe('shape discounts', () => {
  const cheap = (line: string, file?: string) =>
    assert.equal(shapeDiscount(line, file) < 1, true, `expected a discount: ${line}`);
  const full = (line: string, file?: string) =>
    assert.equal(shapeDiscount(line, file), 1, `expected full price: ${line}`);

  test('dependency declarations are scanned, not read', () => {
    for (const line of [
      "import { A, B } from './x';",
      "import x from 'y';",
      "export * from './x';",
      "const fs = require('fs');",
      'import os',
      'from a.b import c, d',
      'import java.util.List;',
      'package com.foo.bar;',
      'using System.Linq;',
      'use std::collections::HashMap;',
      'mod foo;',
      'pub use crate::core::Ledger;',
      '#include <stdio.h>',
      '#pragma once',
      "require 'json'",
      "require_relative '../x'",
      'namespace App;',
      "import 'package:flutter/material.dart';",
      'alias Foo.Bar',
      'module Foo where',
      "@import 'base';",
    ]) {
      cheap(line);
    }
    // An import with no names is a side effect: discounted, but less.
    assert.equal(shapeDiscount("import './polyfill';"), 0.5);
    // An import of anything credential-shaped is read, not scanned.
    full("import { signToken } from './auth';");
  });

  test('a lone keyword is one word to recognise', () => {
    for (const line of ['return;', 'break;', 'continue;', 'pass', 'else', 'try {', 'finally {', 'done', 'fi', 'None', 'nil']) {
      cheap(line);
    }
    full('return computeTotal();');
    full('else if (x > 3) {');
  });

  test('a literal assignment is cheap; anything computed is not', () => {
    for (const line of [
      'const MAX = 3;',
      'let done = false;',
      "export const NAME = 'x';',".slice(0, -2),
      'MAX_RETRIES = 3',
      'items = []',
      'val max = 3',
      'const max = 3',
      'let mut v = Vec::new();',
      'int max = 3;',
      '$max = 3;',
      'var name string',
      'private String name;',
    ]) {
      cheap(line);
    }
    for (const line of [
      'const token = sign(payload, secret);',
      'const x = a ? b : c;',
      'const retries = compute(3);',
      'const timeout = base || 5000;',
      'const ok = a === b;',
      'config.retries = 3;',
      'const apiKey = "sk-live-1234";',
      'let session = null;',
    ]) {
      full(line);
    }
  });

  test('delegation and a simple return are the shapes reviewers skim most', () => {
    for (const line of [
      'this.foo = foo;',
      'self.foo = foo',
      'get name() { return this._name; }',
      'public String getName() { return name; }',
      'fun getName() = name',
      'def name(self): return self._name',
      'return 0;',
      'return null;',
      'return this;',
      'return true',
      'return name;',
      'Ok(value)',
      'Some(x)',
    ]) {
      cheap(line);
    }
    for (const line of [
      'return a + b;',
      'return foo();',
      'return x ? a : b;',
      // One word decides an access rule.
      'return canEdit;',
      'return isAllowed;',
      'this.token = token;',
    ]) {
      full(line);
    }
  });

  test('type fields and enum members are a name and a type', () => {
    for (const line of [
      'name: string;',
      'readonly id?: number;',
      'name: str',
      'Name string',
      'Age int',
      'Name string `json:"name"`',
      'pub name: String,',
      'age: u32,',
      'int count;',
      'char* name;',
      'Red,',
      "RED = 'red',",
      'Active = 1,',
      'Foo(u32),',
    ]) {
      cheap(line);
    }
    // A signature is not a field: argument order and types are the review.
    full('function foo(a: A, b: B): C {');
    full('onChange: (v: string) => void | null;');
  });

  test('a comment is prose, and a warning comment is an instruction', () => {
    for (const line of [
      '// keep in sync with the server',
      '/* a block */',
      '* a doc line',
      '# a python comment',
      '-- a sql comment',
      '<!-- markup -->',
      '/// a rust doc',
    ]) {
      cheap(line);
    }
    for (const line of [
      '// TODO: handle the empty case',
      '// FIXME this leaks',
      '// HACK: works by accident',
      '// XXX do not ship',
      '// SAFETY: the pointer outlives the borrow',
      '// eslint-disable-next-line no-eval',
      '// @ts-ignore',
      '# noqa: E501',
      '# type: ignore',
    ]) {
      full(line);
    }
  });

  test('a log of a constant string is cheap; a log of a value is not', () => {
    for (const line of [
      "console.log('starting')",
      'logger.info("x")',
      'print("done")',
      'log.Printf("x")',
      'println!("x");',
      'fmt.Println("x")',
      'System.out.println("x");',
      'Log.d(TAG, "x")',
      'echo "x"',
    ]) {
      cheap(line);
    }
    for (const line of [
      'log.info("user %s", user.id)',
      'console.log(user.password)',
      'logger.debug(`token: ${token}`)',
    ]) {
      full(line);
    }
  });

  test('an annotation without arguments carries no configuration', () => {
    for (const line of ['@Override', '@Injectable()', '@dataclass', '#[derive(Debug, Clone)]', '@Test', '@staticmethod', '[Fact]', "'use strict';"]) {
      cheap(line);
    }
    full('@Column(name = "user_id", nullable = false)');
    full('#[allow(dead_code)]');
  });

  test('a test skeleton is structure; its body is not', () => {
    for (const line of [
      "describe('Foo', () => {",
      "it('works', () => {",
      'beforeEach(() => {',
      '#[test]',
      'func TestFoo(t *testing.T) {',
      '@pytest.fixture',
    ]) {
      cheap(line);
    }
    full("expect(result).toEqual({ ok: true });");
    full('assert.equal(readCost(x, cfg), 1);');
  });

  test('markup and config shapes need to know what file they are in', () => {
    // The same text is a keyword in one file and a string in another.
    cheap('"name": "x",', 'package.json');
    full('"name": "x",');
    cheap('enabled: true', 'config.yaml');
    cheap('display: flex;', 'a.css');
    cheap('FROM node:20', 'Dockerfile');
    cheap('FROM users', 'q.sql');
    cheap('<div>', 'App.tsx');
    cheap('.PHONY: all', 'Makefile');

    // Each table's expensive column.
    full('env: ${{ secrets.GITHUB_TOKEN }}', 'ci.yaml');
    full('width: calc(100% - 2rem);', 'a.css');
    full('WHERE id = $1', 'q.sql');
    full('RUN npm ci && npm test', 'Dockerfile');
    full('onClick={handleClick}', 'App.tsx');
    full('\tgo build ./...', 'Makefile');
  });

  test('the read cost of a whole boilerplate block is a fraction of real code', () => {
    const real = readCost('const totals = rows.reduce((a, r) => a + r.amount * r.qty, 0);', cfg);
    for (const line of ['import { Foo } from "./foo";', 'this.name = name;', 'return null;', 'name: string;']) {
      assert.equal(readCost(line, cfg) < real / 2, true, `${line} should cost far less than real code`);
    }
  });
});

describe('re-reading', () => {
  test('returning after a gap is a new viewing episode', () => {
    const ledger = new LineLedger();
    ledger.resize(3);
    const focus = { line: 2, norm: attentionNorm([[1, 3]], 2, cfg), cfg };
    ledger.addVisible(1, 3, 1000, true, NOW, focus);
    assert.equal(ledger.at(2).revisits, 0);

    ledger.addVisible(1, 3, 1000, true, NOW + cfg.revisitGapMs + 1, focus);
    assert.equal(ledger.at(2).revisits, 1);
  });

  test('staying on the line is not re-reading it', () => {
    const ledger = new LineLedger();
    ledger.resize(3);
    const focus = { line: 2, norm: attentionNorm([[1, 3]], 2, cfg), cfg };
    for (let i = 0; i < 40; i++) ledger.addVisible(1, 3, 250, true, NOW + i * 250, focus);
    assert.equal(ledger.at(2).revisits, 0);
  });
});

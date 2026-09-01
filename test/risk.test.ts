import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/config';
import { classifyContent, classifyLine, classifyPath, isSevere, maxRisk } from '../src/core/risk';

const cfg = DEFAULT_CONFIG;

describe('classifyPath', () => {
  test('auth and session code is critical', () => {
    assert.equal(classifyPath('src/auth/session.ts', cfg).level, 'critical');
    assert.equal(classifyPath('app/authentication.ts', cfg).level, 'critical');
  });

  test('money and migrations are critical', () => {
    assert.equal(classifyPath('server/billing/charge.ts', cfg).level, 'critical');
    assert.equal(classifyPath('db/migrations/0004_add_column.sql', cfg).level, 'critical');
  });

  test('infrastructure and access control are high', () => {
    assert.equal(classifyPath('.github/workflows/deploy.yml', cfg).level, 'high');
    assert.equal(classifyPath('src/middleware/rbac.ts', cfg).level, 'high');
  });

  test('docs, tests and lockfiles are low', () => {
    assert.equal(classifyPath('README.md', cfg).level, 'low');
    assert.equal(classifyPath('package-lock.json', cfg).level, 'low');
    assert.equal(classifyPath('src/__tests__/app.test.ts', cfg).level, 'low');
  });

  test('ordinary application code is medium', () => {
    assert.equal(classifyPath('src/widgets/list.ts', cfg).level, 'medium');
  });
});

describe('classifyContent', () => {
  test('dynamic execution and destructive SQL are critical', () => {
    assert.equal(classifyContent('const r = eval(userInput)', cfg)?.level, 'critical');
    assert.equal(classifyContent('await db.query("DROP TABLE users")', cfg)?.level, 'critical');
  });

  test('secrets access and raw HTML are high', () => {
    assert.equal(classifyContent('const key = process.env.STRIPE_KEY', cfg)?.level, 'high');
    assert.equal(classifyContent('el.innerHTML = value', cfg)?.level, 'high');
  });

  test('plain code matches nothing', () => {
    assert.equal(classifyContent('const total = a + b', cfg), null);
  });

  test('blank lines are low', () => {
    assert.equal(classifyContent('   ', cfg)?.level, 'low');
  });
});

describe('classifyLine', () => {
  test('a scary line in a scary file stays critical', () => {
    const v = classifyLine('src/auth/token.ts', 'const secret = process.env.JWT_SECRET', cfg);
    assert.equal(v.level, 'critical');
  });

  test('a scary line in an ordinary file is promoted', () => {
    const v = classifyLine('src/util/run.ts', 'child_process.execSync(cmd)', cfg);
    assert.equal(v.level, 'critical');
    assert.equal(v.reason, 'dynamic code execution');
  });

  test('a low-risk path caps the risk of its content', () => {
    // A code sample inside documentation is documentation.
    const v = classifyLine('docs/guide.md', '  child_process.execSync(cmd)', cfg);
    assert.equal(v.level, 'low');
  });

  test('an ordinary line in a critical file inherits the file risk', () => {
    const v = classifyLine('src/auth/session.ts', 'const now = Date.now()', cfg);
    assert.equal(v.level, 'critical');
  });

  test('a comment in a critical file is demoted, not inherited', () => {
    // You cannot ship an auth bug in a comment, so reading the comment above a
    // secret must not score the same as reading the secret.
    const comment = classifyLine('src/auth/session.ts', '// refresh the token here', cfg);
    const code = classifyLine('src/auth/session.ts', 'const token = sign(payload)', cfg);
    assert.equal(code.level, 'critical');
    assert.equal(comment.level, 'high');
    assert.match(comment.reason, /comment/);
  });

  test('a blank line is demoted the same way', () => {
    assert.equal(classifyLine('src/auth/session.ts', '   ', cfg).level, 'high');
    assert.equal(classifyLine('src/widgets/list.ts', '', cfg).level, 'low');
  });
});

describe('risk helpers', () => {
  test('severity covers critical and high only', () => {
    assert.equal(isSevere('critical'), true);
    assert.equal(isSevere('high'), true);
    assert.equal(isSevere('medium'), false);
    assert.equal(isSevere('low'), false);
  });

  test('maxRisk picks the worst level present', () => {
    assert.equal(maxRisk(['low', 'medium', 'high']), 'high');
    assert.equal(maxRisk([]), 'low');
    assert.equal(maxRisk(['medium', 'critical', 'low']), 'critical');
  });
});

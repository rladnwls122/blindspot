import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDiffs, parseUnifiedDiff } from '../src/core/diff';

describe('parseUnifiedDiff', () => {
  test('reads added line numbers from the new file', () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -12,0 +13,3 @@
+const a = 1;
+const b = 2;
+const c = 3;
`;
    const [file] = parseUnifiedDiff(diff);
    assert.equal(file.file, 'src/app.ts');
    assert.deepEqual(file.addedLines, [13, 14, 15]);
    assert.deepEqual(file.modifiedLines, []);
    assert.equal(file.deletedLines, 0);
  });

  test('marks replaced lines as modified rather than new', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -5,2 +5,2 @@
-old one
-old two
+new one
+new two
`;
    const [file] = parseUnifiedDiff(diff);
    assert.deepEqual(file.addedLines, [5, 6]);
    assert.deepEqual(file.modifiedLines, [5, 6]);
    assert.equal(file.deletedLines, 2);
  });

  test('handles several hunks in one file', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,0 +2,1 @@
+first
@@ -40,0 +42,2 @@
+second
+third
`;
    const [file] = parseUnifiedDiff(diff);
    assert.deepEqual(file.addedLines, [2, 42, 43]);
  });

  test('handles several files', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,0 +1,1 @@
+alpha
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -9,0 +10,1 @@
+beta
`;
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 2);
    assert.deepEqual(files.map((f) => f.file), ['a.ts', 'b.ts']);
    assert.deepEqual(files[1].addedLines, [10]);
  });

  test('records a pure deletion without inventing added lines', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,2 +2,0 @@
-gone
-also gone
`;
    const [file] = parseUnifiedDiff(diff);
    assert.deepEqual(file.addedLines, []);
    assert.equal(file.deletedLines, 2);
  });

  test('flags binary files instead of guessing at lines', () => {
    const diff = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const [file] = parseUnifiedDiff(diff);
    assert.equal(file.binary, true);
    assert.deepEqual(file.addedLines, []);
  });

  test('follows a rename to the new path', () => {
    const diff = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,0 +2,1 @@
+added after rename
`;
    const [file] = parseUnifiedDiff(diff);
    assert.equal(file.file, 'new/name.ts');
    assert.deepEqual(file.addedLines, [2]);
  });

  test('a new file is entirely added lines', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    const [file] = parseUnifiedDiff(diff);
    assert.equal(file.file, 'new.ts');
    assert.deepEqual(file.addedLines, [1, 2, 3]);
  });

  test('ignores the "no newline at end of file" marker', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old
+new
\\ No newline at end of file
`;
    const [file] = parseUnifiedDiff(diff);
    assert.deepEqual(file.addedLines, [1]);
  });

  test('returns nothing for an empty diff', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
  });
});

describe('mergeDiffs', () => {
  test('unions staged and unstaged changes without double counting', () => {
    const a = [{ file: 'a.ts', addedLines: [1, 2], modifiedLines: [1], deletedLines: 1, binary: false }];
    const b = [{ file: 'a.ts', addedLines: [2, 3], modifiedLines: [], deletedLines: 2, binary: false }];
    const [merged] = mergeDiffs(a, b);
    assert.deepEqual(merged.addedLines, [1, 2, 3]);
    assert.deepEqual(merged.modifiedLines, [1]);
    assert.equal(merged.deletedLines, 3);
  });

  test('keeps files that appear on only one side', () => {
    const merged = mergeDiffs(
      [{ file: 'a.ts', addedLines: [1], modifiedLines: [], deletedLines: 0, binary: false }],
      [{ file: 'b.ts', addedLines: [1], modifiedLines: [], deletedLines: 0, binary: false }],
    );
    assert.deepEqual(merged.map((f) => f.file).sort(), ['a.ts', 'b.ts']);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inspectProjectTarget } from "../lib/safe-path.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-safe-path-"));
}

test("安全路径：真正越界才拒绝，项目内以两个点开头的名字仍允许", () => {
  const root = tmp();
  assert.equal(inspectProjectTarget(root, "../outside.txt").safe, false);
  assert.equal(inspectProjectTarget(root, path.join(os.tmpdir(), "outside.txt")).safe, false);
  assert.equal(inspectProjectTarget(root, "..config/settings.json").safe, true);
  assert.equal(inspectProjectTarget(root, "..foo/file.txt").safe, true);
});

test("安全路径：上级软链、断链都不能把写入带出项目；叶子软链交给调用方拒绝", (t) => {
  const root = tmp();
  const outside = tmp();
  try {
    fs.symlinkSync(outside, path.join(root, "linked"));
    fs.symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"));
    fs.symlinkSync(path.join(outside, "leaf.txt"), path.join(root, "leaf.txt"));
  } catch {
    t.skip("当前平台不允许创建软链");
    return;
  }

  assert.equal(inspectProjectTarget(root, "linked/file.txt").safe, false);
  assert.equal(inspectProjectTarget(root, "dangling/file.txt").safe, false);
  const leaf = inspectProjectTarget(root, "leaf.txt");
  assert.equal(leaf.safe, true);
  assert.equal(leaf.stat?.isSymbolicLink(), true);
});

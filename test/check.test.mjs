import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCheck } from "../lib/commands/check.mjs";
import { runInit } from "../lib/commands/init.mjs";

function capture(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { code: fn(), output: lines.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

function initializedProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-check-"));
  capture(() => runInit(dir));
  return dir;
}

test("check：刚初始化只有地基时不再暗示产品已经做好", () => {
  const dir = initializedProject();
  const result = capture(() => runCheck(dir));

  assert.equal(result.code, 0);
  assert.match(result.output, /协作地基通过/);
  assert.match(result.output, /还没有可验收的产品页面或功能/);
  assert.match(result.output, /不代表产品功能已经验收/);
});

test("check：失败时给老板一句可直接交给 AI 的话", () => {
  const dir = initializedProject();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# 另一份规则\n");
  const result = capture(() => runCheck(dir));

  assert.equal(result.code, 1);
  assert.match(result.output, /把 BossCoding 自检修到全绿/);
  assert.match(result.output, /npx bosscoding check/);
});

test("check：在仓库子目录运行时拒绝假装检查了整个项目", () => {
  const dir = initializedProject();
  const nested = path.join(dir, "src");
  fs.mkdirSync(nested);
  const result = capture(() => runCheck(nested));

  assert.equal(result.code, 1);
  assert.match(result.output, /子文件夹/);
  assert.match(result.output, /最顶层目录/);
});

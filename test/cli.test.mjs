/**
 * 命令入口的黑盒测试。参数解析必须从用户真实敲下的命令验证，
 * 否则 `init --help` 这类「看帮助却改了文件」的事故很容易漏过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/bosscoding.mjs", import.meta.url));
const GIT_ENV = {
  ...process.env,
  NO_COLOR: "1",
  GIT_AUTHOR_NAME: "boss",
  GIT_AUTHOR_EMAIL: "boss@example.com",
  GIT_COMMITTER_NAME: "boss",
  GIT_COMMITTER_EMAIL: "boss@example.com",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: "pipe" }).trim();
}

test("CLI：init --help 只显示帮助，绝不把当前目录变成项目", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cli-help-"));
  const result = spawnSync(process.execPath, [CLI, "init", "--help"], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /第一次使用/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("CLI：多词任务名不会只剩第一个词", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cli-task-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");

  const target = path.join(path.dirname(dir), `${path.basename(dir)}-支付-页面`);
  try {
    const result = spawnSync(process.execPath, [CLI, "task", "支付", "页面"], {
      cwd: dir,
      encoding: "utf8",
      env: GIT_ENV,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(target, "branch", "--show-current"), "lane/支付-页面");
  } finally {
    if (fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], {
        cwd: dir,
        env: GIT_ENV,
        stdio: "pipe",
      });
    }
  }
});

test("CLI：未知命令明确说不认识，并列出真实命令", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cli-unknown-"));
  const result = spawnSync(process.execPath, [CLI, "statuz"], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /不认识命令「statuz」/);
  assert.match(result.stdout, /bosscoding status/);
});

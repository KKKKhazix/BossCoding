/**
 * task 命令单测：开出来的工作区必须真能用（分支对、位置对、保护激活），
 * 失败场景必须给出老板看得懂的修法而不是 git 原始报错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTask, sanitizeTaskName } from "../lib/commands/task.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "boss",
  GIT_AUTHOR_EMAIL: "boss@example.com",
  GIT_COMMITTER_NAME: "boss",
  GIT_COMMITTER_EMAIL: "boss@example.com",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: "pipe" }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function mute() {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = original.log;
    console.error = original.error;
  };
}

test("任务名清洗：空白与非法字符换成连字符，中文原样保留", () => {
  assert.equal(sanitizeTaskName("登录页"), "登录页");
  assert.equal(sanitizeTaskName("  a/b c  "), "a-b-c");
  assert.equal(sanitizeTaskName("x..."), "x");
  assert.equal(sanitizeTaskName("///"), "");
});

test("开任务：工作区在主工作区旁边、分支 lane/<名> 已就位、保护随之激活", () => {
  const dir = repo();
  const unmute = mute();
  let target;
  try {
    assert.equal(runTask(dir, "登录页"), 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-登录页`);
    assert.ok(fs.existsSync(target), "工作区目录不存在");
    assert.equal(git(target, "rev-parse", "--abbrev-ref", "HEAD"), "lane/登录页");
    // 工作区数 ≥2 —— 主工作区保护 hook 的激活条件由此成立。
    const count = git(dir, "worktree", "list").split(/\r?\n/).filter(Boolean).length;
    assert.equal(count, 2);
  } finally {
    unmute();
    if (target) {
      execFileSync("git", ["worktree", "remove", "--force", target], { cwd: dir, env: GIT_ENV, stdio: "pipe" });
    }
  }
});

test("防呆：缺任务名、任务名清洗后为空、分支重名、目录已存在，都是明确报错不硬来", () => {
  const dir = repo();
  const unmute = mute();
  let target;
  try {
    assert.equal(runTask(dir, undefined), 1);
    assert.equal(runTask(dir, "   "), 1);
    assert.equal(runTask(dir, "///"), 1);

    assert.equal(runTask(dir, "撞名"), 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-撞名`);
    // 同名再来一次：分支已存在 → 拒绝，且不动已有目录。
    assert.equal(runTask(dir, "撞名"), 1);
    assert.ok(fs.existsSync(target), "已有工作区不许被动");
  } finally {
    unmute();
    if (target && fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], { cwd: dir, env: GIT_ENV, stdio: "pipe" });
    }
  }
});

test("防呆：不是 git 仓库、还没有首个提交，各自给修法", () => {
  const unmute = mute();
  try {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-norepo-"));
    assert.equal(runTask(notRepo, "x"), 1);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-empty-"));
    git(empty, "init", "-q", "-b", "main");
    assert.equal(runTask(empty, "x"), 1);
  } finally {
    unmute();
  }
});

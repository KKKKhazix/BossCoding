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

import { runTask, sanitizeTaskName, mergedTaskWorktrees, shellQuote } from "../lib/commands/task.mjs";

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

function repo(prefix = "bosscoding-task-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function capture(run) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: run(), output: lines.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

test("任务名清洗：空白与非法字符换成连字符，中文原样保留", () => {
  assert.equal(sanitizeTaskName("登录页"), "登录页");
  assert.equal(sanitizeTaskName("  a/b c  "), "a-b-c");
  assert.equal(sanitizeTaskName("x..."), "x");
  assert.equal(sanitizeTaskName("///"), "");
});

test("可复制命令：路径有空格或单引号时仍是一个完整参数", () => {
  assert.equal(shellQuote("/tmp/my project"), "'/tmp/my project'");
  assert.equal(shellQuote("/tmp/boss's project"), "'/tmp/boss'\\''s project'");
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

test("开任务：任意工作区有未提交内容都拒绝，并给一句可交给 AI 的话", () => {
  const dir = repo();
  let linked;
  try {
    fs.writeFileSync(path.join(dir, "dirty.txt"), "dirty\n");
    const mainDirty = capture(() => runTask(dir, "新任务", { installDeps: false }));
    assert.equal(mainDirty.result, 1);
    assert.match(mainDirty.output, /把这句话交给 AI/);
    assert.equal(git(dir, "branch", "--list", "lane/新任务"), "");

    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "save main");
    linked = path.join(path.dirname(dir), `${path.basename(dir)}-existing`);
    git(dir, "worktree", "add", "-q", linked, "-b", "lane/existing");
    fs.writeFileSync(path.join(linked, "dirty-linked.txt"), "dirty\n");

    const otherDirty = capture(() => runTask(dir, "另一个任务", { installDeps: false }));
    assert.equal(otherDirty.result, 1);
    assert.match(otherDirty.output, new RegExp(linked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(otherDirty.output, /先逐一处理所有工作区/);
    assert.equal(git(dir, "branch", "--list", "lane/另一个任务"), "");
  } finally {
    if (linked && fs.existsSync(linked)) {
      execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: dir, env: GIT_ENV, stdio: "pipe" });
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

test("重复任务：优先恢复已有工作区，技术清理命令先移除工作区再删分支且正确引用路径", () => {
  const dir = repo("boss coding task-");
  let target;
  try {
    const opened = capture(() => runTask(dir, "撞 名", { installDeps: false }));
    assert.equal(opened.result, 0);
    assert.doesNotMatch(opened.output, /git worktree remove/);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-撞-名`);

    const repeated = capture(() => runTask(dir, "撞 名", { installDeps: false }));
    assert.equal(repeated.result, 1);
    assert.match(repeated.output, /继续接管已有任务工作区/);
    const remove = `git worktree remove ${shellQuote(target)}`;
    const branch = `git branch -d ${shellQuote("lane/撞-名")}`;
    assert.ok(repeated.output.indexOf(remove) < repeated.output.indexOf(branch), "恢复提示的清理顺序反了");
  } finally {
    if (target && fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], { cwd: dir, env: GIT_ENV, stdio: "pipe" });
    }
  }
});

test("回收：刚创建且仍等于主干的不算完成；真正提交并合并后才会被认出来", () => {
  const dir = repo();
  const unmute = mute();
  const opened = [];
  try {
    runTask(dir, "已完成", { installDeps: false });
    runTask(dir, "进行中", { installDeps: false });
    opened.push(
      path.join(path.dirname(dir), `${path.basename(dir)}-已完成`),
      path.join(path.dirname(dir), `${path.basename(dir)}-进行中`),
    );

    assert.deepEqual(mergedTaskWorktrees(dir), [], "刚创建的空任务不应立刻显示可回收");

    // 两条任务都真做一笔；只把「已完成」快进回主干。
    fs.writeFileSync(path.join(opened[0], "done.txt"), "done\n");
    git(opened[0], "add", "-A");
    git(opened[0], "commit", "-qm", "done");
    fs.writeFileSync(path.join(opened[1], "wip.txt"), "wip\n");
    git(opened[1], "add", "-A");
    git(opened[1], "commit", "-qm", "wip");
    git(dir, "merge", "-q", "--ff-only", "lane/已完成");

    const stale = mergedTaskWorktrees(dir);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].branch, "lane/已完成");
  } finally {
    unmute();
    for (const t of opened) {
      if (fs.existsSync(t)) {
        execFileSync("git", ["worktree", "remove", "--force", t], { cwd: dir, env: GIT_ENV, stdio: "pipe" });
      }
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

/**
 * 主工作区守卫：装得上、不踩别人、真能拦住 git，而且在单工作区项目里彻底闭嘴。
 *
 * 拦截用真 `git commit` 验证而不是直接跑脚本——要证的正是「git 会不会执行它」，
 * 少一个执行位就静默失效，只有让 git 自己来跑才测得出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installHooks, HOOK_NAMES } from "../lib/hooks.mjs";

// hook 在 CI 里主动闭嘴，所以测拦截时必须把 CI 变量清掉，否则测的是空气。
const GIT_ENV = {
  ...process.env,
  CI: "",
  GIT_AUTHOR_NAME: "boss",
  GIT_AUTHOR_EMAIL: "boss@example.com",
  GIT_COMMITTER_NAME: "boss",
  GIT_COMMITTER_EMAIL: "boss@example.com",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: "pipe" });
}

/** 一个有初始提交的仓库，主干叫 main。 */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-hooks-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/** 试提交一笔，返回 { ok, output }——不抛异常，把结果交给断言。 */
function tryCommit(cwd, file) {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, "add", "-A");
  try {
    git(cwd, "commit", "-qm", `add ${file}`);
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stderr ?? ""}${error.stdout ?? ""}` };
  }
}

test("装：两个 hook 都写进去，且带可执行位", () => {
  const dir = repo();
  const result = installHooks(dir);
  assert.deepEqual(result.installed.sort(), [...HOOK_NAMES].sort());
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, ".git", "hooks", name);
    assert.ok(fs.existsSync(file), `缺 ${name}`);
    // 少了执行位 git 会静默忽略——这一条就是那次「测试没拦住」的事故本身。
    assert.equal(fs.statSync(file).mode & 0o111, 0o111, `${name} 没有可执行位`);
  }
});

test("装：幂等——再跑一次不重复报告、不改内容", () => {
  const dir = repo();
  installHooks(dir);
  const before = fs.readFileSync(path.join(dir, ".git/hooks/pre-commit"), "utf8");
  const again = installHooks(dir);
  assert.deepEqual(again.installed, []);
  assert.deepEqual(again.refreshed, []);
  assert.equal(fs.readFileSync(path.join(dir, ".git/hooks/pre-commit"), "utf8"), before);
});

test("装：别人的 hook 一律让路，只刷新自己写的", () => {
  const dir = repo();
  const mine = path.join(dir, ".git/hooks/pre-commit");
  fs.writeFileSync(mine, "#!/bin/sh\n# husky 之类的既有 hook\nexit 0\n");
  const result = installHooks(dir);
  assert.deepEqual(result.skipped, ["pre-commit"]);
  assert.match(fs.readFileSync(mine, "utf8"), /既有 hook/);

  // 自己写过的那份被改旧了，则允许刷新。
  const checkout = path.join(dir, ".git/hooks/post-checkout");
  fs.writeFileSync(checkout, "#!/bin/sh\n# bosscoding:main-worktree-guard 旧版\nexit 0\n");
  assert.deepEqual(installHooks(dir).refreshed, ["post-checkout"]);
});

test("拦：单工作区的项目里彻底闭嘴（框架自己教的流程不能被自己拦住）", () => {
  const dir = repo();
  installHooks(dir);
  git(dir, "checkout", "-q", "-b", "feature/x");
  const r = tryCommit(dir, "a.txt");
  assert.ok(r.ok, `单工作区不该拦：${r.output}`);
});

test("拦：开了独立工作区之后，主工作区的分支提交被 git 真的挡下", () => {
  const dir = repo();
  installHooks(dir);
  const linked = path.join(path.dirname(dir), `${path.basename(dir)}-lane`);
  git(dir, "worktree", "add", "-q", linked, "-b", "lane/one");

  // 主工作区、非主干分支 → 拦。
  git(dir, "checkout", "-q", "-b", "feature/y");
  const blocked = tryCommit(dir, "b.txt");
  assert.equal(blocked.ok, false, "应当被拦住");
  assert.match(blocked.output, /主工作区只跑 main/);
  assert.match(blocked.output, /git worktree add/);

  // 逃生阀：git 内置的 --no-verify，不另造旁路。
  git(dir, "commit", "-qm", "b", "--no-verify");

  // 主工作区、主干分支 → 放行。
  git(dir, "checkout", "-q", "main");
  assert.ok(tryCommit(dir, "c.txt").ok, "main 上不该被拦");

  // 独立工作区里干活 → 放行（这正是被推荐的姿势）。
  assert.ok(tryCommit(linked, "d.txt").ok, "独立工作区不该被拦");

  // detached HEAD（rebase／bisect 中途）→ 放行。
  git(dir, "checkout", "-q", "--detach");
  assert.ok(tryCommit(dir, "e.txt").ok, "detached HEAD 不该被拦");

  fs.rmSync(linked, { recursive: true, force: true });
});

test("拦：CI 里不出声（CI 没有另一个 agent，也没人看警告）", () => {
  const dir = repo();
  installHooks(dir);
  const linked = path.join(path.dirname(dir), `${path.basename(dir)}-ci-lane`);
  git(dir, "worktree", "add", "-q", linked, "-b", "lane/ci");
  git(dir, "checkout", "-q", "-b", "feature/z");

  fs.writeFileSync(path.join(dir, "f.txt"), "f\n");
  git(dir, "add", "-A");
  execFileSync("git", ["commit", "-qm", "f"], { cwd: dir, env: { ...GIT_ENV, CI: "true" }, stdio: "pipe" });

  fs.rmSync(linked, { recursive: true, force: true });
});

test("提醒：切分支只警告不拦（此刻改正成本为零）", () => {
  const dir = repo();
  installHooks(dir);
  const linked = path.join(path.dirname(dir), `${path.basename(dir)}-warn-lane`);
  git(dir, "worktree", "add", "-q", linked, "-b", "lane/warn");

  const out = execFileSync("git", ["checkout", "-b", "feature/w"], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: "pipe",
  });
  assert.equal(typeof out, "string"); // 切换本身必须成功（post-checkout 的退出码 git 本就忽略）
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), "feature/w");

  fs.rmSync(linked, { recursive: true, force: true });
});

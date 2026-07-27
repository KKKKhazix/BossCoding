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

test("装：三个 hook 都写进去，且带可执行位", () => {
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

test("装：别人的 hook 一律让路；仅有 BossCoding marker 也不能证明可整份覆盖", () => {
  const dir = repo();
  const mine = path.join(dir, ".git/hooks/pre-commit");
  fs.writeFileSync(mine, "#!/bin/sh\n# husky 之类的既有 hook\nexit 0\n");
  const result = installHooks(dir);
  assert.deepEqual(result.skipped, ["pre-commit"]);
  assert.match(fs.readFileSync(mine, "utf8"), /既有 hook/);

  // 只有 marker、没有安装时记录的正文哈希，可能是用户手工合并过的，必须让路。
  const checkout = path.join(dir, ".git/hooks/post-checkout");
  fs.writeFileSync(checkout, "#!/bin/sh\n# bosscoding:main-worktree-guard 旧版\nexit 0\n");
  const second = installHooks(dir);
  assert.ok(second.skipped.includes("post-checkout"));
  assert.match(fs.readFileSync(checkout, "utf8"), /旧版/);
});

test("装：官方 hook 后追加用户命令会失去纯官方哈希，更新时保留不覆盖", () => {
  const dir = repo();
  installHooks(dir);
  const target = path.join(dir, ".git/hooks/pre-commit");
  fs.appendFileSync(target, "\n# 用户自己的检查\nnode my-check.mjs\n");

  const result = installHooks(dir);
  assert.ok(result.skipped.includes("pre-commit"));
  assert.equal(result.refreshed.includes("pre-commit"), false);
  assert.match(fs.readFileSync(target, "utf8"), /node my-check\.mjs/);
});

test("装：单个 hook 或所有权清单是软链时绝不跟随写到项目外", (t) => {
  const dir = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-hook-leaf-outside-"));
  const externalHook = path.join(outside, "pre-push");
  try {
    fs.symlinkSync(externalHook, path.join(dir, ".git/hooks/pre-push"));
  } catch {
    t.skip("当前平台不允许创建文件软链");
    return;
  }

  const result = installHooks(dir);
  assert.ok(result.skipped.includes("pre-push"));
  assert.equal(fs.existsSync(externalHook), false);

  const guarded = repo();
  const externalOwnership = path.join(outside, "ownership.json");
  fs.writeFileSync(externalOwnership, '{"user":"content"}\n');
  fs.symlinkSync(
    externalOwnership,
    path.join(guarded, ".git/hooks/.bosscoding-owned-hooks.json"),
  );
  const blocked = installHooks(guarded);
  assert.equal(blocked.blocked.length, 1);
  assert.equal(fs.readFileSync(externalOwnership, "utf8"), '{"user":"content"}\n');
  for (const name of HOOK_NAMES) {
    assert.equal(fs.existsSync(path.join(guarded, ".git/hooks", name)), false);
  }
});

test("升级：精确等于上一版官方正文的 hook 可迁移并建立所有权记录", () => {
  const dir = repo();
  installHooks(dir);
  const target = path.join(dir, ".git/hooks/pre-commit");
  const ownership = path.join(dir, ".git/hooks/.bosscoding-owned-hooks.json");
  const legacy = fs
    .readFileSync(target, "utf8")
    .replace("`bosscoding update` 会刷新本文件", "`npx boss update` 会刷新本文件");
  fs.writeFileSync(target, legacy);
  fs.unlinkSync(ownership);

  const result = installHooks(dir);
  assert.ok(result.refreshed.includes("pre-commit"));
  assert.match(fs.readFileSync(target, "utf8"), /`bosscoding update`/);
  assert.ok(fs.existsSync(ownership));
});

test("装：core.hooksPath 指到仓库外时明确阻止，绝不写共享目录", () => {
  const dir = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-global-hooks-"));
  git(dir, "config", "core.hooksPath", outside);

  const result = installHooks(dir);
  assert.deepEqual(result.installed, []);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0], /指向项目外|没有写入/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("装：仓库内 core.hooksPath 仍可使用", () => {
  const dir = repo();
  git(dir, "config", "core.hooksPath", ".githooks");

  const result = installHooks(dir);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.installed.sort(), [...HOOK_NAMES].sort());
  for (const name of HOOK_NAMES) {
    assert.ok(fs.existsSync(path.join(dir, ".githooks", name)), `仓库内缺 ${name}`);
  }
});

test("装：兼容旧 Git，不依赖 --path-format；路径探测失败必须明确阻止", () => {
  const dir = repo();
  const calls = [];
  const compatibleRunner = (command, args, options) => {
    calls.push(args);
    return execFileSync(command, args, options);
  };
  const installed = installHooks(dir, { execFileSync: compatibleRunner });
  assert.deepEqual(installed.blocked, []);
  assert.equal(calls.some((args) => args.includes("--path-format=absolute")), false);
  assert.equal(calls.some((args) => args.includes("--git-path")), true);

  const failedDir = repo();
  const blocked = installHooks(failedDir, {
    execFileSync: () => {
      throw new Error("old git probe failed");
    },
  });
  assert.deepEqual(blocked.installed, []);
  assert.equal(blocked.blocked.length, 1);
  assert.match(blocked.blocked[0], /无法确认.*Git hook 路径|没有写入/);
  for (const name of HOOK_NAMES) {
    assert.equal(fs.existsSync(path.join(failedDir, ".git/hooks", name)), false);
  }
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

/** 本地 bare 仓库当 origin，让 push 全程离线可测。 */
function bareRemote(dir) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare], { env: GIT_ENV, stdio: "pipe" });
  git(dir, "remote", "add", "origin", bare);
  return bare;
}

function tryPush(cwd, ...args) {
  try {
    git(cwd, "push", "-q", ...args);
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stderr ?? ""}${error.stdout ?? ""}` };
  }
}

test("直推门禁：首推放行、二推被拦、分支照推、--no-verify 逃生、CI 放行", () => {
  const dir = repo();
  installHooks(dir);
  bareRemote(dir);

  // 首次推送：远端还没有 main，放行（否则第 1 阶「连接 GitHub」被自己拦死）。
  const first = tryPush(dir, "origin", "main");
  assert.ok(first.ok, `首推不该被拦：${first.output}`);

  // 远端 main 已存在后再直推 → 拦，且话术教人走 PR。
  fs.writeFileSync(path.join(dir, "direct.txt"), "direct\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "direct");
  const blocked = tryPush(dir, "origin", "main");
  assert.equal(blocked.ok, false, "直推已存在的远端主干应当被拦");
  assert.match(blocked.output, /禁止直推 main/);
  assert.match(blocked.output, /PR/);

  // 逃生阀：git 内置 --no-verify，不另造旁路。
  assert.ok(tryPush(dir, "--no-verify", "origin", "main").ok, "--no-verify 必须能走");

  // 功能分支照推——这正是被推荐的姿势。
  git(dir, "checkout", "-q", "-b", "lane/push");
  fs.writeFileSync(path.join(dir, "lane.txt"), "lane\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "lane");
  const branchPush = tryPush(dir, "origin", "lane/push");
  assert.ok(branchPush.ok, `推分支不该被拦：${branchPush.output}`);

  // 从分支偷袭主干（push HEAD:main）也算直推 → 拦。
  const sneaky = tryPush(dir, "origin", "HEAD:main");
  assert.equal(sneaky.ok, false, "HEAD:main 偷袭应当被拦");

  // CI 里放行：CI 的推送是流程自己的动作。
  execFileSync("git", ["push", "-q", "origin", "HEAD:main"], {
    cwd: dir,
    env: { ...GIT_ENV, CI: "true" },
    stdio: "pipe",
  });
});

test("直推门禁：非 origin 的远端（备份镜像）不拦", () => {
  const dir = repo();
  installHooks(dir);
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-backup-"));
  execFileSync("git", ["init", "-q", "--bare", backup], { env: GIT_ENV, stdio: "pipe" });
  git(dir, "remote", "add", "backup", backup);

  git(dir, "push", "-q", "backup", "main");
  fs.writeFileSync(path.join(dir, "mirror.txt"), "mirror\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "mirror");
  const again = tryPush(dir, "backup", "main");
  assert.ok(again.ok, `备份镜像不该被拦：${again.output}`);
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

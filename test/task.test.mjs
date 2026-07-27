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

test("开任务：稳定主工作区必须干净；其他任务有未提交内容仍可正常并行", () => {
  const dir = repo();
  let linked;
  let target;
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
    assert.equal(otherDirty.result, 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-另一个任务`);
    assert.ok(fs.existsSync(target), "其他任务的未提交内容不应阻塞新任务");
    assert.doesNotMatch(otherDirty.output, /对当前 AI 说/);
    assert.match(otherDirty.output, /不要把调度退给老板/);
    assert.match(otherDirty.output, /仅当当前环境明确不支持创建新会话/);
  } finally {
    if (target && fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], {
        cwd: dir,
        env: GIT_ENV,
        stdio: "pipe",
      });
    }
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

test("回收：刚创建的不算完成；已合并但工作区仍有未提交内容也绝不报告可回收", () => {
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

    fs.writeFileSync(path.join(opened[0], "after-merge.txt"), "not saved\n");
    assert.deepEqual(mergedTaskWorktrees(dir), [], "工作区有未提交内容时绝不能建议回收");
    fs.rmSync(path.join(opened[0], "after-merge.txt"));

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

test("防呆：不是 git 仓库、还没有首个提交，只交给 AI 安全处理，不教一把收走所有文件", () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-norepo-"));
  const first = capture(() => runTask(notRepo, "x"));
  assert.equal(first.result, 1);
  assert.match(first.output, /排除私人文件和密钥/);
  assert.doesNotMatch(first.output, /git init|git add -A/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-empty-"));
  git(empty, "init", "-q", "-b", "main");
  const second = capture(() => runTask(empty, "x"));
  assert.equal(second.result, 1);
  assert.match(second.output, /哪些文件属于产品/);
  assert.doesNotMatch(second.output, /git init|git add -A/);
});

test("自定义稳定分支：唯一非任务分支 develop 可直接开工", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-no-base-"));
  git(dir, "init", "-q", "-b", "develop");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");

  const target = path.join(path.dirname(dir), `${path.basename(dir)}-可以创建`);
  const result = capture(() => runTask(dir, "可以创建", { installDeps: false }));
  assert.equal(result.result, 0);
  assert.equal(git(target, "merge-base", "develop", "lane/可以创建"), git(dir, "rev-parse", "develop"));
  execFileSync("git", ["worktree", "remove", "--force", target], {
    cwd: dir,
    env: GIT_ENV,
    stdio: "pipe",
  });
});

test("防呆：多个自定义候选且没有统一稳定分支时拒绝，不从当前分支猜", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-task-no-base-"));
  git(dir, "init", "-q", "-b", "develop");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "branch", "release");

  const result = capture(() => runTask(dir, "不该创建", { installDeps: false }));
  assert.equal(result.result, 1);
  assert.match(result.output, /找不到统一的稳定分支/);
  assert.equal(git(dir, "branch", "--list", "lane/不该创建"), "");
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("防呆：整段需求不能变成长路径，失败时不泄露 git 原始报错", () => {
  const dir = repo();
  const result = capture(() => runTask(dir, "请帮我做一个非常完整的产品功能".repeat(30)));

  assert.equal(result.result, 1);
  assert.match(result.output, /一整段需求|20 字以内/);
  assert.doesNotMatch(result.output, /fatal:|cannot lock|refs\/heads/);
  assert.equal(git(dir, "branch", "--list", "lane/*"), "");
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("包管理器：开任务沿用 npm／pnpm／Yarn／Bun，绝不偷换工具", () => {
  const cases = [
    ["npm", "npm@10.0.0", "package-lock.json", "ci", null],
    ["pnpm", "pnpm@9.0.0", "pnpm-lock.yaml", "install", "--frozen-lockfile"],
    ["yarn", "yarn@4.0.0", "yarn.lock", "install", "--immutable"],
    ["bun", "bun@1.1.0", "bun.lock", "install", "--frozen-lockfile"],
  ];

  for (const [manager, declaration, lock, action, flag] of cases) {
    const dir = repo(`bosscoding-task-${manager}-`);
    const pkg = {
      name: `${manager}-project`,
      private: true,
      packageManager: declaration,
      dependencies: { example: "1.0.0" },
    };
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg)}\n`);
    fs.writeFileSync(path.join(dir, lock), "{}\n");
    if (manager === "yarn") {
      fs.writeFileSync(path.join(dir, ".gitignore"), ".pnp.cjs\n");
      fs.writeFileSync(path.join(dir, ".pnp.cjs"), "module.exports = {};\n");
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `${manager} setup`);

    const calls = [];
    const target = path.join(path.dirname(dir), `${path.basename(dir)}-依赖`);
    try {
      const result = capture(() =>
        runTask(dir, "依赖", {
          installRunner: (command, args, options) => {
            calls.push({ command, args, cwd: options.cwd });
            return "";
          },
        }),
      );
      assert.equal(result.result, 0, `${manager}: ${result.output}`);
      assert.equal(calls.length, 1, manager);
      assert.equal(calls[0].command, manager);
      assert.equal(calls[0].args[0], action);
      if (flag) assert.ok(calls[0].args.includes(flag), manager);
      assert.doesNotMatch(JSON.stringify(calls), manager === "npm" ? /"pnpm"|"yarn"|"bun"/ : /"npm"/);
    } finally {
      if (fs.existsSync(target)) {
        execFileSync("git", ["worktree", "remove", "--force", target], {
          cwd: dir,
          env: GIT_ENV,
          stdio: "pipe",
        });
      }
    }
  }
});

test("包管理器：冲突时零写入；原工具安装失败时保留任务并明确未完成", () => {
  const conflict = repo("bosscoding-task-conflict-");
  fs.writeFileSync(
    path.join(conflict, "package.json"),
    '{"name":"conflict","private":true,"packageManager":"pnpm@9.0.0","dependencies":{"x":"1"}}\n',
  );
  fs.writeFileSync(path.join(conflict, "pnpm-lock.yaml"), "lock\n");
  fs.writeFileSync(path.join(conflict, "yarn.lock"), "lock\n");
  git(conflict, "add", "-A");
  git(conflict, "commit", "-qm", "conflict");
  const blocked = capture(() => runTask(conflict, "冲突"));
  assert.equal(blocked.result, 1);
  assert.match(blocked.output, /多套安装工具/);
  assert.equal(git(conflict, "branch", "--list", "lane/冲突"), "");
  assert.equal(git(conflict, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);

  const failed = repo("bosscoding-task-pnpm-fail-");
  fs.writeFileSync(
    path.join(failed, "package.json"),
    '{"name":"pnpm-fail","private":true,"packageManager":"pnpm@9.0.0","dependencies":{"x":"1"}}\n',
  );
  fs.writeFileSync(path.join(failed, "pnpm-lock.yaml"), "lock\n");
  git(failed, "add", "-A");
  git(failed, "commit", "-qm", "pnpm");
  const target = path.join(path.dirname(failed), `${path.basename(failed)}-失败`);
  try {
    const result = capture(() =>
      runTask(failed, "失败", {
        installRunner: () => {
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        },
      }),
    );
    assert.equal(result.result, 1);
    assert.match(result.output, /pnpm 依赖没装成|任务文件和分支已安全保留/);
    assert.doesNotMatch(result.output, /npm install|网络？/);
    assert.ok(fs.existsSync(target));
  } finally {
    if (fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], {
        cwd: failed,
        env: GIT_ENV,
        stdio: "pipe",
      });
    }
  }
});

test("包管理器：项目尚无锁文件时沿用原工具普通安装，不误加冻结参数", () => {
  const dir = repo("bosscoding-task-pnpm-no-lock-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    '{"name":"pnpm-no-lock","private":true,"packageManager":"pnpm@9.0.0","dependencies":{"x":"1"}}\n',
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "pnpm without lock");
  const target = path.join(path.dirname(dir), `${path.basename(dir)}-无锁`);
  const calls = [];
  try {
    const result = capture(() =>
      runTask(dir, "无锁", {
        installRunner: (command, args) => {
          calls.push({ command, args });
          return "";
        },
      }),
    );
    assert.equal(result.result, 0, result.output);
    assert.deepEqual(calls, [{ command: "pnpm", args: ["install"] }]);
    assert.match(result.output, /若新生成了一份/);
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

test("防呆：稳定分支存在但没有自己的工作区时，也不从任务工作区继续分叉", () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "lane/first");
  const result = capture(() => runTask(dir, "second", { installDeps: false }));
  assert.equal(result.result, 1);
  assert.match(result.output, /没有自己的稳定工作区/);
  assert.equal(git(dir, "branch", "--list", "lane/second"), "");
});

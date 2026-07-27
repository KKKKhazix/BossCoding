/**
 * finish 端到端：用真实 git worktree 验证任务工作区 → 主工作区的闭环；
 * 只把 preflight 与 GitHub 队列换成可控 runner，不拿网络和 npm 偶然性当测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runFinish } from "../lib/commands/finish.mjs";
import { mergedTaskWorktrees, runTask } from "../lib/commands/task.mjs";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-finish-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function openTask(dir, name = "交付") {
  const original = console.log;
  console.log = () => {};
  try {
    assert.equal(runTask(dir, name, { installDeps: false }), 0);
  } finally {
    console.log = original;
  }
  return path.join(path.dirname(dir), `${path.basename(dir)}-${name}`);
}

function commitTask(target, file = "done.txt") {
  fs.writeFileSync(path.join(target, file), "done\n");
  git(target, "add", "-A");
  git(target, "commit", "-qm", "finish task");
}

function controllableRunner(options = {}) {
  const calls = [];
  const runner = (command, args, runOptions) => {
    calls.push({ command, args: [...args], cwd: runOptions.cwd });
    if (command === "npm") {
      if (options.onPreflight) options.onPreflight(runOptions.cwd);
      if (options.preflightFails) throw new Error("preflight failed");
      return "";
    }
    return execFileSync(command, args, {
      ...runOptions,
      env: GIT_ENV,
      // 测试不把子进程输出灌进 TAP；退出码与返回值仍与 execFileSync 一样。
      stdio: runOptions.stdio === "inherit" ? "pipe" : runOptions.stdio,
    });
  };
  return { runner, calls };
}

async function capture(run) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: await run(), output: lines.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

function removeTask(dir, target) {
  if (target && fs.existsSync(target)) {
    execFileSync("git", ["worktree", "remove", "--force", target], {
      cwd: dir,
      env: GIT_ENV,
      stdio: "pipe",
    });
  }
}

test("本地收尾：任务工作区跑自检，快进主干，不删除；重复运行仍成功且主干不变", async () => {
  const dir = repo();
  const target = openTask(dir);
  try {
    commitTask(target);
    const expected = git(target, "rev-parse", "HEAD");
    const controlled = controllableRunner();

    const first = await capture(() => runFinish(target, { runner: controlled.runner }));
    assert.equal(first.result, 0);
    assert.equal(git(dir, "rev-parse", "main"), expected);
    assert.ok(fs.existsSync(target), "finish 不得删除任务工作区");
    assert.equal(git(target, "rev-parse", "--abbrev-ref", "HEAD"), "lane/交付");
    assert.ok(
      controlled.calls.some(
        (call) =>
          call.command === "npm" &&
          call.args.join(" ") === "run preflight" &&
          fs.realpathSync(call.cwd) === fs.realpathSync(target),
      ),
      "preflight 必须在任务工作区运行",
    );
    assert.deepEqual(mergedTaskWorktrees(dir).map((entry) => entry.branch), ["lane/交付"]);

    const beforeRepeat = git(dir, "rev-parse", "main");
    const repeated = await capture(() => runFinish(target, { runner: controlled.runner }));
    assert.equal(repeated.result, 0);
    assert.match(repeated.output, /已经在 main/);
    assert.equal(git(dir, "rev-parse", "main"), beforeRepeat);
  } finally {
    removeTask(dir, target);
  }
});

test("本地收尾：任一边不干净、自检失败或自检制造新文件，都不改主干", async () => {
  const scenarios = [
    {
      name: "主工作区脏",
      prepare: (dir) => fs.writeFileSync(path.join(dir, "dirty-main.txt"), "dirty\n"),
      runner: () => controllableRunner(),
    },
    {
      name: "自检失败",
      prepare: () => {},
      runner: () => controllableRunner({ preflightFails: true }),
    },
    {
      name: "自检制造新文件",
      prepare: () => {},
      runner: () =>
        controllableRunner({
          onPreflight: (cwd) => fs.writeFileSync(path.join(cwd, "generated.txt"), "generated\n"),
        }),
    },
  ];

  for (const scenario of scenarios) {
    const dir = repo();
    const target = openTask(dir, scenario.name);
    try {
      commitTask(target);
      scenario.prepare(dir, target);
      const before = git(dir, "rev-parse", "main");
      const controlled = scenario.runner();
      const result = await capture(() => runFinish(target, { runner: controlled.runner }));
      assert.equal(result.result, 1, scenario.name);
      assert.equal(git(dir, "rev-parse", "main"), before, scenario.name);
    } finally {
      removeTask(dir, target);
    }
  }
});

test("本地收尾：主干与任务分叉时拒绝，不制造合并提交", async () => {
  const dir = repo();
  const target = openTask(dir, "分叉");
  try {
    commitTask(target);
    fs.writeFileSync(path.join(dir, "main.txt"), "main moved\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "main moved");
    const before = git(dir, "rev-parse", "main");
    const controlled = controllableRunner();

    const result = await capture(() => runFinish(target, { runner: controlled.runner }));
    assert.equal(result.result, 1);
    assert.match(result.output, /不能直接快进合并/);
    assert.equal(git(dir, "rev-parse", "main"), before);
    assert.equal(git(dir, "rev-list", "--count", "main"), "2");
  } finally {
    removeTask(dir, target);
  }
});

test("GitHub 收尾：只查队列并给下一步，不上传、不合并主干", async () => {
  const dir = repo();
  const target = openTask(dir, "云端");
  try {
    commitTask(target);
    git(dir, "remote", "add", "origin", "https://github.com/example/product.git");
    const before = git(dir, "rev-parse", "main");
    const controlled = controllableRunner();
    const queueCalls = [];
    const queueRunner = async (root, options) => {
      queueCalls.push({ root, options });
      return 0;
    };

    const result = await capture(() =>
      runFinish(target, {
        runner: controlled.runner,
        queueRunner,
        queueOptions: { fetchPulls: async () => [] },
      }),
    );
    assert.equal(result.result, 0);
    assert.equal(queueCalls.length, 1);
    assert.equal(fs.realpathSync(queueCalls[0].root), fs.realpathSync(target));
    assert.equal(git(dir, "rev-parse", "main"), before);
    assert.equal(
      controlled.calls.some((call) => call.command === "git" && call.args[0] === "merge"),
      false,
      "GitHub 阶段不应写本地主干",
    );
    assert.match(result.output, /只查队列，不自动上传、不建申请单、不合并/);
    assert.match(result.output, /下一步/);
  } finally {
    removeTask(dir, target);
  }
});

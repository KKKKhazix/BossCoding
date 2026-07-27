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
import { runInit } from "../lib/commands/init.mjs";
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
  fs.writeFileSync(
    path.join(dir, "package.json"),
    '{"name":"finish-test","private":true,"scripts":{"test":"node --test","preflight":"npm test && boss check"}}\n',
  );
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test", "smoke.test.mjs"),
    'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function initializedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-finish-first-"));
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test", "smoke.test.mjs"),
    'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
  );
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

test("本地首项任务：唯一工作区从 lane 安全切回并快进 main，真实测试与守卫都执行", async () => {
  const dir = initializedRepo();
  git(dir, "checkout", "-q", "-b", "lane/first");
  fs.writeFileSync(path.join(dir, "first.txt"), "first task\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first task");
  const expected = git(dir, "rev-parse", "HEAD");
  const quietRealRunner = (command, args, options) =>
    execFileSync(command, args, { ...options, env: GIT_ENV, stdio: "pipe" });

  const result = await capture(() => runFinish(dir, { runner: quietRealRunner }));
  assert.equal(result.result, 0);
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(dir, "rev-parse", "main"), expected);
  assert.equal(git(dir, "rev-parse", "lane/first"), expected, "任务分支必须保留");
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("本地收尾：任务工作区跑自检，快进主干，不删除；重复运行仍成功且主干不变", async () => {
  const dir = repo();
  const target = openTask(dir);
  try {
    commitTask(target);
    const expected = git(target, "rev-parse", "HEAD");
    const controlled = controllableRunner();

    const first = await capture(() =>
      runFinish(target, { runner: controlled.runner, checkRunner: () => 0 }),
    );
    assert.equal(first.result, 0);
    assert.equal(git(dir, "rev-parse", "main"), expected);
    assert.ok(fs.existsSync(target), "finish 不得删除任务工作区");
    assert.equal(git(target, "rev-parse", "--abbrev-ref", "HEAD"), "lane/交付");
    assert.ok(
      controlled.calls.some(
        (call) =>
          call.command === "npm" &&
          call.args.join(" ") === "test" &&
          fs.realpathSync(call.cwd) === fs.realpathSync(target),
      ),
      "产品测试必须在任务工作区运行",
    );
    assert.deepEqual(mergedTaskWorktrees(dir).map((entry) => entry.branch), ["lane/交付"]);

    const beforeRepeat = git(dir, "rev-parse", "main");
    const repeated = await capture(() =>
      runFinish(target, { runner: controlled.runner, checkRunner: () => 0 }),
    );
    assert.equal(repeated.result, 0);
    assert.match(repeated.output, /已经在 main/);
    assert.equal(git(dir, "rev-parse", "main"), beforeRepeat);
  } finally {
    removeTask(dir, target);
  }
});

test("本地收尾：echo ok 等空测试入口不能亮绿或合并", async () => {
  const dir = repo();
  const target = openTask(dir, "空测试");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    pkg.scripts.test = "echo ok";
    fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    fs.writeFileSync(path.join(target, "feature.txt"), "done\n");
    git(target, "add", "-A");
    git(target, "commit", "-qm", "fake test");
    const before = git(dir, "rev-parse", "main");

    const result = await capture(() =>
      runFinish(target, { runner: controllableRunner().runner, checkRunner: () => 0 }),
    );
    assert.equal(result.result, 1);
    assert.match(result.output, /还没有可执行的产品最小测试/);
    assert.equal(git(dir, "rev-parse", "main"), before);
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
      const result = await capture(() =>
        runFinish(target, { runner: controlled.runner, checkRunner: () => 0 }),
      );
      assert.equal(result.result, 1, scenario.name);
      assert.equal(git(dir, "rev-parse", "main"), before, scenario.name);
    } finally {
      removeTask(dir, target);
    }
  }
});

test("本地收尾：真实 npm 产品测试失败时绝不合并", async () => {
  const dir = repo();
  const target = openTask(dir, "坏测试");
  try {
    fs.writeFileSync(path.join(target, "broken.test.mjs"), 'throw new Error("产品真的坏了");\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    pkg.scripts.test = "node --test broken.test.mjs";
    fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    git(target, "add", "-A");
    git(target, "commit", "-qm", "add failing product test");
    const before = git(dir, "rev-parse", "main");

    // npm 与测试进程都是真实执行，只把输出收进管道，避免嵌套 TAP 干扰本测试。
    const quietRealRunner = (command, args, options) =>
      execFileSync(command, args, { ...options, env: GIT_ENV, stdio: "pipe" });
    const result = await capture(() => runFinish(target, { runner: quietRealRunner }));

    assert.equal(result.result, 1);
    assert.match(result.output, /自检没有通过/);
    assert.equal(git(dir, "rev-parse", "main"), before);
  } finally {
    removeTask(dir, target);
  }
});

test("本地收尾：preflight 里只是假装打印检查名，也跳不过独立守卫", async () => {
  const dir = repo();
  const target = openTask(dir, "假自检");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    pkg.scripts.preflight = "echo npm test && echo boss check";
    fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    fs.writeFileSync(path.join(target, "feature.txt"), "done\n");
    git(target, "add", "-A");
    git(target, "commit", "-qm", "fake preflight");
    const before = git(dir, "rev-parse", "main");
    const quietRealRunner = (command, args, options) =>
      execFileSync(command, args, { ...options, env: GIT_ENV, stdio: "pipe" });
    let checks = 0;

    const result = await capture(() =>
      runFinish(target, {
        runner: quietRealRunner,
        checkRunner: () => {
          checks += 1;
          return 1;
        },
      }),
    );
    assert.equal(result.result, 1);
    assert.equal(checks, 1);
    assert.equal(git(dir, "rev-parse", "main"), before);
  } finally {
    removeTask(dir, target);
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

    const result = await capture(() =>
      runFinish(target, { runner: controlled.runner, checkRunner: () => 0 }),
    );
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
        checkRunner: () => 0,
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

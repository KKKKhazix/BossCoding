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
const ROOT = fileURLToPath(new URL("../", import.meta.url));
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

test("CLI：拼错参数直接失败，绝不按忽略参数后的命令执行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cli-typo-"));
  const result = spawnSync(process.execPath, [CLI, "init", "--hepl"], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /不认识的参数：--hepl/);
  assert.match(result.stderr, /没有执行任何操作/);
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

test("CLI：意外文件错误也只给人话，不把程序堆栈丢给老板", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cli-error-"));
  git(dir, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(dir, "AGENTS.md"));

  const result = spawnSync(process.execPath, [CLI, "status"], {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /遇到意外问题/);
  assert.match(output, /把这句话交给 AI/);
  assert.doesNotMatch(output, /EISDIR|node:fs|\n\s+at /);
});

test("用户可见入口只展示唯一全名，不再诱导 npx 下载第三方 boss 包", () => {
  const roots = [
    path.join(ROOT, "README.md"),
    path.join(ROOT, "AGENTS.md"),
    path.join(ROOT, "bin"),
    path.join(ROOT, "templates"),
    path.join(ROOT, "lib", "commands"),
    path.join(ROOT, "lib", "guards"),
  ];
  const files = [];
  const walk = (target) => {
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      files.push(target);
      return;
    }
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
  };
  for (const target of roots) walk(target);

  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(body, /\bnpx boss\b/, path.relative(ROOT, file));
  }
});

/**
 * status 单测：探测必须来自真实命令输出，且全程只读——
 * 一个会动手的状态命令，老板就不敢随便跑了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { probe, runStatus } from "../lib/commands/status.mjs";
import { runInit } from "../lib/commands/init.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "boss",
  GIT_AUTHOR_EMAIL: "boss@example.com",
  GIT_COMMITTER_NAME: "boss",
  GIT_COMMITTER_EMAIL: "boss@example.com",
};

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

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }).trim();
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-status-"));
  const unmute = mute();
  try {
    runInit(dir);
  } finally {
    unmute();
  }
  return dir;
}

function commitAll(dir) {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

test("探测：远端已配置、GitHub 身份、当前提交已上传是三件不同的事实", () => {
  const dir = project();
  assert.equal(probe(dir).rung, 0);
  commitAll(dir);

  git(dir, "remote", "add", "origin", "/tmp/not-a-github-repository.git");
  const arbitrary = probe(dir);
  assert.equal(arbitrary.remoteConfigured, true);
  assert.equal(arbitrary.githubRemote, false);
  assert.equal(arbitrary.currentCommitUploaded, false);
  assert.equal(arbitrary.rung, 0);

  git(dir, "remote", "set-url", "origin", "https://github.com/o/r.git");
  const configured = probe(dir);
  assert.equal(configured.remoteConfigured, true);
  assert.equal(configured.githubRemote, true);
  assert.equal(configured.currentCommitUploaded, false);
  assert.equal(configured.rung, 0);

  // remote-tracking ref 只会在成功 push／fetch 后出现；这里离线造同样的 Git 事实。
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  const uploaded = probe(dir);
  assert.equal(uploaded.currentCommitUploaded, true);
  assert.equal(uploaded.rung, 1);
});

test("探测：规则、三个门禁、真实依赖、项目简介与最小产品测试逐项看事实", () => {
  const dir = project();
  const before = probe(dir);
  assert.equal(before.intro, "placeholder");
  assert.equal(before.depsInstalled, false);
  assert.equal(before.dependenciesRequired, true);
  assert.equal(before.hasPackageJson, true);
  assert.equal(before.rulesReady, true);
  assert.equal(before.hooksReady, true);
  assert.equal(before.hasProductTest, false);

  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    agents.replace(/（本项目做什么[\s\S]*?）/, "给自己用的记账小工具，跑在本地。"),
  );
  fs.mkdirSync(path.join(dir, "node_modules", "bosscoding"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test", "smoke.test.mjs"), "/* 最小产品测试 */\n");
  const after = probe(dir);
  assert.equal(after.intro, "filled");
  assert.equal(after.depsInstalled, true);
  assert.equal(after.hasProductTest, true);

  // 同名文件不是门禁：必须带 BossCoding 标记，且在 POSIX 上能被 Git 执行。
  const prePush = path.join(dir, ".git", "hooks", "pre-push");
  const originalHook = fs.readFileSync(prePush, "utf8");
  fs.writeFileSync(prePush, "#!/bin/sh\nexit 0\n");
  assert.equal(probe(dir).hooksReady, false);
  assert.deepEqual(probe(dir).missingHooks, ["pre-push"]);
  if (process.platform !== "win32") {
    fs.writeFileSync(prePush, originalHook);
    fs.chmodSync(prePush, 0o644);
    assert.equal(probe(dir).hooksReady, false);
    assert.deepEqual(probe(dir).missingHooks, ["pre-push"]);
  }
});

test("没有声明任何依赖时，不因 node_modules 不存在而要求安装", () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"plain","private":true}\n');
  const state = probe(dir);
  assert.equal(state.dependenciesRequired, false);
  assert.equal(state.depsInstalled, true);
});

test("手工合并过的自定义规则：三块核心标题齐全就视为 BossCoding 已就绪", () => {
  const dir = project();
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    "# 我的项目规则\n\n## 导师模式\n\n说人话。\n\n## 干活流程\n\n先检查。\n\n## 红线\n\n上线前确认。\n",
  );
  const state = probe(dir);
  assert.equal(state.intro, "custom");
  assert.equal(state.rulesReady, true);
});

test("缺本地门禁时，下一步只让 AI 用最新版全名恢复", () => {
  const dir = project();
  fs.rmSync(path.join(dir, ".git", "hooks", "post-checkout"));
  const { result, output } = capture(() => runStatus(dir));
  assert.equal(result, 0);
  const next = output.split("下一步：")[1];
  assert.match(next, /npx -y bosscoding@latest update/);
  assert.doesNotMatch(next, /npm install|提交一下|带我连上 GitHub/);
  assert.equal(output.match(/对 AI 说/g)?.length, 1, "缺门禁时不应同时派发第二个动作");
});

test("只读：跑一次 status 不产生任何文件变化", () => {
  const dir = project();
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  const unmute = mute();
  try {
    assert.equal(runStatus(dir), 0);
  } finally {
    unmute();
  }
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.equal(after, before);
});

test("不是版本库：明确失败并指路 init", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-status-norepo-"));
  const unmute = mute();
  try {
    assert.equal(runStatus(dir), 1);
  } finally {
    unmute();
  }
});

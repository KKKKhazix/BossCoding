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

function mute() {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = original.log;
    console.error = original.error;
  };
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

test("探测：没有远端＝本地阶段；加上远端＝第 1 阶", () => {
  const dir = project();
  assert.equal(probe(dir).rung, 0);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: dir, stdio: "ignore" });
  const after = probe(dir);
  assert.equal(after.rung, 1);
  assert.match(after.origin, /github\.com\/o\/r/);
});

test("探测：简介占位符与依赖缺失都要被看见（这两条是最高频的卡点）", () => {
  const dir = project();
  const before = probe(dir);
  assert.equal(before.intro, "placeholder");
  assert.equal(before.depsInstalled, false);
  assert.equal(before.hasPackageJson, true);

  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    agents.replace(/（本项目做什么[\s\S]*?）/, "给自己用的记账小工具，跑在本地。"),
  );
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  const after = probe(dir);
  assert.equal(after.intro, "filled");
  assert.equal(after.depsInstalled, true);
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

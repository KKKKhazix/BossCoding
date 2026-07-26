/**
 * init 端到端：空目录 → 筹备完成 → 守卫全绿。这是「加盟商旅程」的机器化版本。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInit } from "../lib/commands/init.mjs";
import { runCheck } from "../lib/commands/check.mjs";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "guiju-init-"));
}

/** 静音 console，返回恢复函数（init/check 输出很长，别刷测试日志）。 */
function muteConsole() {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = original.log;
    console.error = original.error;
  };
}

test("init：空目录一次装齐全部资产", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }

  for (const rel of [
    "AGENTS.md",
    "CLAUDE.md",
    ".github/workflows/guiju.yml",
    "docs/decisions/README.md",
    "docs/decisions/_template.md",
    ".agents/skills/guiju-flow/SKILL.md",
    ".gemini/settings.json",
    ".iflow/settings.json",
    ".gitignore",
    "package.json",
  ]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), `缺 ${rel}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.preflight, "guiju check");
  assert.equal(pkg.scripts.test, "node --test");
  assert.ok(pkg.devDependencies.guiju);

  // 门牌必须是 @ 导入桩，不是第二份真身。
  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes("@AGENTS.md"));

  // Claude 技能入口存在（软链或复制均可）。
  assert.ok(fs.existsSync(path.join(dir, ".claude/skills/guiju-flow/SKILL.md")), "缺 Claude 技能入口");
});

test("init：幂等——跑两次不覆盖、不重复追加", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    runInit(dir);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 店主已改过的店规\n\n自定义内容。\n");
    const gitignoreBefore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    runInit(dir);
    assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /店主已改过/);
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), gitignoreBefore);
  } finally {
    unmute();
  }
});

test("init 后 git add，守卫全绿（完整加盟商旅程）", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    runInit(dir);
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    assert.equal(runCheck(dir), 0);
  } finally {
    unmute();
  }
});

test("init：已有 package.json 只注入不重写", () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "existing",
        version: "2.0.0",
        scripts: { test: 'echo "Error: no test specified" && exit 1', dev: "vite" },
      },
      null,
      2,
    )}\n`,
  );
  const unmute = muteConsole();
  try {
    runInit(dir);
  } finally {
    unmute();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "existing");
  assert.equal(pkg.version, "2.0.0");
  assert.equal(pkg.scripts.dev, "vite");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts.preflight, "guiju check");
});

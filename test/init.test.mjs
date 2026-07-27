/**
 * init 端到端：空目录 → 筹备完成 → 守卫全绿。这是「老板开司旅程」的机器化版本。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInit, packageNameFrom, refuseReason } from "../lib/commands/init.mjs";
import { runCheck } from "../lib/commands/check.mjs";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-init-"));
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
    ".github/workflows/bosscoding.yml",
    "docs/decisions/README.md",
    "docs/decisions/_template.md",
    ".agents/skills/boss-flow/SKILL.md",
    ".agents/skills/boss-ladder/SKILL.md",
    ".gemini/settings.json",
    ".iflow/settings.json",
    ".gitignore",
    "package.json",
  ]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), `缺 ${rel}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.preflight, "boss check");
  assert.equal(pkg.scripts.test, "node --test");
  assert.ok(pkg.devDependencies.bosscoding);

  // 门牌必须是 @ 导入桩，不是第二份真身。
  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes("@AGENTS.md"));

  // Claude 技能入口必须是真实文件，不能是软链——软链在 Windows 上克隆后静默失效。
  for (const skill of ["boss-flow", "boss-ladder"]) {
    const entry = path.join(dir, ".claude/skills", skill);
    assert.ok(fs.existsSync(path.join(entry, "SKILL.md")), `缺 Claude 技能入口 ${skill}`);
    assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, `${skill} 不该是软链`);
  }

  // git hook 也归 init 装（细节与拦截行为见 hooks.test.mjs）。
  for (const name of ["pre-commit", "post-checkout", "pre-push"]) {
    assert.ok(fs.existsSync(path.join(dir, ".git/hooks", name)), `缺 git hook ${name}`);
  }
});

test("init：幂等——跑两次不覆盖、不重复追加", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    runInit(dir);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 老板已改过的规则文件\n\n自定义内容。\n");
    const gitignoreBefore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    runInit(dir);
    assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /老板已改过/);
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), gitignoreBefore);
  } finally {
    unmute();
  }
});

test("init 后 git add，守卫全绿（完整开司旅程）", () => {
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

test("init：中文文件夹名生成合法包名，不是一串连字符", () => {
  assert.equal(packageNameFrom("我的第一个产品"), "my-project");
  assert.equal(packageNameFrom("My App 2"), "my-app-2");
  assert.equal(packageNameFrom("记账-tool"), "tool");
  assert.equal(packageNameFrom(""), "my-project");

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cn-"));
  const dir = path.join(parent, "我的第一个产品");
  fs.mkdirSync(dir);
  const unmute = muteConsole();
  try {
    runInit(dir);
  } finally {
    unmute();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-project");
  assert.doesNotMatch(pkg.name, /^-|-$/, "包名不许以连字符开头或结尾（npm 非法）");
});

test("init：家目录与桌面这类「东西堆」一律拒绝开工，且不写任何文件", () => {
  // 判据是位置本身，不是文件数——已有项目接入时目录本来就文件很多。
  assert.ok(refuseReason(os.homedir()));
  assert.ok(refuseReason(path.join(os.homedir(), "Desktop")));
  assert.ok(refuseReason(path.join(os.homedir(), "桌面")));
  assert.equal(refuseReason(path.join(os.homedir(), "code", "我的产品")), null);

  const unmute = muteConsole();
  try {
    // 真的对家目录跑一次：必须返回 1。安全——它在写任何文件之前就退出了。
    assert.equal(runInit(os.homedir()), 1);
  } finally {
    unmute();
  }
  assert.equal(fs.existsSync(path.join(os.homedir(), "AGENTS.md")), false, "家目录里不该出现规则文件");
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
  assert.equal(pkg.scripts.preflight, "boss check");
});

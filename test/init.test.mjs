/**
 * init 端到端：空目录 → 筹备完成 → 守卫全绿。这是「老板开司旅程」的机器化版本。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runInit, packageNameFrom, refuseReason } from "../lib/commands/init.mjs";
import { runCheck } from "../lib/commands/check.mjs";

const CLI = fileURLToPath(new URL("../bin/bosscoding.mjs", import.meta.url));

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

function captureConsole(action) {
  const output = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => output.push(args.join(" "));
  try {
    return { result: action(), output: output.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
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

test("init：二次运行不把自己生成的 Gemini／iFlow 配置误报为待处理", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }

  const second = captureConsole(() => runInit(dir));
  assert.equal(second.result, 0);
  assert.doesNotMatch(second.output, /需要处理：/);
  assert.doesNotMatch(second.output, /\.gemini\/settings\.json：请在其中确认/);
  assert.doesNotMatch(second.output, /\.iflow\/settings\.json：请在其中确认/);
  assert.match(second.output, /BossCoding 就位/);
  assert.match(second.output, /下一步只做一件事/);
  assert.match(second.output, /npx -y bosscoding@latest status/);
  assert.doesNotMatch(second.output, /npx boss status/);
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

test("init：普通非空杂物目录拒绝开工，已有 Git 或源码的项目仍可安装", () => {
  const clutter = tmpProject();
  fs.writeFileSync(path.join(clutter, "家庭照片.jpg"), "not really a photo");
  const refused = captureConsole(() => runInit(clutter));
  assert.equal(refused.result, 1);
  assert.match(refused.output, /看不出这是一个产品项目/);
  assert.equal(fs.existsSync(path.join(clutter, ".git")), false);
  assert.equal(fs.existsSync(path.join(clutter, "package.json")), false);

  const gitProject = tmpProject();
  fs.writeFileSync(path.join(gitProject, "产品想法.pdf"), "notes");
  execFileSync("git", ["init", "-b", "main"], { cwd: gitProject, stdio: "ignore" });
  const gitUnmute = muteConsole();
  try {
    assert.equal(runInit(gitProject), 0);
  } finally {
    gitUnmute();
  }
  assert.ok(fs.existsSync(path.join(gitProject, "AGENTS.md")));

  const sourceProject = tmpProject();
  fs.writeFileSync(path.join(sourceProject, "main.py"), "print('hello')\n");
  const sourceUnmute = muteConsole();
  try {
    assert.equal(runInit(sourceProject), 0);
  } finally {
    sourceUnmute();
  }
  assert.ok(fs.existsSync(path.join(sourceProject, "AGENTS.md")));
});

test("init：没有 Git 时用人话失败，不显示程序堆栈", () => {
  const dir = tmpProject();
  const child = spawnSync(process.execPath, [CLI, "init"], {
    cwd: dir,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1);
  assert.match(output, /还没有 Git/);
  assert.match(output, /把这句话交给 AI/);
  assert.doesNotMatch(output, /spawnSync|node:child_process|\n\s+at /);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("init：已有非 BossCoding AGENTS.md 时保护原文，并给 AI 可直接执行的合并提示", () => {
  const dir = tmpProject();
  const rules = "# 我的项目规则\n\n所有按钮都要有中文说明。\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), rules);

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 0);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), rules);
  assert.doesNotMatch(captured.output, /BossCoding 就位。你是老板/);
  assert.match(captured.output, /暂不能宣布完全就位/);
  assert.match(captured.output, /请把这整句话交给 AI/);
  assert.match(captured.output, /保留 AGENTS\.md 里的全部现有规则/);
});

test("init：手工合并过核心规则的自定义 AGENTS 不会被反复催合并", () => {
  const dir = tmpProject();
  const rules =
    "# 我的项目规则\n\n## 导师模式\n大白话。\n\n## 干活流程\n先检查。\n\n## 红线\n先确认。\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), rules);

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 0);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), rules);
  assert.doesNotMatch(captured.output, /暂不能宣布完全就位|保留 AGENTS\.md 里的全部现有规则/);
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

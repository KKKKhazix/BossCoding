/**
 * 守卫单测。纪律（学自上游 aihot 的 baseline.test）：每个守卫必须有
 * 「守卫本身有效」自测——制造违规，断言必须被抓到。只测「干净时通过」
 * 的守卫等于没测：它可能永远返回空数组。
 *
 * 测试数据里的密钥样本一律拼接构造，避免样本本身被 secrets 守卫抓到。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createContext } from "../lib/context.mjs";
import secrets from "../lib/guards/secrets.mjs";
import envIgnored from "../lib/guards/env-ignored.mjs";
import execBits from "../lib/guards/exec-bits.mjs";
import rulesSingleSource from "../lib/guards/rules-single-source.mjs";
import rulesBudget from "../lib/guards/rules-budget.mjs";
import docLinks from "../lib/guards/doc-links.mjs";
import decisionFormat from "../lib/guards/decision-format.mjs";
import noBareTodo from "../lib/guards/no-bare-todo.mjs";

/** 造一个临时 git 仓库，写入 files 并 git add，返回守卫上下文。 */
function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  return createContext(dir);
}

const CLEAN_BASE = {
  ".gitignore": "node_modules/\n.env\n.env.local\n.env.*.local\n",
  "AGENTS.md": "# 项目规则\n\n正文。\n",
  "CLAUDE.md": "@AGENTS.md\n",
};

// ---- secrets ----

test("secrets：干净仓库通过", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, "app.js": "const x = process.env.API_KEY;\n" });
  assert.equal(secrets.run(ctx).length, 0);
});

test("secrets：抓 GitHub token", () => {
  const token = ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const ctx = makeRepo({ ...CLEAN_BASE, "config.js": `const t = "${token}";\n` });
  const problems = secrets.run(ctx);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, "config.js");
});

test("secrets：抓被追踪的 .env 文件", () => {
  // .gitignore 拦不住「已经进来的」：用 add -f 模拟历史上被强制提交的 .env。
  const ctx = makeRepo(CLEAN_BASE);
  fs.writeFileSync(path.join(ctx.root, ".env"), "API_KEY=whatever\n");
  execFileSync("git", ["add", "-f", ".env"], { cwd: ctx.root, stdio: "ignore" });
  const problems = secrets.run(ctx);
  assert.ok(problems.some((p) => p.file === ".env"));
});

test("secrets：.env.example 与占位符放行", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    ".env.example": "API_KEY=your-key-here\n",
    "doc.md": 'password = "example-placeholder-value-123456"\n',
  });
  assert.equal(secrets.run(ctx).length, 0);
});

test("secrets：boss-allow-secret 注释放行", () => {
  const token = ["ghp", "_"].join("") + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "fixture.js": `const sample = "${token}"; // 测试样本 boss-allow-secret\n`,
  });
  assert.equal(secrets.run(ctx).length, 0);
});

// ---- env-ignored ----

test("env-ignored：规则齐全通过", () => {
  const ctx = makeRepo(CLEAN_BASE);
  assert.equal(envIgnored.run(ctx).length, 0);
});

test("env-ignored：一行 .env* 也算覆盖", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, ".gitignore": "node_modules/\n.env*\n" });
  assert.equal(envIgnored.run(ctx).length, 0);
});

test("env-ignored：缺 .gitignore 规则必须红", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, ".gitignore": "node_modules/\n" });
  const problems = envIgnored.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].msg, /\.env/);
});

test("env-ignored：被追踪的 .env 必须红", () => {
  const ctx = makeRepo(CLEAN_BASE);
  fs.writeFileSync(path.join(ctx.root, ".env.local"), "SECRET=1\n");
  execFileSync("git", ["add", "-f", ".env.local"], { cwd: ctx.root, stdio: "ignore" });
  const problems = envIgnored.run(ctx);
  assert.ok(problems.some((p) => p.file === ".env.local"));
});

// ---- exec-bits ----

test("exec-bits：可执行的 .sh 通过", () => {
  const ctx = makeRepo(CLEAN_BASE);
  const abs = path.join(ctx.root, "run.sh");
  fs.writeFileSync(abs, "#!/bin/sh\necho ok\n");
  fs.chmodSync(abs, 0o755);
  execFileSync("git", ["add", "-A"], { cwd: ctx.root, stdio: "ignore" });
  assert.equal(execBits.run(ctx).length, 0);
});

test("exec-bits：缺可执行位必须红", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, "run.sh": "#!/bin/sh\necho ok\n" });
  const problems = execBits.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].fix, /update-index/);
});

// ---- rules-single-source ----

test("rules-single-source：AGENTS 真身＋CLAUDE 门牌通过", () => {
  const ctx = makeRepo(CLEAN_BASE);
  assert.equal(rulesSingleSource.run(ctx).length, 0);
});

test("rules-single-source：软链形态通过", () => {
  const ctx = makeRepo({ ".gitignore": CLEAN_BASE[".gitignore"], "AGENTS.md": "# 规则\n\n正文。\n" });
  fs.symlinkSync("AGENTS.md", path.join(ctx.root, "CLAUDE.md"));
  assert.equal(rulesSingleSource.run(ctx).length, 0);
});

test("rules-single-source：兼容反向形态（CLAUDE 真身）", () => {
  const ctx = makeRepo({ ".gitignore": CLEAN_BASE[".gitignore"], "CLAUDE.md": "# 规则\n\n正文。\n" });
  fs.symlinkSync("CLAUDE.md", path.join(ctx.root, "AGENTS.md"));
  assert.equal(rulesSingleSource.run(ctx).length, 0);
});

test("rules-single-source：两份真身必须红", () => {
  const ctx = makeRepo({
    ".gitignore": CLEAN_BASE[".gitignore"],
    "AGENTS.md": "# 规则甲\n\n正文。\n",
    "CLAUDE.md": "# 规则乙\n\n另一份正文。\n",
  });
  const problems = rulesSingleSource.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].msg, /分叉/);
});

test("rules-single-source：缺 AGENTS.md 必须红", () => {
  const ctx = makeRepo({ ".gitignore": CLEAN_BASE[".gitignore"] });
  const problems = rulesSingleSource.run(ctx);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, "AGENTS.md");
});

// ---- rules-budget ----

test("rules-budget：正常体积通过", () => {
  const ctx = makeRepo(CLEAN_BASE);
  assert.equal(rulesBudget.run(ctx).length, 0);
});

test("rules-budget：超 200 行必须红", () => {
  const fat = `# 规则\n${"- 一条规则\n".repeat(210)}`;
  const ctx = makeRepo({ ...CLEAN_BASE, "AGENTS.md": fat });
  const problems = rulesBudget.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].fix, /decisions/);
});

// ---- doc-links ----

test("doc-links：真实链接通过，外链不管", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "docs/guide.md": "见 [规则](../AGENTS.md) 与 [官网](https://example.com) 与 [锚点](#标题)。\n",
  });
  assert.equal(docLinks.run(ctx).length, 0);
});

test("doc-links：死链必须红", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, "README.md": "见 [不存在](docs/nope.md)。\n" });
  const problems = docLinks.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].msg, /nope\.md/);
});

test("doc-links：docs/decisions/ 的历史留痕不扫", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "docs/decisions/2026-01-01-old.md":
      "# 旧裁决（2026-01-01）\n\n## 影响\nx\n## 根因\nx\n## 裁决\nx\n## 被否决的方案\nx\n## 不变量\n当时引用过 [已删文件](../old-doc.md)。\n",
  });
  assert.equal(docLinks.run(ctx).length, 0);
});

// ---- decision-format ----

const FULL_DECISION =
  "# 某裁决（2026-07-26）\n\n## 影响\nx\n\n## 根因\nx\n\n## 裁决\nx\n\n## 被否决的方案\nx\n\n## 不变量\nx\n";

test("decision-format：五节齐全通过；README 与 _template 豁免", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "docs/decisions/2026-07-26-a.md": FULL_DECISION,
    "docs/decisions/README.md": "# 档案室\n",
    "docs/decisions/_template.md": "# 模板\n",
  });
  assert.equal(decisionFormat.run(ctx).length, 0);
});

test("decision-format：缺节必须红并点名缺哪节", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "docs/decisions/2026-07-26-b.md": "# 裁决\n\n## 影响\nx\n\n## 裁决\nx\n",
  });
  const problems = decisionFormat.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].msg, /根因/);
  assert.match(problems[0].msg, /被否决的方案/);
  assert.match(problems[0].msg, /不变量/);
});

// ---- no-bare-todo ----

test("no-bare-todo：干净文档通过；挂 issue 编号的放行", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "README.md": "正常内容。\n\nTODO: 支持深色模式，见 #12。\n",
  });
  assert.equal(noBareTodo.run(ctx).length, 0);
});

test("no-bare-todo：裸 TODO 必须红", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, "README.md": "TODO: 回头再说\n" });
  const problems = noBareTodo.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].fix, /issue/);
});

test("no-bare-todo：决策档案室不扫", () => {
  const ctx = makeRepo({
    ...CLEAN_BASE,
    "docs/decisions/2026-07-26-c.md": `${FULL_DECISION}\n当时留过 TODO: 后续观察。\n`,
  });
  assert.equal(noBareTodo.run(ctx).length, 0);
});

// ---- rules-budget：单行上限（issue #11 的症状检查） ----

test("rules-budget：超长单行只提醒不硬拦", () => {
  const long = `- ${"很长的一条规则".repeat(80)}`;
  const ctx = makeRepo({ ...CLEAN_BASE, "AGENTS.md": `# 项目规则\n\n${long}\n` });
  const problems = rulesBudget.run(ctx);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "warn");
  assert.equal(problems[0].line, 3);
});

test("rules-budget：正常长度的行不出声", () => {
  const ctx = makeRepo({ ...CLEAN_BASE, "AGENTS.md": "# 项目规则\n\n- 一条正常的规则。\n" });
  assert.deepEqual(rulesBudget.run(ctx), []);
});

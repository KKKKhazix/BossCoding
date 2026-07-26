/**
 * init：开店筹备队。把整套流程地基装进当前目录，幂等、绝不覆盖用户已有内容。
 *
 * 覆盖纪律：AGENTS.md 与 CLAUDE.md 是店主的店产，存在即跳过；
 * 框架管理的文件（CI、决策模板、技能）由 `guiju update` 负责刷新。
 * 执行者往往是 agent 而不是人，所以「跳过」时要打印出下一步该怎么办的指引。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const CLAUDE_STUB = `<!-- 规则真身在 AGENTS.md（单一规则源，由 guiju 守卫盯着）；本文件只是给 Claude Code 的门牌，不要在这里写规则。 -->\n@AGENTS.md\n`;

const NPM_DEFAULT_TEST = /^echo .Error: no test specified. && exit 1$/;

const GITIGNORE_LINES = ["node_modules/", ".env", ".env.local", ".env.*.local"];

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), "utf8");
}

function guijuVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATES, "..", "package.json"), "utf8"));
  return pkg.version;
}

export function runInit(root = process.cwd()) {
  const abs = path.resolve(root);
  const done = [];
  const skipped = [];
  const notes = [];

  const write = (rel, content) => {
    const target = path.join(abs, rel);
    if (fs.existsSync(target)) {
      skipped.push(rel);
      return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    done.push(rel);
    return true;
  };

  // 1. git 仓库兜底。
  let inRepo = false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: abs, stdio: "ignore" });
    inRepo = true;
  } catch {
    execFileSync("git", ["init", "-b", "main"], { cwd: abs, stdio: "ignore" });
    done.push("（git init，主干名 main）");
  }

  // 2. package.json：注入 preflight 与 guiju 依赖，替换 npm 默认的报错占位 test。
  const pkgPath = path.join(abs, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const name = path.basename(abs).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "my-project";
    fs.writeFileSync(
      pkgPath,
      `${JSON.stringify(
        {
          name,
          version: "0.1.0",
          private: true,
          scripts: { test: "node --test", preflight: "guiju check" },
          devDependencies: { guiju: `^${guijuVersion()}` },
        },
        null,
        2,
      )}\n`,
    );
    done.push("package.json");
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.scripts ??= {};
    let touched = false;
    if (!pkg.scripts.preflight) {
      pkg.scripts.preflight = "guiju check";
      touched = true;
    }
    if (pkg.scripts.test && NPM_DEFAULT_TEST.test(pkg.scripts.test)) {
      pkg.scripts.test = "node --test";
      touched = true;
    }
    pkg.devDependencies ??= {};
    if (!pkg.devDependencies.guiju && !pkg.dependencies?.guiju) {
      pkg.devDependencies.guiju = `^${guijuVersion()}`;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      done.push("package.json（注入 preflight／guiju 依赖）");
    } else {
      skipped.push("package.json");
    }
  }

  // 3. 店规与门牌。
  write("AGENTS.md", readTemplate("AGENTS.template.md"));
  if (!write("CLAUDE.md", CLAUDE_STUB)) {
    const existing = fs.readFileSync(path.join(abs, "CLAUDE.md"), "utf8");
    if (!existing.includes("@AGENTS.md") && !fs.lstatSync(path.join(abs, "CLAUDE.md")).isSymbolicLink()) {
      notes.push(
        "CLAUDE.md 已有独立内容：请把它的规则合并进 AGENTS.md，然后让 CLAUDE.md 只留一行 @AGENTS.md（守卫 rules-single-source 会盯着这件事）。",
      );
    }
  }

  // 4. 质检口与档案室。
  write(".github/workflows/guiju.yml", readTemplate("ci.yml"));
  write("docs/decisions/README.md", readTemplate("decisions-readme.md"));
  write("docs/decisions/_template.md", readTemplate("decision-template.md"));

  // 5. Gemini／iFlow 的规则文件指路配置（这两家默认不读 AGENTS.md）。
  if (!write(".gemini/settings.json", readTemplate("gemini-settings.json"))) {
    notes.push('已有 .gemini/settings.json：请在其中确认 context.fileName 含 "AGENTS.md"。');
  }
  if (!write(".iflow/settings.json", readTemplate("iflow-settings.json"))) {
    notes.push('已有 .iflow/settings.json：请在其中确认 contextFileName 含 "AGENTS.md"。');
  }

  // 6. 技能：本体放开放标准目录 .agents/skills，Claude 系目录用软链，链不动（Windows）就复制。
  const skillBody = readTemplate(path.join("skill", "SKILL.md"));
  write(".agents/skills/guiju-flow/SKILL.md", skillBody);
  const claudeSkillDir = path.join(abs, ".claude", "skills");
  const claudeSkill = path.join(claudeSkillDir, "guiju-flow");
  if (!fs.existsSync(claudeSkill)) {
    fs.mkdirSync(claudeSkillDir, { recursive: true });
    try {
      fs.symlinkSync(path.join("..", "..", ".agents", "skills", "guiju-flow"), claudeSkill, "junction");
      done.push(".claude/skills/guiju-flow（软链）");
    } catch {
      fs.mkdirSync(claudeSkill, { recursive: true });
      fs.writeFileSync(path.join(claudeSkill, "SKILL.md"), skillBody);
      done.push(".claude/skills/guiju-flow（复制，本系统不支持软链）");
    }
  } else {
    skipped.push(".claude/skills/guiju-flow");
  }

  // 7. .gitignore 幂等补行。
  const giPath = path.join(abs, ".gitignore");
  const current = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  const currentLines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !currentLines.has(l) && !currentLines.has(".env*"));
  if (missing.length > 0) {
    const block = `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}# guiju：依赖与密钥不进版本库\n${missing.join("\n")}\n`;
    fs.appendFileSync(giPath, block);
    done.push(`.gitignore（补 ${missing.length} 行）`);
  } else {
    skipped.push(".gitignore");
  }

  // 汇总。
  console.log(paint.bold("规矩（guiju）筹备完成。"));
  if (done.length) {
    console.log(`\n写入：`);
    for (const f of done) console.log(paint.green(`  + ${f}`));
  }
  if (skipped.length) {
    console.log(`\n已存在、未动：`);
    for (const f of skipped) console.log(paint.dim(`  = ${f}`));
  }
  if (notes.length) {
    console.log(`\n需要处理：`);
    for (const n of notes) console.log(paint.yellow(`  ! ${n}`));
  }
  console.log(`
下一步（给 AI 或店主）：
  1. npm install          安装依赖（含 guiju 本体）
  2. npx guiju check      守卫应当全绿
  3. 打开 AGENTS.md，把开头的项目简介填成三句大白话
  4. 对你的 AI 说：「读一遍 AGENTS.md，然后我们开工」${inRepo ? "" : "\n  （仓库刚刚初始化，别忘了首个 commit）"}`);
  return 0;
}

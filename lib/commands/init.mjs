/**
 * init：开司筹备队。把整套流程地基装进当前目录，幂等、绝不覆盖用户已有内容。
 *
 * 覆盖纪律：AGENTS.md 与 CLAUDE.md 是老板的规则，存在即跳过；
 * 框架管理的文件（CI、决策模板、技能）由 `npx boss update` 负责刷新。
 * 执行者往往是 agent 而不是人，所以「跳过」时要打印出下一步该怎么办的指引。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { installHooks } from "../hooks.mjs";
import { installSkills } from "../skills.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const CLAUDE_STUB = `<!-- 规则真身在 AGENTS.md（单一规则源，由 BossCoding 守卫盯着）；本文件只是给 Claude Code 的门牌，不要在这里写规则。 -->\n@AGENTS.md\n`;

const NPM_DEFAULT_TEST = /^echo .Error: no test specified. && exit 1$/;

const GITIGNORE_LINES = ["node_modules/", ".env", ".env.local", ".env.*.local"];

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), "utf8");
}

/**
 * 文件夹名 → 合法的 npm 包名。
 *
 * 实测踩过：老版本把每个非 ASCII 字符换成一个连字符，「我的第一个产品」变成了
 * 七个横杠——npm 规则里这不是合法名字，而且此后每条 npm 输出都顶着一串横杠。
 * 中文文件夹名对目标用户是常态，所以：非法字符整段折成一个连字符，掐掉首尾，
 * 全被掐光就退回一个老实的默认名。
 */
export function packageNameFrom(basename) {
  const name = (basename ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "my-project";
}

function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATES, "..", "package.json"), "utf8"));
  return pkg.version;
}

/**
 * 不许在这些地方开工：家目录本身，以及桌面／文档／下载这类「东西堆」。
 * 实测：在堆着简历、报税表的文件夹里 init 会一声不吭地把它变成版本库，
 * 之后一次 `git add -A` 就把私人文件全收进去了。执行者常常是 agent，
 * 而 agent 的当前目录很可能就是家目录——这不是边缘情况。
 */
const FORBIDDEN_BASENAMES = new Set([
  "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", "Public",
  "桌面", "文档", "下载", "图片", "音乐", "影片",
]);

export function refuseReason(abs) {
  const home = os.homedir();
  if (abs === home) return "这是你的用户主目录（家目录）";
  if (abs === path.parse(abs).root) return "这是磁盘根目录";
  if (path.dirname(abs) === home && FORBIDDEN_BASENAMES.has(path.basename(abs))) {
    return `这是系统的「${path.basename(abs)}」文件夹，是东西堆不是项目`;
  }
  return null;
}

export function runInit(root = process.cwd()) {
  const abs = path.resolve(root);
  const done = [];
  const skipped = [];
  const notes = [];

  const refuse = refuseReason(abs);
  if (refuse) {
    console.error(paint.red(`✗ 不能在这里开工：${refuse}。`));
    console.error("  把整个文件夹变成代码仓库之后，一次全量提交就会把里面的私人文件一起收走。");
    console.error("  这么做：先建一个只放这个产品的新文件夹，进去再跑一次。例如");
    console.error("      mkdir ~/我的产品 && cd ~/我的产品");
    return 1;
  }

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

  // 2. package.json：注入 preflight 与 bosscoding 依赖，替换 npm 默认的报错占位 test。
  const pkgPath = path.join(abs, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const name = packageNameFrom(path.basename(abs));
    fs.writeFileSync(
      pkgPath,
      `${JSON.stringify(
        {
          name,
          version: "0.1.0",
          private: true,
          scripts: { test: "node --test", preflight: "boss check" },
          devDependencies: { bosscoding: `^${packageVersion()}` },
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
      pkg.scripts.preflight = "boss check";
      touched = true;
    }
    if (pkg.scripts.test && NPM_DEFAULT_TEST.test(pkg.scripts.test)) {
      pkg.scripts.test = "node --test";
      touched = true;
    }
    pkg.devDependencies ??= {};
    if (!pkg.devDependencies.bosscoding && !pkg.dependencies?.bosscoding) {
      pkg.devDependencies.bosscoding = `^${packageVersion()}`;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      done.push("package.json（注入 preflight／bosscoding 依赖）");
    } else {
      skipped.push("package.json");
    }
  }

  // 3. 规则真身与门牌。
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
  write(".github/workflows/bosscoding.yml", readTemplate("ci.yml"));
  write("docs/decisions/README.md", readTemplate("decisions-readme.md"));
  write("docs/decisions/_template.md", readTemplate("decision-template.md"));

  // 5. Gemini／iFlow 的规则文件指路配置（这两家默认不读 AGENTS.md）。
  if (!write(".gemini/settings.json", readTemplate("gemini-settings.json"))) {
    notes.push('已有 .gemini/settings.json：请在其中确认 context.fileName 含 "AGENTS.md"。');
  }
  if (!write(".iflow/settings.json", readTemplate("iflow-settings.json"))) {
    notes.push('已有 .iflow/settings.json：请在其中确认 contextFileName 含 "AGENTS.md"。');
  }

  // 6. 技能（交付流程 boss-flow ＋ 四阶梯 boss-ladder）：安装逻辑与 update 共用。
  const skills = installSkills(abs);
  done.push(...skills.created);
  skipped.push(...skills.skipped);

  // 7. .gitignore 幂等补行。
  const giPath = path.join(abs, ".gitignore");
  const current = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  const currentLines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !currentLines.has(l) && !currentLines.has(".env*"));
  if (missing.length > 0) {
    const block = `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}# BossCoding：依赖与密钥不进版本库\n${missing.join("\n")}\n`;
    fs.appendFileSync(giPath, block);
    done.push(`.gitignore（补 ${missing.length} 行）`);
  } else {
    skipped.push(".gitignore");
  }

  // 8. git hook 本地门禁：并行时主工作区只跑主干；禁止直推主干（细节见 templates/hooks/）。
  const hooks = installHooks(abs);
  if (hooks.installed.length > 0) {
    done.push(`git hook：${hooks.installed.join("、")}（本地门禁：并行时主工作区只跑主干＋禁止直推主干）`);
  }
  if (hooks.skipped.length > 0) {
    notes.push(
      `已有别人的 git hook（${hooks.skipped.join("、")}），未覆盖：想要 BossCoding 的本地门禁，请把 ${path.join(TEMPLATES, "hooks")} 下对应脚本的内容并进你现有的 hook。`,
    );
  }

  // 汇总。
  console.log(paint.bold("BossCoding 就位。你是老板：需求你说，制度盯人。"));
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
  // 结尾指引只说真话：有待处理事项时不许承诺「应当全绿」（实测：已有 CLAUDE.md 的
  // 项目装完必红，而旧文案还在说全绿，新人第一眼就是红叉加一句被打脸的承诺）。
  console.log(`
下一步：
  1. npm install                安装干活要用的工具（不装的话，自检命令会说「命令找不到」）
  2. ${notes.length > 0 ? "先按上面「需要处理」逐条改完" : "npm run preflight        跑一遍自检"}
  3. 对你的 AI 说：「读一遍 AGENTS.md。之后需求我说，规矩你守。」
     ——它会陪你把项目简介填好，然后问你想做个什么。${inRepo ? "" : "\n  （版本库刚建好，第一次提交交给 AI，你不用管）"}

任何时候不知道自己在哪一步：npx boss status`);
  return 0;
}

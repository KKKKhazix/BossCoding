/**
 * update：刷新「由 BossCoding 管理」的文件到当前包版本。
 *
 * 边界（守约）：规则真身 AGENTS.md 与门牌 CLAUDE.md 是老板的规则，本命令永不碰——
 * 「背后实时更新」只更新工具与质检，不远程改任何人的规则。模板有大改时，
 * 这里只打印新模板的位置，由老板（和他的 AI）自己对照决定要不要采纳。
 *
 * 技能与 git hook 允许「补装」而不只是刷新：新版本可能新增技能或门禁，
 * 只刷新已有文件的话，老用户永远拿不到新的。补装只对已装过 BossCoding 的
 * 项目做（认 AGENTS.md 或质检口文件），免得在别人的仓库里凭空长出文件。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { installHooks } from "../hooks.mjs";
import { installSkills } from "../skills.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const MANAGED = [
  [".github/workflows/bosscoding.yml", "ci.yml"],
  ["docs/decisions/_template.md", "decision-template.md"],
];

export function runUpdate(root = process.cwd()) {
  const abs = path.resolve(root);
  let refreshed = 0;

  for (const [rel, tpl] of MANAGED) {
    const target = path.join(abs, rel);
    if (!fs.existsSync(target)) continue;
    const next = fs.readFileSync(path.join(TEMPLATES, tpl), "utf8");
    if (fs.readFileSync(target, "utf8") === next) continue;
    fs.writeFileSync(target, next);
    console.log(paint.green(`↻ ${rel}`));
    refreshed += 1;
  }

  const installed = fs.existsSync(path.join(abs, "AGENTS.md")) || fs.existsSync(path.join(abs, ".github/workflows/bosscoding.yml"));

  if (installed) {
    const skills = installSkills(abs);
    for (const rel of skills.created) {
      console.log(paint.green(`+ ${rel}（本版新增的技能）`));
      refreshed += 1;
    }
    for (const rel of [...skills.linked, ...skills.copied]) {
      console.log(paint.green(`+ ${rel}（技能入口）`));
      refreshed += 1;
    }
    for (const rel of skills.refreshed) {
      console.log(paint.green(`↻ ${rel}`));
      refreshed += 1;
    }

    // git hook 不进版本库，clone 出来的副本天生是裸的——这里补装。
    const hooks = installHooks(abs);
    for (const name of [...hooks.installed, ...hooks.refreshed]) {
      console.log(paint.green(`↻ .git/hooks/${name}（本地门禁）`));
      refreshed += 1;
    }
    if (hooks.skipped.length > 0) {
      console.log(paint.yellow(`! 已有别人的 git hook（${hooks.skipped.join("、")}），未覆盖。`));
    }
  }

  if (refreshed === 0) {
    console.log("框架管理的文件已是当前版本，无需刷新。");
  } else {
    console.log(`\n共刷新 ${refreshed} 个文件。`);
  }
  console.log(
    paint.dim(
      `你的 AGENTS.md 从不被本命令改动；想对照最新规则模板：${path.join(TEMPLATES, "AGENTS.template.md")}`,
    ),
  );
  return 0;
}

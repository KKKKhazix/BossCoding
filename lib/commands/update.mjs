/**
 * update：刷新「由 BossCoding 管理」的文件到当前包版本。
 *
 * 边界（守约）：规则真身 AGENTS.md 与门牌 CLAUDE.md 是老板的规则，本命令永不碰——
 * 「背后实时更新」只更新工具与质检，不远程改任何人的规则。模板有大改时，
 * 这里只打印新模板的位置，由老板（和他的 AI）自己对照决定要不要采纳。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { installHooks } from "../hooks.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const MANAGED = [
  [".github/workflows/bosscoding.yml", "ci.yml"],
  ["docs/decisions/_template.md", "decision-template.md"],
  [".agents/skills/boss-flow/SKILL.md", path.join("skill", "SKILL.md")],
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

  // 复制形态的 Claude 技能镜像（软链形态自动跟随本体，无需处理）。
  const mirror = path.join(abs, ".claude", "skills", "boss-flow", "SKILL.md");
  if (fs.existsSync(mirror) && !fs.lstatSync(path.dirname(mirror)).isSymbolicLink()) {
    const next = fs.readFileSync(path.join(TEMPLATES, "skill", "SKILL.md"), "utf8");
    if (fs.readFileSync(mirror, "utf8") !== next) {
      fs.writeFileSync(mirror, next);
      console.log(paint.green("↻ .claude/skills/boss-flow/SKILL.md（复制镜像）"));
      refreshed += 1;
    }
  }

  // git hook 不进版本库，clone 出来的副本天生是裸的——这里补装，所以「不存在也写」。
  // 只对已经装过 BossCoding 的项目做，免得在别人的仓库里凭空长出 hook。
  if (fs.existsSync(path.join(abs, "AGENTS.md")) || fs.existsSync(path.join(abs, ".github/workflows/bosscoding.yml"))) {
    const hooks = installHooks(abs);
    for (const name of [...hooks.installed, ...hooks.refreshed]) {
      console.log(paint.green(`↻ .git/hooks/${name}（主工作区只跑 main）`));
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

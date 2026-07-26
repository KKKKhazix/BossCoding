/**
 * update：刷新「由 guiju 管理」的文件到当前包版本。
 *
 * 边界（守约）：店规 AGENTS.md 与门牌 CLAUDE.md 是店主的店产，本命令永不碰——
 * 「背后实时更新」只更新工具与质检，不远程改任何人的规则。模板有大改时，
 * 这里只打印新模板的位置，由店主（和他的 AI）自己对照决定要不要采纳。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const MANAGED = [
  [".github/workflows/guiju.yml", "ci.yml"],
  ["docs/decisions/_template.md", "decision-template.md"],
  [".agents/skills/guiju-flow/SKILL.md", path.join("skill", "SKILL.md")],
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
  const mirror = path.join(abs, ".claude", "skills", "guiju-flow", "SKILL.md");
  if (fs.existsSync(mirror) && !fs.lstatSync(path.dirname(mirror)).isSymbolicLink()) {
    const next = fs.readFileSync(path.join(TEMPLATES, "skill", "SKILL.md"), "utf8");
    if (fs.readFileSync(mirror, "utf8") !== next) {
      fs.writeFileSync(mirror, next);
      console.log(paint.green("↻ .claude/skills/guiju-flow/SKILL.md（复制镜像）"));
      refreshed += 1;
    }
  }

  if (refreshed === 0) {
    console.log("框架管理的文件已是当前版本，无需刷新。");
  } else {
    console.log(`\n共刷新 ${refreshed} 个文件。`);
  }
  console.log(
    paint.dim(
      `店规 AGENTS.md 从不被本命令改动；想对照最新店规模板：${path.join(TEMPLATES, "AGENTS.template.md")}`,
    ),
  );
  return 0;
}

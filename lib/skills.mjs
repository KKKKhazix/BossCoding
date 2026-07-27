/**
 * 技能安装：本体放开放标准目录 .agents/skills，Claude 系目录用软链，
 * 链不动（Windows 无权限时）就复制。init 与 update 共用——update 需要它，
 * 是因为新版本可能新增技能：只刷新已有文件的话，老用户永远拿不到新技能。
 *
 * 边界：技能是框架管理的文件（老板的规则在 AGENTS.md，不在这里），
 * 所以允许创建缺失的、刷新改过的；别人手写的同名技能没有我们的 front matter
 * 标记时不动——与 git hook 的认领纪律同一套。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = path.join(fileURLToPath(new URL("../", import.meta.url)), "templates");

export const SKILLS = ["boss-flow", "boss-ladder"];

/** 认领判据：front matter 里的 name 是我们的技能名，才允许刷新。 */
function ownedByUs(text, skill) {
  return text.includes(`name: ${skill}`);
}

/**
 * 幂等安装。返回 { created, refreshed, linked, copied, skipped }，
 * 全部是项目内相对路径数组，由调用方决定怎么汇报。
 */
export function installSkills(root) {
  const abs = path.resolve(root);
  const result = { created: [], refreshed: [], linked: [], copied: [], skipped: [] };

  for (const skill of SKILLS) {
    const body = fs.readFileSync(path.join(TEMPLATES, "skills", skill, "SKILL.md"), "utf8");
    const rel = `.agents/skills/${skill}/SKILL.md`;
    const target = path.join(abs, rel);

    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      result.created.push(rel);
    } else {
      const current = fs.readFileSync(target, "utf8");
      if (!ownedByUs(current, skill)) {
        result.skipped.push(rel);
      } else if (current !== body) {
        fs.writeFileSync(target, body);
        result.refreshed.push(rel);
      }
    }

    // Claude 系入口：软链目录自动跟随本体；复制形态需要单独创建与刷新。
    const claudeRel = `.claude/skills/${skill}`;
    const claudeSkill = path.join(abs, claudeRel);
    if (!fs.existsSync(claudeSkill)) {
      fs.mkdirSync(path.join(abs, ".claude", "skills"), { recursive: true });
      try {
        fs.symlinkSync(path.join("..", "..", ".agents", "skills", skill), claudeSkill, "junction");
        result.linked.push(claudeRel);
      } catch {
        fs.mkdirSync(claudeSkill, { recursive: true });
        fs.writeFileSync(path.join(claudeSkill, "SKILL.md"), body);
        result.copied.push(claudeRel);
      }
    } else if (!fs.lstatSync(claudeSkill).isSymbolicLink()) {
      const mirror = path.join(claudeSkill, "SKILL.md");
      if (fs.existsSync(mirror)) {
        const current = fs.readFileSync(mirror, "utf8");
        if (ownedByUs(current, skill) && current !== body) {
          fs.writeFileSync(mirror, body);
          result.refreshed.push(`${claudeRel}/SKILL.md`);
        }
      }
    }
  }

  return result;
}

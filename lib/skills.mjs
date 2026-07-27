/**
 * 技能安装：本体放开放标准目录 .agents/skills，Claude 系目录 .claude/skills 放一份副本。
 * init 与 update 共用——update 需要它，是因为新版本可能新增技能：只刷新已有文件的话，
 * 老用户永远拿不到新技能。
 *
 * 为什么是复制而不是软链（实测事故）：软链会被提交进版本库（mode 120000），
 * 而 Windows 默认不支持软链，克隆下来会变成一个写着路径的文本文件——两个技能
 * 同时静默失效，且现象是「AI 就是不按规矩走」，没人查得到根因。
 * 副本的代价是同一份内容存两处，由本模块负责保持一致；这个代价比静默失效小得多。
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

/** 写一份技能副本；返回 "created" | "refreshed" | "skipped" | null（无需动作）。 */
function place(target, body, skill) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return "created";
  }
  const current = fs.readFileSync(target, "utf8");
  if (!ownedByUs(current, skill)) return "skipped";
  if (current === body) return null;
  fs.writeFileSync(target, body);
  return "refreshed";
}

/**
 * 幂等安装。返回 { created, refreshed, skipped, migrated }，全部是项目内相对路径数组。
 * migrated：把旧版本留下的软链换成了真实副本（跨平台修复，见文件头）。
 */
export function installSkills(root) {
  const abs = path.resolve(root);
  const result = { created: [], refreshed: [], skipped: [], migrated: [] };

  for (const skill of SKILLS) {
    const body = fs.readFileSync(path.join(TEMPLATES, "skills", skill, "SKILL.md"), "utf8");

    for (const base of [".agents/skills", ".claude/skills"]) {
      const dir = path.join(abs, base, skill);
      const rel = `${base}/${skill}/SKILL.md`;

      // 旧版本在 .claude/skills 下装的是目录软链：拆掉换成真实副本。
      const linkStat = fs.existsSync(path.join(abs, base, skill)) ? fs.lstatSync(path.join(abs, base, skill)) : null;
      if (linkStat?.isSymbolicLink()) {
        fs.unlinkSync(dir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), body);
        result.migrated.push(rel);
        continue;
      }

      const outcome = place(path.join(dir, "SKILL.md"), body, skill);
      if (outcome === "created") result.created.push(rel);
      else if (outcome === "refreshed") result.refreshed.push(rel);
      else if (outcome === "skipped") result.skipped.push(rel);
    }
  }

  return result;
}

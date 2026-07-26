/**
 * 规则单一真身守卫：AGENTS.md 与 CLAUDE.md 必须是「一份真身＋一块门牌」。
 *
 * 防的坑：两份规则文件各自演化，不同 agent 读到互相矛盾的规矩，行为全看运气。
 *
 * 认可的形态（满足其一即可）：
 * - 推荐：AGENTS.md 为真身，CLAUDE.md 是指向它的软链，或内容仅为一行 `@AGENTS.md` 导入
 *   （@ 导入是 Claude Code 官方语法，Windows 上比软链稳）；
 * - 兼容：CLAUDE.md 为真身，AGENTS.md 是指向它的软链（存量项目的反向形态）。
 */

import fs from "node:fs";
import path from "node:path";

function isImportStub(text, target) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length > 6) return false;
  const hasImport = lines.some((l) => l.trim() === `@${target}`);
  const hasOwnBody = lines.some((l) => /^#{1,3}\s/.test(l.trim()));
  return hasImport && !hasOwnBody;
}

function linkTarget(ctx, rel) {
  const stat = ctx.lstat(rel);
  if (!stat || !stat.isSymbolicLink()) return null;
  return fs.readlinkSync(path.join(ctx.root, rel));
}

export default {
  name: "rules-single-source",
  title: "规则只有一份真身",
  run(ctx) {
    const problems = [];
    const hasAgents = ctx.exists("AGENTS.md");
    const hasClaude = ctx.exists("CLAUDE.md");

    if (!hasAgents) {
      problems.push({
        file: "AGENTS.md",
        msg: "缺少 AGENTS.md（各家 coding agent 共同认的规则文件）",
        fix: "运行 npx bosscoding init 生成规则文件；已有规则写在 CLAUDE.md 的话，把它重命名为 AGENTS.md，再让 CLAUDE.md 指回来。",
      });
      return problems;
    }

    const agentsIsLink = ctx.lstat("AGENTS.md")?.isSymbolicLink() ?? false;

    if (!hasClaude) {
      problems.push({
        file: "CLAUDE.md",
        msg: "缺少 CLAUDE.md 门牌，Claude Code（含套壳接国产模型的用户）读不到规则",
        fix: "创建 CLAUDE.md，内容一行 `@AGENTS.md`（npx bosscoding init 会自动生成）。",
      });
      return problems;
    }

    // 形态 A：AGENTS.md 真身。
    if (!agentsIsLink) {
      const claudeStat = ctx.lstat("CLAUDE.md");
      if (claudeStat.isSymbolicLink()) {
        const target = linkTarget(ctx, "CLAUDE.md");
        if (target !== "AGENTS.md") {
          problems.push({
            file: "CLAUDE.md",
            msg: `软链指向 ${target}，不是 AGENTS.md`,
            fix: "把 CLAUDE.md 重建为指向 AGENTS.md 的软链，或改为内容仅一行 `@AGENTS.md` 的文件。",
          });
        }
        return problems;
      }
      if (!isImportStub(ctx.readText("CLAUDE.md"), "AGENTS.md")) {
        problems.push({
          file: "CLAUDE.md",
          msg: "CLAUDE.md 与 AGENTS.md 各自有正文——两份规则必然分叉",
          fix: "选一份当真身（推荐 AGENTS.md），把另一份的独有内容合并过去，然后让 CLAUDE.md 只留一行 `@AGENTS.md`。",
        });
      }
      return problems;
    }

    // 形态 B（兼容存量）：AGENTS.md 是软链，则它必须指向 CLAUDE.md 真身。
    const target = linkTarget(ctx, "AGENTS.md");
    if (target !== "CLAUDE.md") {
      problems.push({
        file: "AGENTS.md",
        msg: `AGENTS.md 是软链但指向 ${target}，不是 CLAUDE.md`,
        fix: "让软链指向 CLAUDE.md，或倒转形态：AGENTS.md 当真身、CLAUDE.md 留一行 `@AGENTS.md`。",
      });
    }
    return problems;
  },
};

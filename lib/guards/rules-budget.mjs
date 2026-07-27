/**
 * 规则体积守卫：真身规则文件 ≤ 200 行且 ≤ 10KB。
 *
 * 防的坑：规则文件是每次会话都被完整读入的「宪法」，它膨胀的斜率惊人
 * （上游 aihot 实测：一次人工瘦身 9 天后反弹 30%，日常每天被改约 5 次）。
 * 体积超标不是「写多了」，而是「放错了」——能机器查的应该进守卫，
 * 为什么这么定的应该进 docs/decisions/，现状快照应该删掉改为跑命令看。
 *
 * 单行上限（issue #11）：膨胀的规则文件不只是难读，它会**自相矛盾**。实测那次，
 * 相邻两行一条教人 `gh pr ready && gh pr merge --auto`、下一条说「不是自己 gh pr ready」，
 * agent 读到哪条全看运气。根因是每条规则都夹带一段「为什么」的论证，而论证已经
 * 完整存在于 decisions 里——同一件事写两遍，长的那遍压着短的那遍。行长是这件事
 * 最好查的症状：那次瘦身前最长一行 662 字符，瘦身后 433。
 */

const MAX_LINES = 200;
const MAX_BYTES = 10 * 1024;
const MAX_LINE_CHARS = 500;

export default {
  name: "rules-budget",
  title: "规则文件不膨胀",
  run(ctx) {
    // 真身可能是 AGENTS.md（推荐）或 CLAUDE.md（兼容形态），取非软链的那份。
    const body = ["AGENTS.md", "CLAUDE.md"].find((f) => {
      const stat = ctx.lstat(f);
      return stat && !stat.isSymbolicLink();
    });
    if (!body) return [];

    const text = ctx.readText(body);
    // @ 导入门牌不是真身，不设预算。
    if (text.length < 300 && text.includes("@AGENTS.md")) return [];

    const bytes = Buffer.byteLength(text);
    const all = text.split(/\r?\n/);
    const lines = text.length === 0 ? 0 : all.length;

    const problems = [];
    if (lines > MAX_LINES || bytes > MAX_BYTES) {
      problems.push({
        file: body,
        msg: `${lines} 行／${(bytes / 1024).toFixed(1)}KB，超出预算（≤${MAX_LINES} 行且 ≤${MAX_BYTES / 1024}KB）`,
        fix: "膨胀说明有内容放错了位置：能机器查的写成守卫；「为什么这么定」写进 docs/decisions/（只追加）；现状快照删掉，改为写「跑哪条命令能看到」。",
      });
    }
    for (let i = 0; i < all.length; i++) {
      if (all[i].length <= MAX_LINE_CHARS) continue;
      problems.push({
        file: body,
        line: i + 1,
        level: "warn",
        msg: `单行 ${all[i].length} 字符，超过 ${MAX_LINE_CHARS}——这么长的一条规则通常是「结论＋论证」挤在了一起`,
        fix: "规则正文只写「做什么」，「为什么这么定」搬进 docs/decisions/ 并在正文留一句结论。夹带论证的长规则会长出自相矛盾的相邻两条，agent 读到哪条全看运气。",
      });
    }
    return problems;
  },
};

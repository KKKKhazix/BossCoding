/**
 * 规则体积守卫：真身规则文件 ≤ 200 行且 ≤ 10KB。
 *
 * 防的坑：规则文件是每次会话都被完整读入的「宪法」，它膨胀的斜率惊人
 * （上游 aihot 实测：一次人工瘦身 9 天后反弹 30%，日常每天被改约 5 次）。
 * 体积超标不是「写多了」，而是「放错了」——能机器查的应该进守卫，
 * 为什么这么定的应该进 docs/decisions/，现状快照应该删掉改为跑命令看。
 */

const MAX_LINES = 200;
const MAX_BYTES = 10 * 1024;

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
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    if (lines <= MAX_LINES && bytes <= MAX_BYTES) return [];

    return [
      {
        file: body,
        msg: `${lines} 行／${(bytes / 1024).toFixed(1)}KB，超出预算（≤${MAX_LINES} 行且 ≤${MAX_BYTES / 1024}KB）`,
        fix: "膨胀说明有内容放错了位置：能机器查的写成守卫；「为什么这么定」写进 docs/decisions/（只追加）；现状快照删掉，改为写「跑哪条命令能看到」。",
      },
    ];
  },
};

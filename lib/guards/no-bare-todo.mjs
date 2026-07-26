/**
 * 裸待办守卫：现役文档里不许留没有归属的 TODO／FIXME。
 *
 * 防的坑：文档里的待办没有执行者、没有期限、没有提醒——它唯一的结局是烂在原地，
 * 并且让后来的读者以为「有人正在管这件事」。要么现在做掉，要么挂上 issue 编号，
 * 要么删掉。
 *
 * 误报纪律：只抓 `TODO:`／`FIXME:` 这类强信号；带 issue 引用（#123）或链接的不算裸。
 * 代码里的 TODO 不归本守卫管（那是代码审查的事），只扫现役文档。
 * docs/decisions/ 不扫——历史留痕不维护。
 */

const BARE = /\b(TODO|FIXME)\s*[:：]/;
const OWNED = /#\d+|https?:\/\//;

export default {
  name: "no-bare-todo",
  title: "现役文档无裸待办",
  run(ctx) {
    const docs = ctx
      .trackedFiles()
      .filter(
        (f) =>
          f === "README.md" ||
          f === "AGENTS.md" ||
          (f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/decisions/")),
      );

    const problems = [];
    for (const doc of docs) {
      const text = ctx.readTextIfSmallText(doc);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (BARE.test(lines[i]) && !OWNED.test(lines[i])) {
          problems.push({
            file: doc,
            line: i + 1,
            msg: "裸待办（没有 issue 编号或链接归属）",
            fix: "三选一：现在做掉；开成 issue 并在此挂 #编号；删掉这一行——文档里的裸待办永远不会被做。",
          });
        }
      }
    }
    return problems;
  },
};

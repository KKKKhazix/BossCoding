/**
 * 文档链接守卫：现役文档里的仓库内相对链接必须指向真实存在的文件。
 *
 * 防的坑：文档是协作入口，路径失效＝导航可见但无法落地——比没有导航更糟，
 * 因为读者（人或 agent）会顺着死链去做一件做不到的事。
 *
 * 扫描面：README.md、AGENTS.md、docs/ 下的 .md（不含 docs/decisions/——
 * 决策记录是只追加的历史留痕，引用当时的路径是正常的，历史不需要维护）。
 */

import path from "node:path";

const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isExternal(target) {
  return /^(https?:|mailto:|#|\/|[a-z]+:\/\/)/i.test(target);
}

export default {
  name: "doc-links",
  title: "文档链接不指向不存在的文件",
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
        let match;
        LINK.lastIndex = 0;
        while ((match = LINK.exec(lines[i])) !== null) {
          const rawTarget = match[1];
          if (isExternal(rawTarget)) continue;
          const target = decodeURIComponent(rawTarget.split("#")[0]);
          if (!target) continue;
          const resolved = path.join(path.dirname(doc), target);
          if (!ctx.exists(resolved)) {
            problems.push({
              file: doc,
              line: i + 1,
              msg: `链接指向不存在的路径：${rawTarget}`,
              fix: "改成真实存在的路径，或删掉这条链接——死链会把读者送进死胡同。",
            });
          }
        }
      }
    }
    return problems;
  },
};

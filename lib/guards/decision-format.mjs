/**
 * 决策格式守卫：docs/decisions/ 里的每篇决策必须含五节。
 *
 * 五节是这套框架的招牌格式：影响 → 根因 → 裁决 → 被否决的方案 → 不变量。
 * 它防的是决策记录最常见的死法——写成事后合理化：只记「我们决定了 X」，
 * 不记当时的代价对比，半年后没人知道该不该推翻它。
 * 「被否决的方案」逼你留下对比，「不变量」逼你写清什么必须永远为真。
 *
 * 豁免：README.md（目录说明）、下划线开头（_template.md 等模板）。
 */

const SECTIONS = [
  ["影响", /^##\s*(用户)?影响/m],
  ["根因", /^##\s*根因/m],
  ["裁决", /^##\s*裁决/m],
  ["被否决的方案", /^##\s*被否决的方案/m],
  ["不变量", /^##\s*不变量/m],
];

export default {
  name: "decision-format",
  title: "决策记录五节齐全",
  run(ctx) {
    const files = ctx
      .trackedFiles()
      .filter(
        (f) =>
          f.startsWith("docs/decisions/") &&
          f.endsWith(".md") &&
          !/(^|\/)README\.md$/.test(f) &&
          !/(^|\/)_[^/]*$/.test(f),
      );

    const problems = [];
    for (const file of files) {
      const text = ctx.readTextIfSmallText(file);
      if (text === null) continue;
      const missing = SECTIONS.filter(([, re]) => !re.test(text)).map(([name]) => name);
      if (missing.length > 0) {
        problems.push({
          file,
          msg: `缺少小节：${missing.join("、")}`,
          fix: "按 docs/decisions/_template.md 补齐五节（影响／根因／裁决／被否决的方案／不变量）；已定稿的旧篇目只追加不修改，新裁决另开新篇。",
        });
      }
    }
    return problems;
  },
};

/**
 * .env 隔离守卫：密钥的家必须在版本库外面。
 *
 * 两条断言：
 * 1. .gitignore 必须覆盖 .env、.env.local、.env.*.local（一行 `.env*` 也算覆盖）；
 * 2. git 里不得已经追踪任何 .env 系文件（.env.example 等模板除外）。
 *
 * 第 2 条单独存在的理由：.gitignore 只拦「还没进来的」，拦不住「已经进来的」——
 * 一个先被 add 再补 ignore 的 .env 会一直静默地跟着仓库走。
 */

const ENV_TRACKED = /(^|\/)\.env($|\.(?!example$|sample$|template$))/i;
const REQUIRED = [".env", ".env.local", ".env.*.local"];

function gitignoreCovers(lines, target) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === ".env*" || line === "**/.env*" || line === target || line === `**/${target}`) {
      return true;
    }
  }
  return false;
}

export default {
  name: "env-ignored",
  title: ".env 被忽略且未被追踪",
  run(ctx) {
    const problems = [];

    const tracked = ctx.trackedFiles().filter((f) => ENV_TRACKED.test(f));
    for (const file of tracked) {
      problems.push({
        file,
        msg: ".env 系文件已被 git 追踪，里面的每个值都应视为已泄露",
        fix: "git rm --cached 该文件（工作区保留），确认 .gitignore 覆盖后重新提交；已 push 过的密钥必须轮换。",
      });
    }

    if (!ctx.exists(".gitignore")) {
      problems.push({
        file: ".gitignore",
        msg: "缺少 .gitignore，.env 随时可能被整包提交",
        fix: "运行 npx guiju init 会自动补上标准忽略规则；或手动创建 .gitignore 并加入 .env、.env.local、.env.*.local 三行。",
      });
      return problems;
    }

    const lines = ctx.readText(".gitignore").split(/\r?\n/);
    const missing = REQUIRED.filter((t) => !gitignoreCovers(lines, t));
    if (missing.length > 0) {
      problems.push({
        file: ".gitignore",
        msg: `未覆盖：${missing.join("、")}`,
        fix: "在 .gitignore 里为缺失项各加一行（或用一行 `.env*` 全覆盖）；npx guiju init 也会自动补齐。",
      });
    }
    return problems;
  },
};

/**
 * check：跑全部守卫，任一红则以非零退出。
 * 输出纪律：每条问题必须带「修」指引，且指引只许指向真实存在的命令或文件——
 * 一道守卫的检查逻辑改坏了自己会报错，修复指引只是一句中文，仓库怎么改它都不会响，
 * 所以它必须简单到不会过时。
 */

import { createContext, paint } from "../context.mjs";
import { guards } from "../guards/index.mjs";

export function runCheck(root = process.cwd()) {
  const ctx = createContext(root);

  if (!ctx.isGitRepo()) {
    console.error(paint.red("✗ 当前目录不是 git 仓库，守卫需要 git 提供确定的文件清单。"));
    console.error("  修：新项目运行 npx bosscoding init（会顺带 git init）；已有项目先 git init。");
    return 1;
  }

  let failed = 0;
  let total = 0;
  for (const guard of guards) {
    total += 1;
    let problems;
    try {
      problems = guard.run(ctx);
    } catch (error) {
      problems = [
        {
          msg: `守卫自身执行出错：${error.message}`,
          fix: "这是 BossCoding 的问题不是你的问题，请到 bosscoding 仓库开 issue 附上本条输出。",
        },
      ];
    }
    if (problems.length === 0) {
      console.log(paint.green(`✓ ${guard.title}`));
      continue;
    }
    failed += 1;
    console.log(paint.red(`✗ ${guard.title}（${problems.length} 处）`));
    for (const p of problems) {
      const where = p.file ? `${p.file}${p.line ? `:${p.line}` : ""} ` : "";
      console.log(`  ${where}${p.msg}`);
      console.log(paint.dim(`  修：${p.fix}`));
    }
  }

  console.log("");
  if (failed === 0) {
    console.log(paint.green(`${total} 项守卫全部通过。`));
    return 0;
  }
  console.log(paint.red(`${failed}／${total} 项守卫未过。按上面的「修」逐条处理后重跑 npx boss check。`));
  return 1;
}

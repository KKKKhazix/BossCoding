/**
 * task：开一条并行任务的独立工作区——「无脑开工作树发任务」的那个按钮。
 *
 * 为什么值得一个命令而不是教 agent 手动 `git worktree add`（issue 见
 * docs/decisions/2026-07-27-task-command.md）：主工作区保护只在仓库已有 ≥2 个
 * 工作区时激活（见 templates/hooks/main-worktree.sh 的误报收敛），而小白最常见的
 * 并行姿势是「同一个文件夹开两个对话窗口」——工作区数是 1，保护恰好探测不到。
 * 把开工作区收成一条命令：姿势对了，保护也自然激活。
 *
 * 只建不删：删工作区是破坏性动作，交还给人（输出末尾给出清理命令）。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paint } from "../context.mjs";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 任务名清洗：空白与路径分隔符换成连字符，git 引用名的非法字符去掉。 */
export function sanitizeTaskName(raw) {
  return (raw ?? "")
    .trim()
    .replace(/[\s/\\:*?"<>|~^[\]@{}]+/g, "-")
    .replace(/\.+$/g, "")
    .replace(/^-+|-+$/g, "");
}

/** 主干叫什么由仓库说了算（与 hook 同一套判据）；找不到就基于当前提交。 */
function defaultBase(root) {
  try {
    const head = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const name = head.replace(/^origin\//, "");
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return name;
  } catch {
    /* 没有 origin/HEAD，继续猜 main/master */
  }
  for (const name of ["main", "master"]) {
    try {
      git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
      return name;
    } catch {
      /* 下一个 */
    }
  }
  return "HEAD";
}

export function runTask(root = process.cwd(), rawName, options = {}) {
  const { installDeps = true } = options;
  const abs = path.resolve(root);

  if (!rawName || !rawName.trim()) {
    console.error(paint.red("✗ 缺任务名。用法：npx boss task <任务名>"));
    console.error("  例：npx boss task 登录页 ——会开出独立工作区与分支 lane/登录页。");
    return 1;
  }

  try {
    git(abs, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.error(paint.red("✗ 当前目录不是 git 仓库。"));
    console.error("  修：新项目运行 npx bosscoding init（会顺带 git init）；已有项目先 git init。");
    return 1;
  }

  try {
    git(abs, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    console.error(paint.red("✗ 仓库还没有首个提交，工作区没有可以出发的基点。"));
    console.error('  修：先提交一次（git add -A && git commit -m "init"），再开任务。');
    return 1;
  }

  const name = sanitizeTaskName(rawName);
  if (!name) {
    console.error(paint.red(`✗ 任务名「${rawName}」清洗后什么都不剩，换一个由文字、数字或连字符组成的名字。`));
    return 1;
  }
  const branch = `lane/${name}`;
  try {
    git(abs, ["check-ref-format", "--branch", branch]);
  } catch {
    console.error(paint.red(`✗ 「${branch}」不是合法的分支名，换个更简单的任务名。`));
    return 1;
  }

  try {
    git(abs, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    console.error(paint.red(`✗ 分支 ${branch} 已存在——这个任务名用过了。`));
    console.error(`  修：换个任务名；确认旧任务已合并可清理：git branch -d ${branch}`);
    return 1;
  } catch {
    /* 分支不存在，正好 */
  }

  // 新工作区放在主工作区旁边（worktree list 的第一条永远是主工作区）。
  const porcelain = git(abs, ["worktree", "list", "--porcelain"]);
  const mainRoot = porcelain.split(/\r?\n/)[0].replace(/^worktree /, "");
  const target = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${name}`);
  if (fs.existsSync(target)) {
    console.error(paint.red(`✗ 目录已存在：${target}`));
    console.error("  修：换个任务名，或先处理那个目录。");
    return 1;
  }

  const base = defaultBase(abs);
  try {
    execFileSync("git", ["worktree", "add", target, "-b", branch, base], {
      cwd: abs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(paint.red("✗ 开工作区失败："));
    console.error(`  ${String(error.stderr ?? error.message).trim()}`);
    return 1;
  }

  console.log(paint.bold(`任务工作区已开：${name}`));
  console.log(`  位置：${target}`);
  console.log(`  分支：${branch}（基于 ${base === "HEAD" ? "当前提交" : base}）`);

  // 新工作区是「只有版本库里那些文件」的干净副本，依赖（node_modules）不在版本库里，
  // 所以不补装的话，第一条自检命令就会以「命令找不到」告败——实测踩过，旗舰流程第二步就断。
  if (installDeps) {
    const need = fs.existsSync(path.join(abs, "package.json")) && fs.existsSync(path.join(abs, "node_modules"));
    if (need) {
      console.log("\n正在给新工作区装依赖（主工作区装过，这里也得有一份）……");
      try {
        execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
          cwd: target,
          stdio: ["ignore", "ignore", "pipe"],
        });
        console.log(paint.green("  依赖就位，自检命令可以直接跑了。"));
      } catch {
        console.log(paint.yellow("  依赖没装成（网络？）。进那个文件夹先跑一次 npm install，再干活。"));
      }
    }
  }

  console.log("\n下一步（老板只需做一件事）：");
  console.log("  把上面那个文件夹拖进一个新的 AI 对话窗口，说出你的需求——其余交给制度。");
  console.log(paint.dim(`\n任务合并回主干后清理：git worktree remove ${target} && git branch -d ${branch}`));

  const stale = mergedTaskWorktrees(abs, target);
  if (stale.length > 0) {
    console.log(paint.yellow(`\n顺带一提：有 ${stale.length} 个旧任务已经合并进主干，文件夹还占着地方。`));
    for (const s of stale) console.log(paint.dim(`  git worktree remove ${s.path} && git branch -d ${s.branch}`));
  }
  return 0;
}

/** 已经合并进主干、可以回收的任务工作区（只报告，不动手——删除是破坏性动作）。 */
export function mergedTaskWorktrees(root, exclude = null) {
  let base;
  try {
    base = defaultBase(root);
    if (base === "HEAD") return [];
  } catch {
    return [];
  }
  const stale = [];
  let blocks;
  try {
    blocks = git(root, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/);
  } catch {
    return [];
  }
  for (const block of blocks) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!dir || !ref || !ref.startsWith("lane/") || dir === exclude) continue;
    try {
      // --is-ancestor：这条分支的提交是否已经全在主干里。是＝活干完了，文件夹可以收。
      execFileSync("git", ["merge-base", "--is-ancestor", ref, base], { cwd: root, stdio: "ignore" });
      stale.push({ path: dir, branch: ref });
    } catch {
      /* 还没合并，留着 */
    }
  }
  return stale;
}

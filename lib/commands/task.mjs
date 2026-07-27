/**
 * task：开一条并行任务的独立工作区——「无脑开工作树发任务」的那个按钮。
 *
 * 为什么值得一个命令而不是教 agent 手动 `git worktree add`（issue 见
 * docs/decisions/2026-07-27-task-command.md）：主工作区保护只在仓库已有 ≥2 个
 * 工作区时激活（见 templates/hooks/main-worktree.sh 的误报收敛），而小白最常见的
 * 并行姿势是「同一个文件夹开两个对话窗口」——工作区数是 1，保护恰好探测不到。
 * 把开工作区收成一条命令：姿势对了，保护也自然激活。
 *
 * 只建不删：删工作区是破坏性动作，只提醒 AI 在验收后处理，不把命令甩给老板。
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
export function defaultBase(root) {
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

/** worktree 的稳定机器格式统一在这里解析，路径里有空格也不会被拆坏。 */
export function worktreeEntries(root) {
  const blocks = git(root, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/);
  return blocks
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? null,
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null,
      head: /^HEAD (.+)$/m.exec(block)?.[1] ?? null,
    }))
    .filter((entry) => entry.path);
}

/** 只用于打印可复制的命令，不通过 shell 执行。 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function dirtyWorktrees(entries) {
  return entries.filter((entry) => {
    try {
      return git(entry.path, ["status", "--porcelain"]).length > 0;
    } catch {
      // 工作区登记着却读不到，也不能假装干净后继续开工。
      return true;
    }
  });
}

function branchStartKey(branch) {
  return `branch.${branch}.bosscoding-start`;
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

  const entries = worktreeEntries(abs);
  const dirty = dirtyWorktrees(entries);
  if (dirty.length > 0) {
    console.error(paint.red(`✗ 还有 ${dirty.length} 个工作区有未提交内容，现在开新任务会把最新进度落在后面。`));
    for (const entry of dirty) console.error(`  ${entry.path}`);
    console.error(
      `  把这句话交给 AI：「先逐一处理所有工作区的未提交内容，再重新运行 npx boss task ${rawName.trim()}。」`,
    );
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

  // 主工作区是 worktree list 的第一条；目标永远放在它旁边。
  const mainRoot = entries[0].path;
  const target = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${name}`);

  try {
    git(abs, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    const existing = entries.find((entry) => entry.branch === branch);
    console.error(paint.red(`✗ 任务「${name}」已经存在，不重复开。`));
    if (existing) {
      console.error(`  把这句话交给 AI：「继续接管已有任务工作区 ${existing.path}，不要重复创建。」`);
      console.error(
        paint.dim(
          `  AI 确认任务可回收后，应先移除工作区、再删分支：git worktree remove ${shellQuote(existing.path)} && git branch -d ${shellQuote(branch)}`,
        ),
      );
    } else {
      console.error(`  把这句话交给 AI：「把已有分支 ${branch} 恢复成独立任务工作区，再继续做；不要先删分支。」`);
      console.error(paint.dim(`  AI 可执行：git worktree add ${shellQuote(target)} ${shellQuote(branch)}`));
    }
    return 1;
  } catch {
    /* 分支不存在，正好 */
  }

  if (fs.existsSync(target)) {
    console.error(paint.red(`✗ 目录已存在：${target}`));
    console.error("  修：换个任务名，或先处理那个目录。");
    return 1;
  }

  const base = defaultBase(abs);
  const start = git(abs, ["rev-parse", base]);
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
  // 记住任务起点：之后即使主干前进，也不会把「这条任务一笔活都没干」误报成已合并。
  try {
    git(abs, ["config", "--local", branchStartKey(branch), start]);
  } catch {
    // 老仓库或只读配置里记不下时，回收判定还有 reflog 兜底；不让辅助信息毁掉已开的工作区。
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
  console.log(`  对当前 AI 说：「为任务『${name}』开一个新会话，接管工作区 ${target}，把需求和规则一起交接过去。」`);
  console.log(paint.dim("  只有当前工具明确不能新开会话时，你才需要把这个文件夹拖进新窗口一次。"));

  const stale = mergedTaskWorktrees(abs, target);
  if (stale.length > 0) {
    console.log(paint.yellow(`\n顺带一提：有 ${stale.length} 个旧任务已经合并进主干，文件夹还占着地方。`));
    console.log("  验收确认后由 AI 负责回收，不需要你处理文件夹或运行命令。");
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
  let entries;
  try {
    entries = worktreeEntries(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const dir = entry.path;
    const ref = entry.branch;
    if (!dir || !ref || !ref.startsWith("lane/") || dir === exclude) continue;
    try {
      const tip = git(root, ["rev-parse", ref]);
      const start = (() => {
        try {
          return git(root, ["config", "--get", branchStartKey(ref)]);
        } catch {
          return null;
        }
      })();
      if (start === tip) continue;
      if (!start) {
        const history = git(root, ["reflog", "show", "--format=%H", ref])
          .split(/\r?\n/)
          .filter(Boolean);
        if (new Set(history).size < 2) continue;
      }
      // --is-ancestor：这条分支的提交是否已经全在主干里。是＝活干完了，文件夹可以收。
      execFileSync("git", ["merge-base", "--is-ancestor", ref, base], { cwd: root, stdio: "ignore" });
      stale.push({ path: dir, branch: ref });
    } catch {
      /* 还没合并，留着 */
    }
  }
  return stale;
}

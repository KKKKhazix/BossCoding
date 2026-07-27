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
import { detectPackageManager, runPackageManager } from "../package-manager.mjs";
import { dependencyState, readPackageState } from "../project-health.mjs";

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

/** 主干叫什么由仓库说了算（与 hook 同一套判据）；找不到就明确失败，绝不用当前分支冒充。 */
export function defaultBase(root) {
  try {
    const configured = git(root, ["config", "--local", "--get", "bosscoding.stableBranch"]);
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${configured}`]);
    return configured;
  } catch {
    /* 没有有效的 BossCoding 记录，继续按仓库事实探测 */
  }
  try {
    const head = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const name = head.replace(/^origin\//, "");
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return name;
  } catch {
    /* 没有可用的 origin/HEAD，继续找通用稳定分支 */
  }
  for (const name of ["main", "master", "trunk"]) {
    try {
      git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
      return name;
    } catch {
      /* 下一个 */
    }
  }
  const candidates = git(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ])
    .split(/\r?\n/)
    .filter((name) => name && !name.startsWith("lane/"));
  if (candidates.length === 1) return candidates[0];
  return null;
}

/** worktree 的稳定机器格式统一在这里解析，路径里有空格也不会被拆坏。 */
export function worktreeEntries(root) {
  const blocks = git(root, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/);
  return blocks
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? null,
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null,
      head: /^HEAD (.+)$/m.exec(block)?.[1] ?? null,
      prunable: /^prunable(?:\s|$)/m.test(block),
      locked: /^locked(?:\s|$)/m.test(block),
    }))
    .filter((entry) => entry.path);
}

/** 只用于打印可复制的命令，不通过 shell 执行。 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function worktreeIsClean(entry) {
  try {
    return git(entry.path, ["status", "--porcelain"]).length === 0;
  } catch {
    // 稳定工作区登记着却读不到，也不能假装干净后继续开工。
    return false;
  }
}

function branchStartKey(branch) {
  return `branch.${branch}.bosscoding-start`;
}

export function runTask(root = process.cwd(), rawName, options = {}) {
  const { installDeps = true, installRunner = execFileSync } = options;
  const abs = path.resolve(root);

  if (!rawName || !rawName.trim()) {
    console.error(paint.red("✗ 缺任务名。用法：npx bosscoding task <任务名>"));
    console.error("  例：npx bosscoding task 登录页 ——会开出独立工作区与分支 lane/登录页。");
    return 1;
  }

  try {
    git(abs, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.error(paint.red("✗ 当前目录不是 git 仓库。"));
    console.error("  把这句话交给 AI：「先确认这里是独立的产品根目录，排除私人文件和密钥，再安全建立版本记录并运行 BossCoding 初始化。」");
    return 1;
  }

  try {
    git(abs, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    console.error(paint.red("✗ 仓库还没有首个提交，工作区没有可以出发的基点。"));
    console.error("  把这句话交给 AI：「先检查哪些文件属于产品、排除私人文件和密钥，安全保存第一个版本后再创建任务。」");
    return 1;
  }

  const base = defaultBase(abs);
  if (!base) {
    console.error(paint.red("✗ 找不到统一的稳定分支，已停止开任务。"));
    console.error("  把这句话交给 AI：「先确认并建立项目唯一的稳定分支，再重新运行 npx bosscoding task。」");
    return 1;
  }

  const entries = worktreeEntries(abs);
  const main = entries.find((entry) => entry.branch === base && !entry.prunable);
  if (!main) {
    console.error(paint.red(`✗ ${base} 没有自己的稳定工作区，已停止开任务。`));
    console.error("  把这句话交给 AI：「先恢复稳定主工作区，再创建新的并行任务。」");
    return 1;
  }
  if (!worktreeIsClean(main)) {
    console.error(paint.red("✗ 稳定主工作区还有未提交内容，现在开任务会漏掉最新进度。"));
    console.error(`  ${main.path}`);
    console.error(
      `  把这句话交给 AI：「先妥善保存稳定主工作区的改动，再重新运行 npx bosscoding task ${rawName.trim()}。」`,
    );
    return 1;
  }

  const name = sanitizeTaskName(rawName);
  if (!name) {
    console.error(paint.red(`✗ 任务名「${rawName}」清洗后什么都不剩，换一个由文字、数字或连字符组成的名字。`));
    return 1;
  }
  if ([...name].length > 48 || Buffer.byteLength(name, "utf8") > 120) {
    console.error(paint.red("✗ 这更像一整段需求，不适合作为任务短标题；BossCoding 没有创建分支或文件夹。"));
    console.error("  把这句话交给 AI：「把我的需求概括成 20 字以内的任务名，再用完整原文继续做。」");
    return 1;
  }
  const branch = `lane/${name}`;
  try {
    git(abs, ["check-ref-format", "--branch", branch]);
  } catch {
    console.error(paint.red(`✗ 「${branch}」不是合法的分支名，换个更简单的任务名。`));
    return 1;
  }

  // 目标永远放在稳定主工作区旁边；worktree 列表顺序不参与判断。
  const mainRoot = main.path;
  const packageState = readPackageState(mainRoot);
  if (packageState.hasPackageJson && !packageState.packageJsonValid) {
    console.error(paint.red("✗ package.json 已损坏，不能可靠准备新任务。"));
    console.error("  把这句话交给 AI：「先修好项目配置 package.json，再重新创建任务。」");
    return 1;
  }
  const manager = detectPackageManager(mainRoot, packageState.pkg);
  if (manager.ambiguous) {
    console.error(paint.red("✗ 项目同时出现多套安装工具的痕迹，BossCoding 不会任选一套继续。"));
    console.error("  把这句话交给 AI：「确认项目原来用哪一种包管理器，只保留正确声明和一套锁文件，再重新创建任务。」");
    return 1;
  }
  const target = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${name}`);

  try {
    git(abs, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    const existing = entries.find((entry) => entry.branch === branch);
    console.error(paint.red(`✗ 任务「${name}」已经存在，不重复开。`));
    if (existing?.prunable || (existing && !fs.existsSync(existing.path))) {
      console.error(
        `  把这句话交给 AI：「任务 ${branch} 登记的工作区已经不在原位置；先确认文件是否被移动、能否从备份找回，再修复工作区登记，不要直接删分支。」`,
      );
    } else if (existing) {
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

  const start = git(abs, ["rev-parse", base]);
  try {
    execFileSync("git", ["worktree", "add", target, "-b", branch, base], {
      cwd: abs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    console.error(paint.red("✗ 开工作区失败，BossCoding 没有把程序原始报错丢给老板。"));
    console.error("  把这句话交给 AI：「检查任务分支、目标文件夹和 Git 工作区状态，修好后重新创建任务。」");
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
  let setupIncomplete = false;
  if (installDeps && packageState.packageJsonValid) {
    const targetPackageState = readPackageState(target);
    const targetDependencies = dependencyState(target, targetPackageState, manager);
    if (targetDependencies.dependenciesRequired && !targetDependencies.depsInstalled) {
      console.log("\n正在给新工作区装依赖（每个工作区都要有一份可运行环境）……");
      try {
        runPackageManager(installRunner, target, manager, "install", {
          frozen: manager.locks.length > 0,
          execOptions: {
            stdio: ["ignore", "ignore", "pipe"],
          },
        });
        console.log(paint.green("  依赖就位，自检命令可以直接跑了。"));
        if (manager.locks.length === 0) {
          console.log("  项目原来没有依赖锁文件；安装工具若新生成了一份，AI 会把它作为本任务的一部分检查并保存。");
        }
      } catch {
        setupIncomplete = true;
        console.log(paint.yellow(`  ${manager.label} 依赖没装成，任务文件和分支已安全保留。`));
        console.log(`  把这句话交给 AI：「接管 ${target}，查清依赖安装失败的原因并修好，再开始改产品。」`);
      }
    }
  }

  console.log("\n下一步（交给正在执行的 AI）：");
  console.log(`  直接为任务「${name}」创建新会话，接管工作区 ${target}，把需求和规则一起交接过去；不要把调度退给老板。`);
  console.log(
    paint.dim(
      `  仅当当前环境明确不支持创建新会话时，才请老板做一次界面操作：「把任务文件夹 ${target} 打开成新任务。」除此之外不要让老板操作文件夹或命令。`,
    ),
  );

  const stale = mergedTaskWorktrees(abs, target);
  if (stale.length > 0) {
    console.log(paint.yellow(`\n顺带一提：有 ${stale.length} 个旧任务已经合并进主干，文件夹还占着地方。`));
    console.log("  验收确认后由 AI 负责回收，不需要你处理文件夹或运行命令。");
  }
  return setupIncomplete ? 1 : 0;
}

/** 已经合并进主干、可以回收的任务工作区（只报告，不动手——删除是破坏性动作）。 */
export function mergedTaskWorktrees(root, exclude = null) {
  let base;
  try {
    base = defaultBase(root);
    if (!base) return [];
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
    if (
      !dir ||
      !ref ||
      ref === base ||
      entry.prunable ||
      !fs.existsSync(dir) ||
      (exclude && path.resolve(dir) === path.resolve(exclude)) ||
      !worktreeIsClean(entry)
    ) {
      continue;
    }
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

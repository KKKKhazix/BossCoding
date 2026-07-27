/**
 * status：一句话回答「我现在在哪一阶，下一步该干什么」。
 *
 * 为什么值得一个命令（实测事故，见 docs/decisions/2026-07-27-status-command.md）：
 * 四阶梯此前只活在技能文件里，也就是只活在**当前这轮对话的记忆**里。换个对话窗口、
 * 换台电脑、隔一周回来，老板和 AI 都无从知道项目走到哪儿了，只能靠读文档猜——
 * 而这套框架自己的规矩是「现在实际什么状态，跑命令看，不要读文档猜」。
 *
 * 只读：不装东西、不建仓库、不改任何文件。它只是把跑几条命令才能拼出来的事实
 * 摆成一句人话。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paint } from "../context.mjs";
import { mergedTaskWorktrees } from "./task.mjs";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** 探测四阶梯的当前位置。全部靠跑命令，不读任何声明式配置。 */
export function probe(root) {
  const abs = path.resolve(root);
  const isRepo = tryGit(abs, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const hasCommit = isRepo && tryGit(abs, ["rev-parse", "--verify", "HEAD"]) !== null;
  const origin = isRepo ? tryGit(abs, ["config", "--get", "remote.origin.url"]) : null;
  const hasPackageJson = fs.existsSync(path.join(abs, "package.json"));
  const depsInstalled = fs.existsSync(path.join(abs, "node_modules"));
  const worktrees = isRepo ? (tryGit(abs, ["worktree", "list"]) ?? "").split(/\r?\n/).filter(Boolean).length : 0;
  const branch = isRepo ? tryGit(abs, ["symbolic-ref", "--short", "HEAD"]) : null;

  const intro = (() => {
    const file = path.join(abs, "AGENTS.md");
    if (!fs.existsSync(file)) return "missing";
    const text = fs.readFileSync(file, "utf8");
    const m = /<!-- bosscoding:intro-start -->([\s\S]*?)<!-- bosscoding:intro-end -->/.exec(text);
    if (!m) return "custom"; // 老板自己改过结构，不评判
    return m[1].includes("本项目做什么、给谁用、跑在哪") ? "placeholder" : "filled";
  })();

  const rung = !origin ? 0 : 1;
  return { abs, isRepo, hasCommit, origin, hasPackageJson, depsInstalled, worktrees, branch, intro, rung };
}

export function runStatus(root = process.cwd()) {
  const s = probe(root);

  if (!s.isRepo) {
    console.log(paint.red("这里还不是一个项目（没有版本库）。"));
    console.log("  从这一步开始：npx bosscoding init");
    return 1;
  }

  console.log(paint.bold("你的项目现在在这儿："));

  // 阶梯位置。
  if (s.rung === 0) {
    console.log(paint.green("  第 0–1 阶・本地阶段") + "：东西只在这台电脑上，还没有异地备份。");
  } else {
    console.log(paint.green("  第 1 阶・已连 GitHub") + `：${s.origin}`);
    console.log("    代码有异地备份了；改动走 PR（一次改动的申请单），过质检才进主干。");
  }

  // 干活环境是否齐备（缺依赖是实测最高频的卡死原因）。
  console.log("\n干活环境：");
  console.log(`  ${s.hasCommit ? "✓" : "✗"} 首个提交${s.hasCommit ? "已完成" : "还没有——先提交一次，任务和回退都要靠它"}`);
  if (s.hasPackageJson) {
    console.log(
      `  ${s.depsInstalled ? "✓" : "✗"} 依赖${s.depsInstalled ? "已装" : "没装——自检命令会以「命令找不到」告败，先跑 npm install"}`,
    );
  }
  console.log(`  ${s.intro === "filled" ? "✓" : "○"} 项目简介${s.intro === "filled" ? "已填" : "还是占位符（AGENTS.md 开头，让 AI 陪你填三句话）"}`);
  if (s.worktrees > 1) {
    console.log(`  ✓ 并行任务：${s.worktrees - 1} 条在跑（当前分支 ${s.branch ?? "游离状态"}）`);
  }

  const stale = mergedTaskWorktrees(s.abs);
  if (stale.length > 0) {
    console.log(paint.yellow(`\n可以回收：${stale.length} 个任务已经合并进主干，文件夹还占着地方。`));
    for (const t of stale) console.log(paint.dim(`  git worktree remove ${t.path} && git branch -d ${t.branch}`));
  }

  // 下一步：永远只给一条，且是此刻真正该做的那条。
  console.log(paint.bold("\n下一步："));
  if (!s.hasCommit) {
    console.log("  先把现在的东西存一版（对 AI 说「提交一下」）。");
  } else if (s.hasPackageJson && !s.depsInstalled) {
    console.log("  npm install —— 把干活要用的工具装上。");
  } else if (s.intro !== "filled") {
    console.log("  对 AI 说：「陪我把 AGENTS.md 开头的项目简介填了。」");
  } else if (s.rung === 0) {
    console.log("  东西做出来、你验收满意之后，对 AI 说：「带我连上 GitHub。」");
    console.log(paint.dim("  （免费，约十分钟，代码从此有异地备份，云端质检口也会自动亮起来）"));
  } else {
    console.log("  照常干活：说需求 → AI 开分支做 → 你验收 → 合并。");
    console.log(paint.dim("  想给朋友用（要服务器）或想要自己的域名，直接跟 AI 说，它会带你走。"));
  }
  return 0;
}

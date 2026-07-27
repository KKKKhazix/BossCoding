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
import { HOOK_NAMES } from "../hooks.mjs";
import { mergedTaskWorktrees } from "./task.mjs";

const HOOK_MARKERS = {
  "pre-commit": "bosscoding:main-worktree-guard",
  "post-checkout": "bosscoding:main-worktree-guard",
  "pre-push": "bosscoding:no-direct-push-guard",
};

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

/** 地址长得像 GitHub 才算 GitHub；example-github.com 之类不能蹭到这个绿灯。 */
export function isGitHubRemote(url) {
  if (!url) return false;
  const scp = /^(?:[^@/]+@)?github\.com:/i.test(url);
  if (scp) return true;
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return /^github\.com\//i.test(url);
  }
}

function dependencyState(abs, hasPackageJson) {
  if (!hasPackageJson) {
    return { dependenciesRequired: false, depsInstalled: true, missingDependencies: [] };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(abs, "package.json"), "utf8"));
    const names = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const missingDependencies = [...names].filter((name) => !fs.existsSync(path.join(abs, "node_modules", name)));
    return {
      dependenciesRequired: names.size > 0,
      depsInstalled: missingDependencies.length === 0,
      missingDependencies,
    };
  } catch {
    // package.json 坏了由自检负责报具体位置；status 只避免凭一个 node_modules 目录猜成功。
    return { dependenciesRequired: true, depsInstalled: false, missingDependencies: [] };
  }
}

function projectFiles(abs, isRepo) {
  if (!isRepo) return [];
  return (tryGit(abs, ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
}

/** 保守判定：宁可说「没看见」，也不把只有一条空 test 脚本的项目说成产品已验证。 */
export function hasProductTest(files) {
  return files.some((file) => {
    const normalized = file.replaceAll("\\", "/");
    const base = path.posix.basename(normalized);
    return (
      /(^|\/)(?:test|tests|__tests__|spec)\//i.test(normalized) ||
      /(?:^test_|_test\.|\.test\.|\.spec\.|smoke|冒烟)/i.test(base)
    );
  });
}

/** 探测四阶梯的当前位置。全部靠跑命令，不读任何声明式配置。 */
export function probe(root) {
  const abs = path.resolve(root);
  const isRepo = tryGit(abs, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const hasCommit = isRepo && tryGit(abs, ["rev-parse", "--verify", "HEAD"]) !== null;
  const origin = isRepo ? tryGit(abs, ["config", "--get", "remote.origin.url"]) : null;
  const remoteConfigured = Boolean(origin);
  const githubRemote = isGitHubRemote(origin);
  const uploadedRefs =
    githubRemote && hasCommit
      ? (tryGit(abs, [
          "for-each-ref",
          "--contains",
          "HEAD",
          "--format=%(refname)",
          "refs/remotes/origin/",
        ]) ?? "")
          .split(/\r?\n/)
          .filter((ref) => ref && ref !== "refs/remotes/origin/HEAD")
      : [];
  const currentCommitUploaded = uploadedRefs.length > 0;
  const hasPackageJson = fs.existsSync(path.join(abs, "package.json"));
  const dependencies = dependencyState(abs, hasPackageJson);
  const worktrees = isRepo ? (tryGit(abs, ["worktree", "list"]) ?? "").split(/\r?\n/).filter(Boolean).length : 0;
  const branch = isRepo ? tryGit(abs, ["symbolic-ref", "--short", "HEAD"]) : null;

  let agentsText = "";
  const intro = (() => {
    const file = path.join(abs, "AGENTS.md");
    if (!fs.existsSync(file)) return "missing";
    agentsText = fs.readFileSync(file, "utf8");
    const m = /<!-- bosscoding:intro-start -->([\s\S]*?)<!-- bosscoding:intro-end -->/.exec(agentsText);
    if (!m) return "custom"; // 老板自己改过结构，不评判
    return m[1].includes("本项目做什么、给谁用、跑在哪") ? "placeholder" : "filled";
  })();

  const rulesReady =
    agentsText.includes("## 干活流程") &&
    agentsText.includes("## 红线") &&
    (agentsText.includes("<!-- bosscoding:intro-start -->") || agentsText.includes("## 导师模式"));

  let hooksDir = null;
  if (isRepo) {
    const raw = tryGit(abs, ["rev-parse", "--git-path", "hooks"]);
    if (raw) hooksDir = path.isAbsolute(raw) ? raw : path.resolve(abs, raw);
  }
  const missingHooks = HOOK_NAMES.filter((name) => {
    if (!hooksDir) return true;
    const file = path.join(hooksDir, name);
    try {
      const marked = fs.readFileSync(file, "utf8").includes(HOOK_MARKERS[name]);
      const executable = process.platform === "win32" || (fs.statSync(file).mode & 0o111) !== 0;
      return !marked || !executable;
    } catch {
      return true;
    }
  });
  const hooksReady = missingHooks.length === 0;
  const productTest = hasProductTest(projectFiles(abs, isRepo));

  // 第 1 阶必须同时有 GitHub 身份和「当前提交曾上传」的本地证据；只填一个地址不算备份。
  const rung = githubRemote && currentCommitUploaded ? 1 : 0;
  return {
    abs,
    isRepo,
    hasCommit,
    origin,
    remoteConfigured,
    githubRemote,
    currentCommitUploaded,
    uploadedRefs,
    hasPackageJson,
    ...dependencies,
    worktrees,
    branch,
    intro,
    rulesReady,
    hooksDir,
    hooksReady,
    missingHooks,
    hasProductTest: productTest,
    rung,
  };
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
  if (!s.remoteConfigured) {
    console.log(paint.green("  第 0–1 阶・本地阶段") + "：东西只在这台电脑上，还没有异地备份。");
  } else if (!s.githubRemote) {
    console.log(paint.yellow("  已配置远端，但不是 GitHub") + `：${s.origin}`);
    console.log("    这里只能确认填过一个地址，不能据此说代码已经异地备份。");
  } else if (!s.currentCommitUploaded) {
    console.log(paint.yellow("  已连接 GitHub，但当前版本还没有上传记录") + `：${s.origin}`);
    console.log("    地址已经配好；当前这版仍不能算有异地备份。");
  } else {
    console.log(paint.green("  第 1 阶・已连 GitHub") + `：${s.origin}`);
    console.log("    当前版本有上传记录；后续改动走 PR（一次改动的申请单），过质检再进主干。");
  }

  // 只陈述事实；所有修法集中在「下一步」，避免同一屏给老板五个动作。
  console.log("\n干活环境：");
  console.log(`  ${s.rulesReady ? "✓" : "✗"} BossCoding 规则${s.rulesReady ? "已识别" : "未识别"}`);
  console.log(
    `  ${s.hooksReady ? "✓" : "✗"} 本地门禁${
      s.hooksReady ? "三个都已接入" : `未接入：${s.missingHooks.join("、")}`
    }`,
  );
  console.log(`  ${s.hasCommit ? "✓" : "✗"} 首个提交${s.hasCommit ? "已完成" : "还没有"}`);
  if (s.hasPackageJson && s.dependenciesRequired) {
    console.log(
      `  ${s.depsInstalled ? "✓" : "✗"} 依赖${s.depsInstalled ? "已装" : "未完整安装"}`,
    );
  } else if (s.hasPackageJson) {
    console.log("  ✓ 这个项目没有需要另装的依赖");
  }
  if (s.intro === "filled") console.log("  ✓ 项目简介已填");
  if (s.intro === "placeholder") console.log("  ○ 项目简介还是占位符");
  if (s.intro === "custom") console.log("  ○ 使用自定义规则，无法自动判断项目简介");
  if (s.intro === "missing") console.log("  ✗ 没有 AGENTS.md 规则文件");
  console.log(`  ${s.hasProductTest ? "✓" : "○"} 产品最小测试${s.hasProductTest ? "已找到" : "还没找到"}`);
  if (s.worktrees > 1) {
    console.log(`  ✓ 并行任务：${s.worktrees - 1} 条在跑（当前分支 ${s.branch ?? "游离状态"}）`);
  }

  const stale = mergedTaskWorktrees(s.abs);
  if (stale.length > 0) {
    console.log(paint.yellow(`\n待回收：${stale.length} 个任务已经合并进主干；BossCoding 没有自动删除它们。`));
  }

  // 下一步：永远只给一条，且是此刻真正该做的那条。
  console.log(paint.bold("\n下一步："));
  if (!s.rulesReady) {
    console.log("  对 AI 说：「确认这是我的产品项目，然后运行 npx bosscoding init，把 BossCoding 规则装完整。」");
  } else if (!s.hooksReady) {
    console.log("  对 AI 说：「运行 npx -y bosscoding@latest update，恢复这台电脑缺失的本地门禁，然后重新检查状态。」");
  } else if (!s.hasCommit) {
    console.log("  先把现在的东西存一版（对 AI 说「提交一下」）。");
  } else if (s.hasPackageJson && s.dependenciesRequired && !s.depsInstalled) {
    console.log("  对 AI 说：「把项目依赖安装完整，再跑一次自检。」");
  } else if (s.intro === "placeholder") {
    console.log("  对 AI 说：「陪我把 AGENTS.md 开头的项目简介填了。」");
  } else if (!s.hasProductTest) {
    console.log("  对 AI 说：「给产品补一条最小测试，证明最核心的功能还能跑。」");
  } else if (stale.length > 0) {
    console.log("  对 AI 说：「确认已合并任务都验收完成，然后替我回收对应工作区和分支。」");
  } else if (!s.remoteConfigured) {
    console.log("  东西做出来、你验收满意之后，对 AI 说：「带我连上 GitHub。」");
    console.log(paint.dim("  （免费，约十分钟，代码从此有异地备份，云端质检口也会自动亮起来）"));
  } else if (!s.githubRemote) {
    console.log("  对 AI 说：「检查这个远端地址是什么；确认代码真正上传后，再告诉我有没有异地备份。」");
  } else if (!s.currentCommitUploaded) {
    console.log("  对 AI 说：「把当前版本安全上传到已经连接的 GitHub；不要直推主干。」");
  } else {
    console.log("  照常干活：说需求 → AI 开分支做 → 你验收 → 合并。");
    console.log(paint.dim("  想给朋友用（要服务器）或想要自己的域名，直接跟 AI 说，它会带你走。"));
  }
  return 0;
}

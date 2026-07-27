/**
 * finish：把已经验收的任务送回稳定版本。
 *
 * 本地阶段只做可恢复的快进合并：任务和主工作区都干净、自检通过、主干没有分叉，
 * 才移动主干指针。GitHub 阶段只查队列并给下一步，不上传、不建 PR、不合并远端。
 * 工作区和分支一律保留，避免「收尾」顺手变成删除。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paint } from "../context.mjs";
import { customPreflightScript } from "../preflight.mjs";
import { runCheck } from "./check.mjs";
import { runMerge } from "./merge.mjs";
import { isGitHubRemote } from "./status.mjs";

export function systemRunner(command, args, options) {
  return execFileSync(command, args, options);
}

function outputOf(result) {
  if (result && typeof result === "object" && !Buffer.isBuffer(result) && "status" in result) {
    if (result.status !== 0) {
      const error = new Error(String(result.stderr ?? `${result.status}`));
      error.status = result.status;
      throw error;
    }
    return String(result.stdout ?? "");
  }
  return String(result ?? "");
}

function command(runner, cwd, file, args, stdio = ["ignore", "pipe", "pipe"]) {
  return outputOf(runner(file, args, { cwd, encoding: "utf8", stdio })).trim();
}

function git(runner, root, args) {
  return command(runner, root, "git", args);
}

function tryGit(runner, root, args) {
  try {
    return git(runner, root, args);
  } catch {
    return null;
  }
}

function defaultBase(runner, root) {
  const remoteHead = tryGit(runner, root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) {
    const name = remoteHead.replace(/^origin\//, "");
    if (tryGit(runner, root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) !== null) {
      return name;
    }
  }
  for (const name of ["main", "master"]) {
    if (tryGit(runner, root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]) !== null) {
      return name;
    }
  }
  return null;
}

function worktrees(runner, root) {
  return git(runner, root, ["worktree", "list", "--porcelain"])
    .split(/\r?\n\r?\n/)
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? null,
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null,
    }))
    .filter((entry) => entry.path);
}

function isClean(runner, root) {
  try {
    return git(runner, root, ["status", "--porcelain"]).length === 0;
  } catch {
    return false;
  }
}

function isAncestor(runner, root, older, newer) {
  try {
    command(runner, root, "git", ["merge-base", "--is-ancestor", older, newer], "ignore");
    return true;
  } catch {
    return false;
  }
}

function startKey(branch) {
  return `branch.${branch}.bosscoding-start`;
}

function qualityConfig(runner, root) {
  let script = "";
  let scripts = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    scripts = pkg.scripts ?? {};
    script = String(pkg.scripts?.test ?? "").trim();
  } catch {
    return { testReady: false, customScript: null };
  }
  if (!script || /^echo .Error: no test specified. && exit 1$/.test(script)) {
    return { testReady: false, customScript: customPreflightScript(scripts) };
  }

  // init 给空项目的占位入口不会凭「0 个测试也退出 0」冒充产品已有测试。
  if (script === "node --test") {
    const files = (tryGit(runner, root, ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "")
      .split(/\r?\n/)
      .filter((file) => /(^|\/)(?:test|tests|__tests__|spec)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(file));
    const testReady = files.some((file) => {
      try {
        const body = fs.readFileSync(path.join(root, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*(?:\/\/|#).*$/gm, "")
          .trim();
        return body.length > 0;
      } catch {
        return false;
      }
    });
    return { testReady, customScript: customPreflightScript(scripts) };
  }
  return { testReady: true, customScript: customPreflightScript(scripts) };
}

/**
 * runner 与 execFileSync 同形，可在测试里拦截 npm／git；queueRunner 与 runMerge 同形，
 * GitHub 测试不需要真的联网。
 */
export async function runFinish(root = process.cwd(), options = {}) {
  const {
    runner = systemRunner,
    queueRunner = runMerge,
    queueOptions = {},
    checkRunner = runCheck,
  } = options;
  const abs = path.resolve(root);

  const taskRoot = tryGit(runner, abs, ["rev-parse", "--show-toplevel"]);
  if (!taskRoot) {
    console.error(paint.red("✗ 当前目录不是任务工作区。"));
    console.error("  把这句话交给 AI：「找到这条任务的独立工作区，再运行 npx bosscoding finish。」");
    return 1;
  }

  const branch = tryGit(runner, taskRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch?.startsWith("lane/")) {
    console.error(paint.red("✗ 这里不是 lane/ 开头的任务分支，不能判断要收哪条任务。"));
    console.error("  把这句话交给 AI：「切回这条任务的独立工作区，再运行 npx bosscoding finish。」");
    return 1;
  }

  const base = defaultBase(runner, taskRoot);
  if (!base) {
    console.error(paint.red("✗ 找不到 main 或 master 主干，不能安全决定合并目标。"));
    console.error("  把这句话交给 AI：「确认项目主干叫什么，再处理这条任务的收尾。」");
    return 1;
  }

  let entries;
  try {
    entries = worktrees(runner, taskRoot);
  } catch {
    console.error(paint.red("✗ 读不到项目的工作区清单，已停止收尾。"));
    return 1;
  }
  const main = entries.find((entry) => entry.branch === base);
  const task = entries.find((entry) => path.resolve(entry.path) === path.resolve(taskRoot));
  if (!main || !task) {
    console.error(paint.red(`✗ 找不到占用 ${base} 的主工作区，不能安全合并。`));
    console.error("  把这句话交给 AI：「恢复主工作区到主干，再重新运行 npx boss finish。」");
    return 1;
  }

  const dirty = [
    !isClean(runner, taskRoot) ? taskRoot : null,
    !isClean(runner, main.path) ? main.path : null,
  ].filter(Boolean);
  if (dirty.length > 0) {
    console.error(paint.red("✗ 任务或主工作区还有未提交内容，已停止收尾。"));
    for (const dir of dirty) console.error(`  ${dir}`);
    console.error("  把这句话交给 AI：「先妥善提交或处理这两个工作区的改动，再重新运行 npx bosscoding finish。」");
    return 1;
  }

  const quality = qualityConfig(runner, taskRoot);
  if (!quality.testReady) {
    console.error(paint.red("✗ 还没有可执行的产品最小测试，主干没有改动。"));
    console.error(
      "  把这句话交给 AI：「先给产品补一条真正验证核心功能的最小测试，接进 package.json 的 test 命令，再重新收尾。」",
    );
    return 1;
  }

  console.log("正在任务工作区跑完整自检……");
  try {
    // 三道检查分开执行，绝不靠解析一段 shell 文本来猜它真的做了什么。
    // 自定义 preflight 即使含 `|| true`，也跳不过后面独立的产品测试和 BossCoding 检查。
    if (quality.customScript) {
      command(runner, taskRoot, "npm", ["run", quality.customScript], "inherit");
    }
    command(runner, taskRoot, "npm", ["test"], "inherit");
    if (checkRunner(taskRoot) !== 0) throw new Error("BossCoding check failed");
  } catch {
    console.error(paint.red("✗ 自检没有通过，主干没有改动。"));
    console.error("  把这句话交给 AI：「修好 npm run preflight 的全部问题，再重新运行 npx bosscoding finish。」");
    return 1;
  }

  // 测试脚本也可能意外改文件；真正合并前再看一遍，绿灯不能覆盖脏现场。
  if (!isClean(runner, taskRoot) || !isClean(runner, main.path)) {
    console.error(paint.red("✗ 自检之后工作区出现了未提交内容，主干没有改动。"));
    console.error("  把这句话交给 AI：「检查自检产生了什么文件，处理干净后再运行 npx bosscoding finish。」");
    return 1;
  }

  const taskSha = git(runner, taskRoot, ["rev-parse", branch]);
  const baseSha = git(runner, main.path, ["rev-parse", base]);
  const start = tryGit(runner, taskRoot, ["config", "--get", startKey(branch)]);

  // 相同 SHA 有两种含义：刚创建（一笔活没干）或已经快进合并。任务起点把两者分开。
  const reflog = (tryGit(runner, taskRoot, ["reflog", "show", "--format=%H", branch]) ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
  const hasTaskCommit = start
    ? start !== taskSha
    : new Set(reflog).size > 1 || (taskSha !== baseSha && isAncestor(runner, taskRoot, base, branch));
  if (hasTaskCommit && isAncestor(runner, taskRoot, branch, base)) {
    console.log(paint.green(`这条任务的提交已经在 ${base} 里，不需要重复合并。`));
    console.log("  工作区和分支仍保留；确认产品无误后，再让 AI 回收它们。");
    return 0;
  }

  if (!hasTaskCommit) {
    console.error(paint.yellow("○ 这条任务还没有新的已提交版本，主干没有改动。"));
    console.error("  把这句话交给 AI：「确认任务改动已经提交，再重新运行 npx bosscoding finish。」");
    return 1;
  }

  if (!isAncestor(runner, taskRoot, base, branch)) {
    console.error(paint.red(`✗ ${base} 已经前进，当前任务不能直接快进合并。`));
    console.error("  把这句话交给 AI：「先把最新主干安全同步进任务分支、解决冲突并重跑自检，再运行 npx bosscoding finish。」");
    return 1;
  }

  const origin = tryGit(runner, taskRoot, ["config", "--get", "remote.origin.url"]);
  if (origin && isGitHubRemote(origin)) {
    console.log(paint.bold("\nGitHub 阶段：只查队列，不自动上传、不建申请单、不合并。"));
    const queueCode = await queueRunner(taskRoot, queueOptions);
    console.log(paint.bold("\n下一步："));
    if (queueCode === 0) {
      console.log("  对 AI 说：「把当前任务分支推到 GitHub，创建或更新改动申请；云端自检通过后按队列合并。」");
    } else {
      console.log("  先按上面的队列提示等待；轮到这条任务后，再让 AI 完成 GitHub 合并。");
    }
    return queueCode;
  }
  if (origin) {
    console.error(paint.yellow("○ 远端不是 GitHub，BossCoding 不知道它的合并规则，因此没有自动改主干。"));
    console.error("  把这句话交给 AI：「确认这个远端平台的合并流程，保证自检通过后安全收尾。」");
    return 1;
  }

  // 合并经过精确 SHA：即使另一个窗口在自检后又给任务分支加提交，也不会把未测版本带进主干。
  try {
    command(runner, main.path, "git", ["merge", "--ff-only", taskSha]);
  } catch {
    console.error(paint.red("✗ 快进合并失败，主干没有被强行改写。"));
    console.error("  把这句话交给 AI：「检查主干为何不能快进，处理后重跑 npx bosscoding finish。」");
    return 1;
  }

  const mergedSha = git(runner, main.path, ["rev-parse", base]);
  if (mergedSha !== taskSha) {
    console.error(paint.red("✗ 合并结果与刚才通过自检的版本不一致，请让 AI 检查；工作区和分支都未删除。"));
    return 1;
  }

  console.log(paint.green(`✓ 任务已安全快进合并回 ${base}。`));
  console.log("  工作区和分支仍保留；你验收无误后，再让 AI 回收它们。");
  return 0;
}

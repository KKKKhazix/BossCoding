/**
 * git hook 安装：把「主工作区只跑 main」这条约定交给机器执行。
 *
 * 为什么是 hook 不是守卫：工作区状态不进 git——CI 拿到的是树和提交，看不出
 * 「这笔是在哪个工作区切出来的」。`boss check` 里做不了，只能在本地拦。
 *
 * 三条纪律：
 * 1. 绝不覆盖别人的 hook（husky、lefthook、用户手写的都算）——只认自己写的标记行。
 * 2. 装完显式 chmod +x：git 会静默忽略没有执行位的 hook，不报任何错，
 *    「装了但没生效」比「没装」更难查（实测踩过：第一次测试根本没拦住）。
 * 3. hook 文件不进版本库，所以 clone 出来的新副本是裸的——`boss update` 会补装。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = path.join(fileURLToPath(new URL("../", import.meta.url)), "templates");

/** 同一份脚本挂两处：切分支时提醒（退出码被 git 忽略），真要提交时硬拦。 */
export const HOOK_NAMES = ["pre-commit", "post-checkout"];

/** 认领标记：只有带这一行的文件才是我们写的，才允许刷新。 */
const MARKER = "bosscoding:main-worktree-guard";

export function hookBody() {
  return fs.readFileSync(path.join(TEMPLATES, "hooks", "main-worktree.sh"), "utf8");
}

/** hooks 目录（尊重 core.hooksPath：git 只跑那里的 hook，装到别处等于没装）。 */
function hooksDir(root) {
  const raw = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return path.resolve(root, raw);
}

/**
 * 幂等安装。返回 { installed, refreshed, skipped }，三个都是 hook 名字数组；
 * skipped 表示那个位置已有别人的 hook，我们让路（由调用方提示老板）。
 */
export function installHooks(root = process.cwd()) {
  const abs = path.resolve(root);
  const result = { installed: [], refreshed: [], skipped: [] };

  let dir;
  try {
    dir = hooksDir(abs);
  } catch {
    return result; // 不是 git 仓库：调用方自己会报，这里不添乱。
  }

  const body = hookBody();
  fs.mkdirSync(dir, { recursive: true });

  for (const name of HOOK_NAMES) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const current = fs.readFileSync(target, "utf8");
      if (!current.includes(MARKER)) {
        result.skipped.push(name);
        continue;
      }
      if (current === body) {
        ensureExecutable(target);
        continue;
      }
      fs.writeFileSync(target, body);
      ensureExecutable(target);
      result.refreshed.push(name);
      continue;
    }
    fs.writeFileSync(target, body);
    ensureExecutable(target);
    result.installed.push(name);
  }

  return result;
}

function ensureExecutable(target) {
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows 上 chmod 基本是空操作，git for Windows 走 sh 不看执行位，忽略即可。
  }
}

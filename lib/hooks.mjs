/**
 * git hook 安装：把两条本地门禁交给机器执行。
 *
 * 门禁一「主工作区只跑 main」：工作区状态不进 git——CI 拿到的是树和提交，看不出
 * 「这笔是在哪个工作区切出来的」。`bosscoding check` 里做不了，只能在本地拦。
 * 门禁二「禁止直推主干」：GitHub 免费版的私有仓库开不了分支保护（2026-07 实查），
 * 「所有改动走 PR」在小白项目里没有机器执行——pre-push 是 ¥0 成本的那道闸。
 *
 * 三条纪律：
 * 1. 绝不覆盖别人的 hook（husky、lefthook、用户手写的都算）——只有安装时记录的
 *    整份文件哈希仍吻合，才允许刷新。标记行可能被复制，不能单独证明所有权。
 * 2. 装完显式 chmod +x：git 会静默忽略没有执行位的 hook，不报任何错，
 *    「装了但没生效」比「没装」更难查（实测踩过：第一次测试根本没拦住）。
 * 3. hook 文件不进版本库，所以 clone 出来的新副本是裸的——`bosscoding update` 会补装。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = path.join(fileURLToPath(new URL("../", import.meta.url)), "templates");

/**
 * hook 注册表。main-worktree 同一份脚本挂两处：切分支时提醒（退出码被 git 忽略）、
 * 真要提交时硬拦；no-direct-push 挂在推送前。
 */
const HOOKS = [
  { name: "pre-commit", template: "main-worktree.sh" },
  { name: "post-checkout", template: "main-worktree.sh" },
  { name: "pre-push", template: "no-direct-push.sh" },
];

export const HOOK_NAMES = HOOKS.map((h) => h.name);
const OWNERSHIP_FILE = ".bosscoding-owned-hooks.json";
const LEGACY_OFFICIAL_HASHES = {
  "pre-commit": "1178d616c83b16485f41ab40f69c2b4126f5e9a7fdf9cf5aa2bc01719d041b78",
  "post-checkout": "1178d616c83b16485f41ab40f69c2b4126f5e9a7fdf9cf5aa2bc01719d041b78",
  "pre-push": "ea62446c6798dcfaa4ad744edded39aeb49008931105dd65360b14d0ecbade88",
};

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function lstat(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function readOwnership(dir) {
  const target = path.join(dir, OWNERSHIP_FILE);
  const stat = lstat(target);
  if (stat === null) return { ownership: {}, blocked: null };
  if (!stat.isFile()) {
    return {
      ownership: null,
      blocked: `${OWNERSHIP_FILE} 不是普通文件，BossCoding 已保护不写本地门禁。`,
    };
  }
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid ownership manifest");
    }
    return { ownership: value, blocked: null };
  } catch {
    return {
      ownership: null,
      blocked: `${OWNERSHIP_FILE} 无法识别，BossCoding 已保护不覆盖。请让 AI 检查这个本地门禁所有权记录。`,
    };
  }
}

function writeOwnership(dir, ownership) {
  fs.writeFileSync(path.join(dir, OWNERSHIP_FILE), `${JSON.stringify(ownership, null, 2)}\n`);
}

function canonicalWithMissing(target) {
  const suffix = [];
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const existing = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return path.join(existing, ...suffix);
}

function inside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * hooks 目录（尊重仓库内 core.hooksPath）。
 * 全局或仓库配置若把路径指到项目外，绝不能替用户往共享目录写文件。
 */
function hooksDir(root, runGit) {
  // `--path-format=absolute` 是较新 Git 才有的参数。`--git-path hooks` 很早就支持，
  // 它若给相对路径，再由我们按项目根目录转绝对路径即可。
  const raw = runGit("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!raw) throw new Error("Git 没有返回 hooks 路径");
  const target = canonicalWithMissing(path.isAbsolute(raw) ? raw : path.resolve(root, raw));
  const topRaw = runGit("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!topRaw) throw new Error("Git 没有返回项目根目录");
  const top = fs.realpathSync(topRaw);
  const commonRaw = runGit("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!commonRaw) throw new Error("Git 没有返回公共目录");
  const common = canonicalWithMissing(
    path.isAbsolute(commonRaw) ? commonRaw : path.resolve(root, commonRaw),
  );

  if (!inside(top, target) && !inside(common, target)) {
    return {
      blocked:
        `core.hooksPath 指向项目外的 ${target}，为避免改到其他项目，BossCoding 没有写入本地门禁。` +
        "请把这句话交给 AI：「请把本项目的 Git hook 路径改回仓库内，再运行 BossCoding 更新。」",
    };
  }
  return { dir: target, blocked: null };
}

/**
 * 幂等安装。返回 { installed, refreshed, skipped, blocked }；
 * skipped 表示那个位置已有别人的 hook，我们让路（由调用方提示老板）。
 */
export function installHooks(root = process.cwd(), options = {}) {
  const abs = path.resolve(root);
  const result = { installed: [], refreshed: [], skipped: [], blocked: [] };
  const runGit = options.execFileSync ?? execFileSync;

  let resolved;
  try {
    resolved = hooksDir(abs, runGit);
  } catch {
    result.blocked.push(
      "无法确认本项目的 Git hook 路径，BossCoding 没有写入本地门禁。请把这句话交给 AI：「请检查 Git 是否可用、当前文件夹是否为项目最外层，修好后重新运行 BossCoding 更新。」",
    );
    return result;
  }
  if (resolved.blocked) {
    result.blocked.push(resolved.blocked);
    return result;
  }
  const { dir } = resolved;

  fs.mkdirSync(dir, { recursive: true });
  const ownershipState = readOwnership(dir);
  if (ownershipState.blocked) {
    result.blocked.push(ownershipState.blocked);
    return result;
  }
  const ownership = ownershipState.ownership;
  let ownershipChanged = false;

  for (const hook of HOOKS) {
    const body = fs.readFileSync(path.join(TEMPLATES, "hooks", hook.template), "utf8");
    const bodyHash = digest(body);
    const target = path.join(dir, hook.name);
    const targetStat = lstat(target);
    if (targetStat !== null) {
      if (!targetStat.isFile()) {
        result.skipped.push(hook.name);
        continue;
      }
      const current = fs.readFileSync(target, "utf8");
      const currentHash = digest(current);
      if (current === body) {
        ensureExecutable(target);
        if (ownership[hook.name] !== bodyHash) {
          ownership[hook.name] = bodyHash;
          ownershipChanged = true;
        }
        continue;
      }
      if (
        ownership[hook.name] !== currentHash &&
        LEGACY_OFFICIAL_HASHES[hook.name] !== currentHash
      ) {
        result.skipped.push(hook.name);
        continue;
      }
      fs.writeFileSync(target, body);
      ensureExecutable(target);
      result.refreshed.push(hook.name);
      ownership[hook.name] = bodyHash;
      ownershipChanged = true;
      continue;
    }
    fs.writeFileSync(target, body);
    ensureExecutable(target);
    result.installed.push(hook.name);
    ownership[hook.name] = bodyHash;
    ownershipChanged = true;
  }

  if (ownershipChanged) writeOwnership(dir, ownership);
  return result;
}

function ensureExecutable(target) {
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows 上 chmod 基本是空操作，git for Windows 走 sh 不看执行位，忽略即可。
  }
}

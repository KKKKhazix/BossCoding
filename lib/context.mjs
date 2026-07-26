/**
 * 守卫与命令共用的仓库上下文。
 *
 * 约束：零第三方依赖（只用 Node 标准库）。理由见 docs/decisions/2026-07-26-v1-scope.md
 * 不变量 1——筹备队要在小白的任意网络环境下一条命令跑通，依赖树越深，失败面越大。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createContext(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  let trackedCache = null;

  const ctx = {
    root: resolvedRoot,

    /** 是否在 git 仓库里（守卫大多依赖 git 提供的确定性清单）。 */
    isGitRepo() {
      try {
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: resolvedRoot,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },

    /** git 追踪的文件相对路径列表（正斜杠），缓存一次。 */
    trackedFiles() {
      if (trackedCache) return trackedCache;
      const raw = execFileSync("git", ["ls-files", "-z"], {
        cwd: resolvedRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      trackedCache = raw.split("\0").filter(Boolean);
      return trackedCache;
    },

    /** `git ls-files --stage` 行（mode 判断用）。 */
    trackedStages(patterns = []) {
      const raw = execFileSync("git", ["ls-files", "--stage", "--", ...patterns], {
        cwd: resolvedRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    },

    exists(rel) {
      return fs.existsSync(path.join(resolvedRoot, rel));
    },

    /** lstat（软链判断要用 lstat 而不是 stat）。 */
    lstat(rel) {
      try {
        return fs.lstatSync(path.join(resolvedRoot, rel));
      } catch {
        return null;
      }
    },

    readText(rel) {
      return fs.readFileSync(path.join(resolvedRoot, rel), "utf8");
    },

    /** 读文件内容；二进制（含 NUL 字节）或超限返回 null，守卫据此跳过。 */
    readTextIfSmallText(rel, maxBytes = 1024 * 1024) {
      const abs = path.join(resolvedRoot, rel);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        return null;
      }
      if (!stat.isFile() || stat.size > maxBytes) return null;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return null;
      return buf.toString("utf8");
    },
  };

  return ctx;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const paint = {
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

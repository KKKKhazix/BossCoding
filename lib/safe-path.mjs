/**
 * 检查项目内写入目标的路径边界。
 *
 * 只看最终路径是否在项目内不够：`.github` 自身可以是指向项目外的软链。这里逐段
 * `lstat`，任何已存在的上级路径不是普通目录就拒绝。叶子状态交给调用方决定：
 * AGENTS／CLAUDE 需要只读识别精确软链，其他写入通常只接受普通文件或不存在。
 */

import fs from "node:fs";
import path from "node:path";

function lstat(target) {
  try {
    return { stat: fs.lstatSync(target), error: null };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { stat: null, error: null };
    }
    return { stat: null, error };
  }
}

export function inspectProjectTarget(root, relativePath) {
  const absRoot = fs.realpathSync(path.resolve(root));
  const target = path.resolve(absRoot, relativePath);
  const relative = path.relative(absRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { safe: false, target, stat: null, reason: "目标不在项目文件夹内" };
  }

  const parts = relative.split(path.sep).filter(Boolean);
  let cursor = absRoot;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const inspected = lstat(cursor);
    if (inspected.error) {
      return { safe: false, target, stat: null, reason: `无法确认上级路径 ${cursor}` };
    }
    if (inspected.stat !== null && !inspected.stat.isDirectory()) {
      return {
        safe: false,
        target,
        stat: null,
        reason: `上级路径 ${cursor} 不是项目内的普通目录`,
      };
    }
  }

  const leaf = lstat(target);
  if (leaf.error) {
    return { safe: false, target, stat: null, reason: `无法确认目标 ${target}` };
  }
  return { safe: true, target, stat: leaf.stat, reason: null };
}

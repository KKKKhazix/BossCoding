/**
 * `npm run preflight` 是本地交付总闸：产品测试与 BossCoding 检查缺一不可。
 *
 * 旧版默认只写了 `boss check`，却在规则里声称它也跑产品测试。这个假绿会让
 * finish 在产品测试从未执行时合并，所以初始化、更新与收尾共用同一判据。
 */

export const DEFAULT_PREFLIGHT = "npm test && boss check";

const LEGACY_DEFAULTS = new Set([
  "boss check",
  "npx boss check",
  "npx bosscoding check",
  "npm test --if-present && boss check",
]);

/**
 * 把既有 preflight 收进一个独立的 npm 子脚本，再接标准两道检查。
 * 子脚本是独立进程，所以原命令即使含 `|| true`，也不能靠 shell 优先级跳过后面的守卫。
 */
export function ensurePreflightScripts(scripts) {
  const current = String(scripts.preflight ?? "").trim();
  if (!current || LEGACY_DEFAULTS.has(current)) {
    if (scripts.preflight === DEFAULT_PREFLIGHT) return false;
    scripts.preflight = DEFAULT_PREFLIGHT;
    return true;
  }
  if (current === DEFAULT_PREFLIGHT) return false;

  const canonical = /^npm run (preflight:project(?::\d+)?) && npm test && boss check$/.exec(current);
  if (canonical) {
    if (typeof scripts[canonical[1]] === "string") return false;
    // 子脚本已经被删时，不能把包装器自身再包进去形成无限递归。
    scripts.preflight = DEFAULT_PREFLIGHT;
    return true;
  }

  let key = "preflight:project";
  let suffix = 2;
  while (Object.hasOwn(scripts, key) && scripts[key] !== current) {
    key = `preflight:project:${suffix}`;
    suffix += 1;
  }
  scripts[key] = current;
  scripts.preflight = `npm run ${key} && ${DEFAULT_PREFLIGHT}`;
  return true;
}

/** finish 只需额外跑用户原有检查；产品测试与 BossCoding 检查会独立各跑一次。 */
export function customPreflightScript(scripts) {
  const current = String(scripts?.preflight ?? "").trim();
  const canonical = /^npm run (preflight:project(?::\d+)?) && npm test && boss check$/.exec(current);
  if (canonical && typeof scripts?.[canonical[1]] === "string") return canonical[1];
  if (!current || current === DEFAULT_PREFLIGHT || LEGACY_DEFAULTS.has(current)) return null;
  return "preflight";
}

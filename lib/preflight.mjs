/**
 * `npm run preflight` 是本地交付总闸：产品测试与 BossCoding 检查缺一不可。
 *
 * 旧版默认只写了 `boss check`，却在规则里声称它也跑产品测试。这个假绿会让
 * finish 在产品测试从未执行时合并，所以初始化、更新与收尾共用同一判据。
 */

export const DEFAULT_PREFLIGHT = "npm test && bosscoding check";

const LEGACY_DEFAULTS = new Set([
  "boss check",
  "npx boss check",
  "npx bosscoding check",
  "npm test && boss check",
  "npm test --if-present && boss check",
  "pnpm exec boss check",
  "pnpm run test && pnpm exec boss check",
  "yarn exec boss check",
  "yarn test && yarn exec boss check",
  "bunx boss check",
  "bun run test && bunx boss check",
]);

function managerName(manager) {
  return typeof manager === "string" ? manager : manager?.name ?? "npm";
}

export function defaultPreflight(manager = "npm") {
  const name = managerName(manager);
  if (name === "pnpm") return "pnpm run test && bosscoding check";
  if (name === "yarn") return "yarn test && bosscoding check";
  if (name === "bun") return "bun run test && bosscoding check";
  return DEFAULT_PREFLIGHT;
}

function runScriptPrefix(manager) {
  return `${managerName(manager)} run`;
}

const GENERATED_DEFAULTS = new Set(
  ["npm", "pnpm", "yarn", "bun"].map((manager) => defaultPreflight(manager)),
);

function canonicalWrapper(current) {
  const match =
    /^(npm|pnpm|yarn|bun) run (preflight:project(?::\d+)?) && (?:npm test && (?:boss|bosscoding) check|pnpm run test && (?:pnpm exec boss|bosscoding) check|yarn test && (?:yarn exec boss|bosscoding) check|bun run test && (?:bunx boss|bosscoding) check)$/.exec(
      current,
    );
  return match ? { manager: match[1], key: match[2] } : null;
}

/**
 * 把既有 preflight 收进一个独立的 npm 子脚本，再接标准两道检查。
 * 子脚本是独立进程，所以原命令即使含 `|| true`，也不能靠 shell 优先级跳过后面的守卫。
 */
export function ensurePreflightScripts(scripts, manager = "npm") {
  const current = String(scripts.preflight ?? "").trim();
  const wanted = defaultPreflight(manager);
  if (!current || LEGACY_DEFAULTS.has(current) || GENERATED_DEFAULTS.has(current)) {
    if (scripts.preflight === wanted) return false;
    scripts.preflight = wanted;
    return true;
  }

  const canonical = canonicalWrapper(current);
  if (canonical) {
    if (typeof scripts[canonical.key] === "string") {
      const next = `${runScriptPrefix(manager)} ${canonical.key} && ${wanted}`;
      if (current === next) return false;
      scripts.preflight = next;
      return true;
    }
    // 子脚本已经被删时，不能把包装器自身再包进去形成无限递归。
    scripts.preflight = wanted;
    return true;
  }

  let key = "preflight:project";
  let suffix = 2;
  while (Object.hasOwn(scripts, key) && scripts[key] !== current) {
    key = `preflight:project:${suffix}`;
    suffix += 1;
  }
  scripts[key] = current;
  scripts.preflight = `${runScriptPrefix(manager)} ${key} && ${wanted}`;
  return true;
}

/** finish 只需额外跑用户原有检查；产品测试与 BossCoding 检查会独立各跑一次。 */
export function customPreflightScript(scripts) {
  const current = String(scripts?.preflight ?? "").trim();
  const canonical = canonicalWrapper(current);
  if (canonical && typeof scripts?.[canonical.key] === "string") return canonical.key;
  if (!current || GENERATED_DEFAULTS.has(current) || LEGACY_DEFAULTS.has(current)) return null;
  return "preflight";
}

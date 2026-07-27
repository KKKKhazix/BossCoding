/** package.json、依赖和测试入口的共享事实判据。全部只读。 */

import fs from "node:fs";
import path from "node:path";

const NPM_DEFAULT_TEST = /^echo\s+["']?Error: no test specified["']?\s*&&\s*exit 1$/;
const PACKAGE_NAME = /^(?:@[^/\\]+\/)?[^/\\]+$/;

export function readPackageState(root) {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return { hasPackageJson: false, packageJsonValid: false, pkg: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const valid = pkg !== null && typeof pkg === "object" && !Array.isArray(pkg);
    return { hasPackageJson: true, packageJsonValid: valid, pkg: valid ? pkg : null };
  } catch {
    return { hasPackageJson: true, packageJsonValid: false, pkg: null };
  }
}

function installedPackageIsReadable(root, name) {
  if (!PACKAGE_NAME.test(name)) return false;
  const parts = name.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function yarnPnpReady(root) {
  for (const name of [".pnp.cjs", ".pnp.js"]) {
    try {
      const file = path.join(root, name);
      if (fs.lstatSync(file).isFile() && fs.statSync(file).size > 0) return true;
    } catch {
      // 继续看另一个 Yarn PnP 入口；软链和读不到的文件都不能冒充已安装。
    }
  }
  return false;
}

export function dependencyState(root, packageState = readPackageState(root), manager = null) {
  if (!packageState.hasPackageJson) {
    return { dependenciesRequired: false, depsInstalled: true, missingDependencies: [] };
  }
  if (!packageState.packageJsonValid) {
    return { dependenciesRequired: null, depsInstalled: false, missingDependencies: [] };
  }

  const names = new Set([
    ...Object.keys(packageState.pkg.dependencies ?? {}),
    ...Object.keys(packageState.pkg.devDependencies ?? {}),
  ]);
  const managerName = typeof manager === "string" ? manager : manager?.name;
  if (names.size > 0 && managerName === "yarn" && yarnPnpReady(root)) {
    return {
      dependenciesRequired: true,
      depsInstalled: true,
      missingDependencies: [],
    };
  }
  const missingDependencies = [...names].filter((name) => !installedPackageIsReadable(root, name));
  return {
    dependenciesRequired: names.size > 0,
    depsInstalled: missingDependencies.length === 0,
    missingDependencies,
  };
}

function isDefaultNodeTestFile(file) {
  const normalized = file.replaceAll("\\", "/");
  const base = path.posix.basename(normalized);
  const extension = /\.(?:cjs|mjs|js)$/i.test(base);
  if (!extension) return false;
  return (
    /(^|\/)(?:test|tests|__tests__)\//i.test(normalized) ||
    /(?:^test[-_]|[-_]test\.|\.test\.|\.spec\.)/i.test(base)
  );
}

function hasExecutableContent(root, file) {
  try {
    const body = fs.readFileSync(path.join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*(?:\/\/|#).*$/gm, "")
      .trim();
    return body.length > 0;
  } catch {
    return false;
  }
}

function isNoopTestScript(script) {
  const normalized = script.trim();
  if (/^(?:true|:|exit\s+0)$/i.test(normalized)) return true;
  if (!/[;&|]/.test(normalized) && /^(?:echo|printf)(?:\s+.*)?$/i.test(normalized)) return true;
  if (/^node\s+-e\s+(['"])(?:\s*|process\.exit(?:Code\s*=\s*0|\(0\));?)\1$/i.test(normalized)) return true;
  return false;
}

export function testEntryState(root, files, packageState = readPackageState(root)) {
  const scripts = packageState.packageJsonValid ? packageState.pkg.scripts ?? {} : {};
  const script = String(scripts.test ?? "").trim();
  if (!script || NPM_DEFAULT_TEST.test(script) || isNoopTestScript(script)) {
    return { testEntryConfigured: false, testScript: script, scripts };
  }
  if (script === "node --test") {
    const runnable = files.filter(isDefaultNodeTestFile);
    return {
      testEntryConfigured: runnable.some((file) => hasExecutableContent(root, file)),
      testScript: script,
      scripts,
    };
  }
  return { testEntryConfigured: true, testScript: script, scripts };
}

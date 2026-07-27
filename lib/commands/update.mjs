/**
 * update：把项目升级到「执行本命令的 BossCoding 版本」，再刷新框架管理的文件。
 *
 * 边界（守约）：规则真身 AGENTS.md 与门牌 CLAUDE.md 是老板的规则，本命令永不碰——
 * 「背后实时更新」只更新工具与质检，不远程改任何人的规则。模板有大改时，
 * 这里只打印新模板的位置，由老板（和他的 AI）自己对照决定要不要采纳。
 *
 * 技能与 git hook 允许「补装」而不只是刷新：新版本可能新增技能或门禁，
 * 只刷新已有文件的话，老用户永远拿不到新的。补装只对已装过 BossCoding 的
 * 项目做，免得在别人的仓库里凭空长出文件。
 *
 * 正常入口是 `npx -y bosscoding@latest update`：npm 先拿到最新 CLI，本模块再把
 * 项目 package.json、package-lock.json 与本地实际运行的包都对齐到该版本。
 * `refreshOnly` 留给已经完成依赖升级、只需要补本地文件的场景。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { installHooks } from "../hooks.mjs";
import { ensurePreflightScripts } from "../preflight.mjs";
import { installSkills } from "../skills.mjs";

// 旧版把 .claude/skills 下装成目录软链，本版换成真实副本，由 installSkills 就地迁移。

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const MANAGED = [
  [".github/workflows/bosscoding.yml", "ci.yml"],
  ["docs/decisions/_template.md", "decision-template.md"],
];

function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATES, "..", "package.json"), "utf8"));
  return pkg.version;
}

function includesMarker(target, marker) {
  try {
    return fs.readFileSync(target, "utf8").includes(marker);
  } catch {
    return false;
  }
}

function hasDependency(pkg) {
  return Boolean(pkg?.dependencies?.bosscoding || pkg?.devDependencies?.bosscoding);
}

function installedHere(abs, pkg) {
  return (
    hasDependency(pkg) ||
    includesMarker(path.join(abs, "AGENTS.md"), "<!-- bosscoding:intro-start -->") ||
    includesMarker(path.join(abs, ".github/workflows/bosscoding.yml"), "BossCoding 质检口")
  );
}

function lockVersion(target) {
  try {
    const lock = JSON.parse(fs.readFileSync(target, "utf8"));
    return lock?.packages?.["node_modules/bosscoding"]?.version ?? lock?.dependencies?.bosscoding?.version ?? null;
  } catch {
    return null;
  }
}

function localPackageVersion(abs) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(abs, "node_modules/bosscoding/package.json"), "utf8"),
    );
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function restoreFile(target, original) {
  if (original === null) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }
  fs.writeFileSync(target, original);
}

/**
 * options 允许测试替换联网命令与 CLI 版本，不需要真的访问 npm：
 *   refreshOnly：只刷新管理文件；
 *   execFileSync：替代 npm 命令执行器；
 *   cliVersion：替代当前 CLI 包版本。
 */
export function runUpdate(root = process.cwd(), options = {}) {
  const abs = path.resolve(root);
  const refreshOnly = options.refreshOnly === true;
  const runCommand = options.execFileSync ?? execFileSync;
  const cliVersion = options.cliVersion ?? packageVersion();
  let refreshed = 0;

  const pkgPath = path.join(abs, "package.json");
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      console.error(paint.red("✗ package.json 已损坏，BossCoding 没有更新任何文件。"));
      console.error('  把这句话交给 AI：「请修好 package.json，再运行 npx -y bosscoding@latest update。」');
      return 1;
    }
  }

  if (!installedHere(abs, pkg)) {
    console.error(paint.red("✗ 这个文件夹还没有安装 BossCoding，所以没有执行更新。"));
    console.error('  把这句话交给 AI：「请确认这是我的产品文件夹，然后运行 npx -y bosscoding@latest init 和 npm install。」');
    return 1;
  }

  if (!refreshOnly) {
    if (pkg === null) {
      console.error(paint.red("✗ BossCoding 安装不完整：缺少 package.json，所以没有执行更新。"));
      console.error('  把这句话交给 AI：「请在这个产品文件夹重新运行 npx -y bosscoding@latest init，再运行 npm install。」');
      return 1;
    }

    const pkgBefore = fs.readFileSync(pkgPath, "utf8");
    const lockPath = path.join(abs, "package-lock.json");
    const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const wanted = `^${cliVersion}`;
    let packageChanged = false;

    pkg.scripts ??= {};
    if (ensurePreflightScripts(pkg.scripts)) packageChanged = true;

    if (Object.hasOwn(pkg.dependencies ?? {}, "bosscoding")) {
      if (pkg.dependencies.bosscoding !== wanted) {
        pkg.dependencies.bosscoding = wanted;
        packageChanged = true;
      }
    } else {
      pkg.devDependencies ??= {};
      if (pkg.devDependencies.bosscoding !== wanted) {
        pkg.devDependencies.bosscoding = wanted;
        packageChanged = true;
      }
    }

    const lockChanged = lockVersion(lockPath) !== cliVersion;
    const localChanged = localPackageVersion(abs) !== cliVersion;
    if (packageChanged || lockChanged || localChanged) {
      if (packageChanged) fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      try {
        runCommand(
          "npm",
          ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
          { cwd: abs, stdio: "pipe", encoding: "utf8" },
        );
      } catch (error) {
        restoreFile(pkgPath, pkgBefore);
        restoreFile(lockPath, lockBefore);
        if (error?.code === "ENOENT") {
          console.error(paint.red("✗ 这台电脑找不到 npm（Node.js 自带的安装工具），BossCoding 没有完成更新。"));
        } else {
          console.error(paint.red("✗ BossCoding 没更新成功：现在可能没联网，或网络暂时连不上软件仓库。"));
        }
        console.error("  package.json 与锁定版本的文件已恢复；AGENTS.md 从未改动。");
        console.error('  把这句话交给 AI：「请检查 Node.js 和网络，恢复后重新运行 npx -y bosscoding@latest update；不要改 AGENTS.md。」');
        return 1;
      }

      if (lockVersion(lockPath) !== cliVersion || localPackageVersion(abs) !== cliVersion) {
        restoreFile(pkgPath, pkgBefore);
        restoreFile(lockPath, lockBefore);
        console.error(paint.red("✗ npm 没有正确装好新版 BossCoding，项目版本文件已恢复。"));
        console.error('  把这句话交给 AI：「请检查 npm 为什么没有装好新版 BossCoding，再运行 npx -y bosscoding@latest update；不要改 AGENTS.md。」');
        return 1;
      }

      if (packageChanged) {
        console.log(paint.green(`↻ package.json（BossCoding ${cliVersion}）`));
        refreshed += 1;
      }
      if (lockBefore !== fs.readFileSync(lockPath, "utf8")) {
        console.log(paint.green(`↻ package-lock.json（锁定 BossCoding ${cliVersion}）`));
        refreshed += 1;
      }
      if (localChanged) {
        console.log(paint.green(`↻ 本机实际运行的 BossCoding（${cliVersion}）`));
        refreshed += 1;
      }
    }
  }

  for (const [rel, tpl] of MANAGED) {
    const target = path.join(abs, rel);
    if (!fs.existsSync(target)) continue;
    const next = fs.readFileSync(path.join(TEMPLATES, tpl), "utf8");
    if (fs.readFileSync(target, "utf8") === next) continue;
    fs.writeFileSync(target, next);
    console.log(paint.green(`↻ ${rel}`));
    refreshed += 1;
  }

  const skills = installSkills(abs);
  for (const rel of skills.created) {
    console.log(paint.green(`+ ${rel}（本版新增的技能）`));
    refreshed += 1;
  }
  for (const rel of skills.migrated) {
    console.log(paint.green(`↻ ${rel}（软链换成真实副本：软链在 Windows 上克隆会失效）`));
    refreshed += 1;
  }
  for (const rel of skills.refreshed) {
    console.log(paint.green(`↻ ${rel}`));
    refreshed += 1;
  }

  // git hook 不进版本库，clone 出来的副本天生是裸的——这里补装。
  const hooks = installHooks(abs);
  for (const name of [...hooks.installed, ...hooks.refreshed]) {
    console.log(paint.green(`↻ .git/hooks/${name}（本地门禁）`));
    refreshed += 1;
  }
  if (hooks.skipped.length > 0) {
    console.log(paint.yellow(`! 已有别人的 git hook（${hooks.skipped.join("、")}），未覆盖。`));
  }

  if (refreshed === 0) {
    console.log(
      refreshOnly
        ? "框架管理的文件已是当前版本，无需刷新。"
        : `BossCoding ${cliVersion} 与框架管理的文件都已是当前版本。`,
    );
  } else {
    console.log(`\n共完成 ${refreshed} 项更新。`);
  }
  console.log(
    paint.dim(
      `你的 AGENTS.md 从不被本命令改动；想对照最新规则模板：${path.join(TEMPLATES, "AGENTS.template.md")}`,
    ),
  );
  return 0;
}

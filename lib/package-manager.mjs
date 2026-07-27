/**
 * 项目原有包管理器识别与 CI 命令渲染。
 *
 * packageManager 字段优先；没有字段时看根目录锁文件。只要出现 pnpm／Yarn／Bun
 * 的明确证据，就绝不退回 npm——多生成一份 package-lock.json 会把同一项目拆成
 * 两套互相打架的依赖真相。
 */

import fs from "node:fs";
import path from "node:path";

const DEFINITIONS = {
  npm: {
    label: "npm",
    install: "npm install",
    runPreflight: "npm run preflight",
    upgrade: "npm install --save-dev bosscoding@latest",
  },
  pnpm: {
    label: "pnpm",
    install: "pnpm install",
    runPreflight: "pnpm run preflight",
    upgrade: "pnpm add -D bosscoding@latest",
  },
  yarn: {
    label: "Yarn",
    install: "yarn install",
    runPreflight: "yarn run preflight",
    upgrade: "yarn add -D bosscoding@latest",
  },
  bun: {
    label: "Bun",
    install: "bun install",
    runPreflight: "bun run preflight",
    upgrade: "bun add -d bosscoding@latest",
  },
};

const LOCKFILES = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
  ["npm", "npm-shrinkwrap.json"],
];

const CONFIG_FILES = [
  ["pnpm", "pnpm-workspace.yaml"],
  ["yarn", ".yarnrc.yml"],
  ["yarn", ".yarn"],
  ["bun", "bunfig.toml"],
];

function declaredManager(pkg) {
  if (!pkg || !Object.hasOwn(pkg, "packageManager")) return null;
  if (typeof pkg.packageManager !== "string") {
    return { name: "unknown", version: null, raw: String(pkg.packageManager) };
  }
  const match = /^(npm|pnpm|yarn|bun)@(.+)$/.exec(pkg.packageManager.trim());
  if (!match) return { name: "unknown", version: null, raw: pkg.packageManager.trim() };
  return { name: match[1], version: match[2], raw: pkg.packageManager.trim() };
}

export function detectPackageManager(root, pkg = null) {
  const declared = declaredManager(pkg);
  const entries = [...LOCKFILES.map((item) => [...item, "lock"]), ...CONFIG_FILES.map((item) => [...item, "config"])]
    .map(([name, file, kind]) => {
      try {
        const stat = fs.lstatSync(path.join(root, file));
        const valid = kind === "config" && file === ".yarn" ? stat.isDirectory() : stat.isFile();
        return { name, file, kind, valid };
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
        return { name, file, kind, valid: false };
      }
    })
    .filter(Boolean);
  const locks = entries.filter((item) => item.kind === "lock");
  const nonNpmEvidence = [
    ...new Set(entries.filter((item) => item.name !== "npm").map((item) => item.name)),
  ];

  let name;
  if (declared && declared.name !== "npm" && declared.name !== "unknown") {
    name = declared.name;
  } else if (nonNpmEvidence.length > 0) {
    // 即使 packageManager 写着 npm，只要还留着非 npm 锁文件，也不冒险运行 npm。
    name = nonNpmEvidence[0];
  } else if (declared?.name === "unknown") {
    name = "unknown";
  } else {
    name = "npm";
  }

  const evidence = new Set(entries.map((item) => item.name));
  if (declared?.name && declared.name !== "unknown") evidence.add(declared.name);
  const ambiguous =
    declared?.name === "unknown" ||
    entries.some((item) => !item.valid) ||
    evidence.size > 1 ||
    nonNpmEvidence.length > 1 ||
    locks.length > 1 ||
    name === "unknown";
  const definition = DEFINITIONS[name] ?? {
    label: "无法确定的包管理器",
    install: null,
    runPreflight: null,
    upgrade: null,
  };

  return {
    ...definition,
    name,
    version: declared?.name === name ? declared.version : null,
    declared: declared?.raw ?? null,
    locks: locks.map((item) => item.file),
    ambiguous,
  };
}

export function packageManagerCommand(manager, action, options = {}) {
  const name = typeof manager === "string" ? manager : manager?.name;
  const locks = typeof manager === "object" ? manager.locks ?? [] : [];
  if (!DEFINITIONS[name]) throw new Error(`不支持的包管理器：${name ?? "未知"}`);

  if (action === "install") {
    if (name === "npm") {
      const hasLock =
        locks.includes("package-lock.json") || locks.includes("npm-shrinkwrap.json");
      const command = options.frozen && hasLock ? "ci" : "install";
      const ignoreScripts = options.ignoreScripts ? ["--ignore-scripts"] : [];
      return {
        command: "npm",
        args: [command, "--include=dev", ...ignoreScripts, "--no-audit", "--no-fund"],
      };
    }
    if (name === "pnpm") {
      return {
        command: "pnpm",
        args: ["install", ...(options.frozen ? ["--frozen-lockfile"] : [])],
      };
    }
    if (name === "yarn") {
      const major = Number.parseInt(manager?.version?.split(".")[0] ?? "", 10);
      const frozenFlag = Number.isFinite(major) && major >= 2 ? "--immutable" : "--frozen-lockfile";
      return {
        command: "yarn",
        args: ["install", ...(options.frozen ? [frozenFlag] : [])],
      };
    }
    return {
      command: "bun",
      args: ["install", ...(options.frozen ? ["--frozen-lockfile"] : [])],
    };
  }

  if (action === "run-script") {
    if (!options.script) throw new Error("run-script 缺少 script");
    return { command: name, args: ["run", options.script] };
  }

  if (action === "exec-boss") {
    const bossArgs = options.args ?? [];
    if (name === "npm") {
      return { command: "./node_modules/.bin/bosscoding", args: bossArgs };
    }
    if (name === "pnpm") return { command: "pnpm", args: ["exec", "bosscoding", ...bossArgs] };
    if (name === "yarn") return { command: "yarn", args: ["exec", "bosscoding", ...bossArgs] };
    return { command: "bun", args: ["run", "bosscoding", ...bossArgs] };
  }

  if (action === "upgrade-bosscoding") {
    if (name === "npm") return { command: "npm", args: ["install", "--save-dev", "bosscoding@latest"] };
    if (name === "pnpm") return { command: "pnpm", args: ["add", "-D", "bosscoding@latest"] };
    if (name === "yarn") return { command: "yarn", args: ["add", "-D", "bosscoding@latest"] };
    return { command: "bun", args: ["add", "-d", "bosscoding@latest"] };
  }

  throw new Error(`不支持的包管理器动作：${action}`);
}

export function runPackageManager(runner, root, manager, action, options = {}) {
  const invocation = packageManagerCommand(manager, action, options);
  return runner(invocation.command, invocation.args, {
    cwd: root,
    ...(options.execOptions ?? {}),
  });
}

function ciCommands(manager) {
  if (!DEFINITIONS[manager.name]) {
    throw new Error("无法为未知包管理器生成 CI");
  }

  if (manager.name === "npm") {
    return {
      setup: "",
      install:
        "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi",
      preflight: "npm run preflight",
    };
  }
  if (manager.name === "pnpm") {
    return {
      setup: "      - name: 准备 pnpm\n        run: corepack enable",
      install: "pnpm install --frozen-lockfile",
      preflight: "pnpm run preflight",
    };
  }
  if (manager.name === "yarn") {
    const major = Number.parseInt(manager.version?.split(".")[0] ?? "", 10);
    return {
      setup: "      - name: 准备 Yarn\n        run: corepack enable",
      install: Number.isFinite(major) && major >= 2 ? "yarn install --immutable" : "yarn install --frozen-lockfile",
      preflight: "yarn run preflight",
    };
  }
  return {
    setup: "      - name: 准备 Bun\n        uses: oven-sh/setup-bun@v2",
    install: "bun install --frozen-lockfile",
    preflight: "bun run preflight",
  };
}

export function renderCi(template, { manager, branch }) {
  const commands = ciCommands(manager);
  return template
    .replaceAll("__BOSSCODING_BRANCH__", JSON.stringify(branch))
    .replace("__BOSSCODING_MANAGER_SETUP__", commands.setup)
    .replace("__BOSSCODING_INSTALL__", commands.install)
    .replace("__BOSSCODING_PREFLIGHT__", commands.preflight);
}

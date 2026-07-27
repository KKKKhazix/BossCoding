import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectPackageManager,
  packageManagerCommand,
  renderCi,
  runPackageManager,
} from "../lib/package-manager.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-manager-"));
}

test("包管理器：packageManager 与根级锁文件都能识别 pnpm／Yarn／Bun", () => {
  const cases = [
    ["pnpm", "pnpm@9.1.0", "pnpm-lock.yaml"],
    ["yarn", "yarn@4.2.0", "yarn.lock"],
    ["bun", "bun@1.1.0", "bun.lockb"],
  ];
  for (const [name, declaration, lock] of cases) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, lock), "lock\n");
    const manager = detectPackageManager(dir, { packageManager: declaration });
    assert.equal(manager.name, name);
    assert.equal(manager.ambiguous, false);
  }
});

test("包管理器：非 npm 的安装、脚本、自检与升级 argv 全程不回退 npm 或短名 boss", () => {
  for (const name of ["pnpm", "yarn", "bun"]) {
    const manager = { name, locks: [], version: name === "yarn" ? "4.0.0" : null };
    const invocations = [
      packageManagerCommand(manager, "install", { frozen: true }),
      packageManagerCommand(manager, "run-script", { script: "test" }),
      packageManagerCommand(manager, "exec-boss", { args: ["check"] }),
      packageManagerCommand(manager, "upgrade-bosscoding"),
    ];
    const serialized = JSON.stringify(invocations);
    assert.doesNotMatch(serialized, /"npm"|"npx"|["]boss["]/);
    assert.match(serialized, /bosscoding/);
  }

  const npmBoss = packageManagerCommand({ name: "npm" }, "exec-boss", { args: ["check"] });
  assert.equal(npmBoss.command, "./node_modules/.bin/bosscoding");
  assert.deepEqual(npmBoss.args, ["check"]);
});

test("包管理器：runner 接口可直接给 task／finish 注入，不需要各自拼命令", () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return "ok";
  };
  const manager = { name: "pnpm", locks: ["pnpm-lock.yaml"], version: "9.0.0" };
  const result = runPackageManager(runner, "/project", manager, "install", {
    frozen: true,
    execOptions: { stdio: "inherit" },
  });

  assert.equal(result, "ok");
  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      options: { cwd: "/project", stdio: "inherit" },
    },
  ]);
});

test("包管理器：多套锁文件明确标冲突，调用方必须拒绝而不是任选一套", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "pnpm\n");
  fs.writeFileSync(path.join(dir, "yarn.lock"), "yarn\n");
  const manager = detectPackageManager(dir, { packageManager: "pnpm@9.0.0" });
  assert.equal(manager.ambiguous, true);
});

test("包管理器：无法识别的声明与同类重复锁也不能靠猜测继续", () => {
  const unknown = tmp();
  fs.writeFileSync(path.join(unknown, "pnpm-lock.yaml"), "pnpm\n");
  assert.equal(
    detectPackageManager(unknown, { packageManager: "mystery@1.0.0" }).ambiguous,
    true,
  );

  const duplicate = tmp();
  fs.writeFileSync(path.join(duplicate, "bun.lock"), "bun\n");
  fs.writeFileSync(path.join(duplicate, "bun.lockb"), "bun\n");
  assert.equal(detectPackageManager(duplicate).ambiguous, true);

  const wrongType = tmp();
  assert.equal(detectPackageManager(wrongType, { packageManager: 123 }).ambiguous, true);
});

test("包管理器：尚无锁文件时也识别 pnpm／Yarn／Bun 的项目级配置", () => {
  const cases = [
    ["pnpm", "pnpm-workspace.yaml", "packages:\n  - apps/*\n", false],
    ["yarn", ".yarnrc.yml", "nodeLinker: node-modules\n", false],
    ["yarn", ".yarn", null, true],
    ["bun", "bunfig.toml", "[install]\n", false],
  ];
  for (const [name, marker, body, directory] of cases) {
    const dir = tmp();
    if (directory) fs.mkdirSync(path.join(dir, marker));
    else fs.writeFileSync(path.join(dir, marker), body);
    const manager = detectPackageManager(dir);
    assert.equal(manager.name, name);
    assert.equal(manager.ambiguous, false);
  }
});

test("包管理器：npm-shrinkwrap 与 package-lock 一样走冻结安装", () => {
  const invocation = packageManagerCommand(
    { name: "npm", locks: ["npm-shrinkwrap.json"] },
    "install",
    { frozen: true },
  );
  assert.equal(invocation.command, "npm");
  assert.equal(invocation.args[0], "ci");
});

test("包管理器：普通安装默认运行项目依赖脚本，只有调用方明确要求才禁用", () => {
  const normal = packageManagerCommand({ name: "npm", locks: [] }, "install");
  const restricted = packageManagerCommand(
    { name: "npm", locks: [] },
    "install",
    { ignoreScripts: true },
  );
  assert.equal(normal.args.includes("--ignore-scripts"), false);
  assert.equal(restricted.args.includes("--ignore-scripts"), true);
});

test("CI：只运行项目自己的 preflight，总闸与本地交付保持同一份", () => {
  const template = [
    "branch=__BOSSCODING_BRANCH__",
    "__BOSSCODING_MANAGER_SETUP__",
    "install=__BOSSCODING_INSTALL__",
    "quality=__BOSSCODING_PREFLIGHT__",
  ].join("\n");
  const cases = [
    ["npm", "npm run preflight"],
    ["pnpm", "pnpm run preflight"],
    ["yarn", "yarn run preflight"],
    ["bun", "bun run preflight"],
  ];

  for (const [name, command] of cases) {
    const ci = renderCi(template, {
      manager: { name, version: name === "yarn" ? "4.0.0" : null },
      branch: "trunk",
    });
    assert.match(ci, /branch="trunk"/);
    assert.match(ci, new RegExp(`quality=${command.replaceAll(" ", "\\s")}`));
    assert.doesNotMatch(ci, /\bboss check\b|__BOSSCODING_/);
  }
});

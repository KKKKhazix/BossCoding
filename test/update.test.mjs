import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runUpdate } from "../lib/commands/update.mjs";
import { DEFAULT_PREFLIGHT } from "../lib/preflight.mjs";

const CLI = fileURLToPath(new URL("../bin/bosscoding.mjs", import.meta.url));
const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-update-"));
}

function initGit(dir) {
  const child = spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
}

function packageBody(version = "^0.3.0") {
  return `${JSON.stringify(
    {
      name: "existing-product",
      version: "1.0.0",
      private: true,
      devDependencies: { bosscoding: version },
    },
    null,
    2,
  )}\n`;
}

function lockBody(version, wanted = `^${version}`) {
  return `${JSON.stringify(
    {
      name: "existing-product",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { bosscoding: wanted } },
        "node_modules/bosscoding": { version },
      },
    },
    null,
    2,
  )}\n`;
}

function captureConsole(action) {
  const output = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => output.push(args.join(" "));
  try {
    return { result: action(), output: output.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

test("update：未安装项目会失败，不再假装已经是当前版本", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 别人的规则\n");

  const child = spawnSync(process.execPath, [CLI, "update"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1);
  assert.match(output, /还没有安装 BossCoding/);
  assert.match(output, /把这句话交给 AI/);
  assert.doesNotMatch(output, /无需刷新|都已是当前版本|Error:|node:/);
  assert.equal(fs.existsSync(path.join(dir, ".agents")), false);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "# 别人的规则\n");
});

test("update：latest CLI 升级 package.json 与锁定版本，再刷新管理文件", () => {
  const dir = tmpProject();
  initGit(dir);
  const agents = "# 老板自己的规则\n\n绝不能被 update 改写。\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockBody("0.3.0"));
  fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "旧质检文件\n");

  let calls = 0;
  const fakeNpm = (command, args, options) => {
    calls += 1;
    assert.equal(command, "npm");
    assert.deepEqual(args, [
      "install",
      "--include=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    assert.equal(args.includes("--package-lock-only"), false);
    assert.equal(options.cwd, dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.devDependencies.bosscoding, "^9.9.9");
    fs.writeFileSync(path.join(dir, "package-lock.json"), lockBody("9.9.9"));
    fs.mkdirSync(path.join(dir, "node_modules/bosscoding"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "node_modules/bosscoding/package.json"),
      `${JSON.stringify({ name: "bosscoding", version: "9.9.9" })}\n`,
    );
  };

  const captured = captureConsole(() =>
    runUpdate(dir, { cliVersion: "9.9.9", execFileSync: fakeNpm }),
  );
  assert.equal(captured.result, 0);
  assert.equal(calls, 1);
  const updatedPackage = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(updatedPackage.devDependencies.bosscoding, "^9.9.9");
  assert.equal(updatedPackage.scripts.preflight, DEFAULT_PREFLIGHT);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"))
      .packages["node_modules/bosscoding"].version,
    "9.9.9",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "node_modules/bosscoding/package.json"), "utf8")).version,
    "9.9.9",
  );
  assert.equal(
    fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8"),
    fs.readFileSync(path.join(TEMPLATES, "ci.yml"), "utf8"),
  );
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), agents);
  assert.match(captured.output, /package\.json（BossCoding 9\.9\.9）/);
  assert.match(captured.output, /package-lock\.json（锁定 BossCoding 9\.9\.9）/);
});

test("update：离线失败说人话并恢复 package.json／锁文件，绝不改 AGENTS.md", () => {
  const dir = tmpProject();
  const agents = "# 老板自己的规则\n";
  const pkgBefore = packageBody();
  const lockBefore = lockBody("0.3.0");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockBefore);

  const offline = () => {
    const error = new Error("network unreachable");
    error.code = "ENETUNREACH";
    throw error;
  };
  const captured = captureConsole(() =>
    runUpdate(dir, { cliVersion: "9.9.9", execFileSync: offline }),
  );

  assert.equal(captured.result, 1);
  assert.match(captured.output, /可能没联网/);
  assert.match(captured.output, /锁定版本的文件已恢复/);
  assert.match(captured.output, /把这句话交给 AI/);
  assert.doesNotMatch(captured.output, /network unreachable|\n\s+at /);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
  assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), lockBefore);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), agents);
});

test("update：refreshOnly 只补管理文件，不联网也不改依赖", () => {
  const dir = tmpProject();
  initGit(dir);
  const pkgBefore = packageBody();
  fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);
  fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "旧质检文件\n");

  let called = false;
  const captured = captureConsole(() =>
    runUpdate(dir, {
      refreshOnly: true,
      cliVersion: "9.9.9",
      execFileSync: () => {
        called = true;
        throw new Error("不该调用");
      },
    }),
  );

  assert.equal(captured.result, 0);
  assert.equal(called, false);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
  assert.equal(
    fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8"),
    fs.readFileSync(path.join(TEMPLATES, "ci.yml"), "utf8"),
  );
});

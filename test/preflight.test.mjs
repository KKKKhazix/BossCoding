import { test } from "node:test";
import assert from "node:assert/strict";

import {
  customPreflightScript,
  DEFAULT_PREFLIGHT,
  defaultPreflight,
  ensurePreflightScripts,
} from "../lib/preflight.mjs";

test("preflight 合同：空配置与旧版仅守卫配置都补齐必跑的产品测试", () => {
  for (const original of [undefined, "boss check", "npm test --if-present && boss check"]) {
    const scripts = { preflight: original };
    assert.equal(ensurePreflightScripts(scripts), true);
    assert.equal(scripts.preflight, DEFAULT_PREFLIGHT);
  }
  const current = { preflight: DEFAULT_PREFLIGHT };
  assert.equal(ensurePreflightScripts(current), false);
});

test("preflight 合同：既有复杂命令放进独立子进程，不能靠 shell 优先级跳过守卫", () => {
  const scripts = { preflight: "npm run lint || true", lint: "node lint.mjs" };
  assert.equal(ensurePreflightScripts(scripts), true);
  assert.equal(scripts["preflight:project"], "npm run lint || true");
  assert.equal(scripts.preflight, "npm run preflight:project && npm test && bosscoding check");
  assert.equal(customPreflightScript(scripts), "preflight:project");
  assert.equal(ensurePreflightScripts(scripts), false);
});

test("preflight 合同：不覆盖用户已有的同名子脚本", () => {
  const scripts = {
    preflight: "npm run typecheck",
    "preflight:project": "npm run lint",
  };
  ensurePreflightScripts(scripts);
  assert.equal(scripts["preflight:project"], "npm run lint");
  assert.equal(scripts["preflight:project:2"], "npm run typecheck");
  assert.equal(scripts.preflight, "npm run preflight:project:2 && npm test && bosscoding check");
});

test("preflight 合同：包装器引用的子脚本丢失时重置，不形成自递归", () => {
  const scripts = { preflight: "npm run preflight:project && npm test && boss check" };
  assert.equal(ensurePreflightScripts(scripts), true);
  assert.equal(scripts.preflight, DEFAULT_PREFLIGHT);
  assert.equal(scripts["preflight:project"], undefined);
});

test("preflight 合同：pnpm／Yarn／Bun 使用原管理器跑测试，本地检查只调用唯一全名", () => {
  const expected = {
    pnpm: "pnpm run test && bosscoding check",
    yarn: "yarn test && bosscoding check",
    bun: "bun run test && bosscoding check",
  };
  for (const [manager, command] of Object.entries(expected)) {
    const scripts = {};
    assert.equal(ensurePreflightScripts(scripts, manager), true);
    assert.equal(scripts.preflight, command);
    assert.equal(command, defaultPreflight(manager));
    assert.doesNotMatch(command, /\bnpm\b|\bboss check\b|npx|bunx/);
  }
});

test("preflight 合同：从旧 npm 包装器迁到 pnpm 时保留自定义子检查，不把 npm 当成新外壳", () => {
  const scripts = {
    preflight: "npm run preflight:project && npm test && boss check",
    "preflight:project": "node lint.mjs",
  };
  assert.equal(ensurePreflightScripts(scripts, "pnpm"), true);
  assert.equal(
    scripts.preflight,
    "pnpm run preflight:project && pnpm run test && bosscoding check",
  );
  assert.equal(scripts["preflight:project"], "node lint.mjs");
  assert.equal(customPreflightScript(scripts), "preflight:project");
});

/**
 * CI 配置守卫单测。纪律同 guards.test.mjs：每条检查都要有「制造违规 → 必须被抓」，
 * 只测干净通过等于没测。
 *
 * 另外每条都要有「没用这个写法的项目一声不吭」的反面测试——这道守卫敢一次收三条，
 * 靠的就是它只在你真的用了那个写法时才出声。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createContext } from "../lib/context.mjs";
import { runCheck } from "../lib/commands/check.mjs";
import ciKnownTraps from "../lib/guards/ci-known-traps.mjs";

function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-citraps-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  return createContext(dir);
}

const PLAIN_WORKFLOW = `name: ci
on:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - name: 测试
        run: npm test
`;

test("干净的 workflow 一声不吭", () => {
  const ctx = makeRepo({ ".github/workflows/ci.yml": PLAIN_WORKFLOW });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

test("非 workflow 的 yml 不扫（不是所有 yaml 都是 GitHub Actions）", () => {
  const ctx = makeRepo({ "docker-compose.yml": "services:\n  a:\n    continue-on-error: true\n" });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

test("项目声明安装 BossCoding 却缺官方质检文件时必须提醒", () => {
  const ctx = makeRepo({
    "package.json": '{"devDependencies":{"bosscoding":"^0.5.0"}}\n',
  });
  const problems = ciKnownTraps.run(ctx);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, ".github/workflows/bosscoding.yml");
  assert.equal(problems[0].level, "warn");
  assert.match(problems[0].msg, /不会自动检查/);
});

// ---- 坑一：可选步骤没有上限 ----

test("抓：continue-on-error 的步骤没有 timeout", () => {
  const ctx = makeRepo({
    ".github/workflows/ci.yml": `${PLAIN_WORKFLOW}      - name: 可选加速
        continue-on-error: true
        run: ./mirror.sh
`,
  });
  const problems = ciKnownTraps.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].msg, /timeout-minutes/);
  assert.equal(problems[0].level, "warn");
});

test("放过：同一步骤里有 timeout 就不报", () => {
  const ctx = makeRepo({
    ".github/workflows/ci.yml": `${PLAIN_WORKFLOW}      - name: 可选加速
        continue-on-error: true
        timeout-minutes: 2
        run: ./mirror.sh
`,
  });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

test("放过：timeout 写在 continue-on-error 前面也算（同一块，不看先后）", () => {
  const ctx = makeRepo({
    ".github/workflows/ci.yml": `${PLAIN_WORKFLOW}      - name: 可选加速
        timeout-minutes: 2
        continue-on-error: true
        run: ./mirror.sh
`,
  });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

test("不越界：隔壁步骤的 timeout 不能替本步骤背书", () => {
  const ctx = makeRepo({
    ".github/workflows/ci.yml": `${PLAIN_WORKFLOW}      - name: 有上限的正常步骤
        timeout-minutes: 3
        run: npm run build
      - name: 可选加速
        continue-on-error: true
        run: ./mirror.sh
`,
  });
  assert.equal(ciKnownTraps.run(ctx).length, 1);
});

test("抓：任务级 continue-on-error 也要有上限", () => {
  const ctx = makeRepo({
    ".github/workflows/ci.yml": `name: ci
on:
  push:
    branches: [main]
jobs:
  optional:
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - run: ./mirror.sh
`,
  });
  assert.equal(ciKnownTraps.run(ctx).length, 1);
});

// ---- 坑二：workflow_run 不筛不钉 ----

test("抓：workflow_run 既没筛结论也没钉 head_sha", () => {
  const ctx = makeRepo({
    ".github/workflows/deploy.yml": `name: deploy
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - run: ./deploy.sh
`,
  });
  const problems = ciKnownTraps.run(ctx);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /筛上游结论/.test(p.msg)));
  assert.ok(problems.some((p) => /head_sha/.test(p.msg)));
});

test("放过：筛了结论并钉了 head_sha", () => {
  const ctx = makeRepo({
    ".github/workflows/deploy.yml": `name: deploy
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
jobs:
  deploy:
    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' }}
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
      - run: ./deploy.sh
`,
  });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

// ---- 坑三：S3 兼容存储的默认校验 ----

test("抓：对自定义 endpoint 用 aws cli 却没关默认校验", () => {
  const ctx = makeRepo({
    "upload.sh": "#!/bin/sh\naws s3api put-object --endpoint-url https://cos.example.com --bucket b --key k --body f\n",
  });
  const problems = ciKnownTraps.run(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0].fix, /when_required/);
});

test("放过：关掉了默认校验", () => {
  const ctx = makeRepo({
    "upload.sh": `#!/bin/sh
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
aws s3api put-object --endpoint-url https://cos.example.com --bucket b --key k --body f
`,
  });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

test("放过：用的是 AWS 官方 endpoint（没有 --endpoint-url）", () => {
  const ctx = makeRepo({ "upload.sh": "#!/bin/sh\naws s3api put-object --bucket b --key k --body f\n" });
  assert.deepEqual(ciKnownTraps.run(ctx), []);
});

// ---- 提醒级别：新检查不得把用户昨天还绿的仓库改红 ----

test("提醒不改退出码：整道 check 仍然是通过", () => {
  const ctx = makeRepo({
    ".gitignore": "node_modules/\n.env\n.env.local\n.env.*.local\n",
    "AGENTS.md": "# 项目规则\n\n正文。\n",
    "CLAUDE.md": "@AGENTS.md\n",
    ".github/workflows/ci.yml": `${PLAIN_WORKFLOW}      - name: 可选加速
        continue-on-error: true
        run: ./mirror.sh
`,
  });
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(runCheck(ctx.root), 0);
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  // 但它确实出了声——只提醒不等于不说。
  assert.equal(ciKnownTraps.run(ctx).length, 1);
});

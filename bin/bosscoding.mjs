#!/usr/bin/env node
/**
 * BossCoding 命令入口。三个命令，没有更多：
 *   init    开司筹备：把流程地基装进当前项目（幂等，不覆盖已有内容）
 *   check   跑守卫：8 项机器检查，任一红即非零退出
 *   update  刷新框架管理的文件（老板的规则永不被碰）
 *
 * 命令名有两个：安装场景必须用全名 `npx bosscoding`（项目外裸跑短名会解析到
 * npm 上别人的同名包）；装进项目后日常用短名 `npx boss`（本地命令优先）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `BossCoding——你是老板：需求你说，制度盯人。

用法：
  npx bosscoding init   开司筹备：装好规则文件、守卫、质检口、决策档案与技能
  npx boss check        跑 8 项守卫（npm run preflight 的内核；装完后短名即可）
  npx boss update       刷新框架管理的文件（CI／决策模板／技能；你的规则永不被碰）

装完后对你的 AI 说：「读一遍 AGENTS.md。之后需求我说，规矩你守。」
`;

async function main() {
  const cmd = process.argv[2];

  if (cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "package.json"), "utf8"),
    );
    console.log(pkg.version);
    return 0;
  }

  if (cmd === "init") {
    const { runInit } = await import("../lib/commands/init.mjs");
    return runInit();
  }
  if (cmd === "check") {
    const { runCheck } = await import("../lib/commands/check.mjs");
    return runCheck();
  }
  if (cmd === "update") {
    const { runUpdate } = await import("../lib/commands/update.mjs");
    return runUpdate();
  }

  console.log(HELP);
  return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 1;
}

process.exit(await main());

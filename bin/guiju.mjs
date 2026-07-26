#!/usr/bin/env node
/**
 * 规矩（guiju）命令入口。三个命令，没有更多：
 *   init    开店筹备：把流程地基装进当前项目（幂等，不覆盖已有内容）
 *   check   跑守卫：8 项机器检查，任一红即非零退出
 *   update  刷新框架管理的文件（店规永不被碰）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `规矩（guiju）——给 AI 协作项目的开发流程地基

用法：
  npx guiju init      开店筹备：装好规则文件、守卫、质检口、决策档案与技能
  npx guiju check     跑 8 项守卫（npm run preflight 的内核）
  npx guiju update    刷新框架管理的文件（CI／决策模板／技能；店规永不被碰）

装完后对你的 AI 说：「读一遍 AGENTS.md，然后我们开工」。
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

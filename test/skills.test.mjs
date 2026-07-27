/**
 * 技能安装单测。要害是「不许是软链」——软链会被提交进版本库，Windows 上克隆后
 * 变成一个写着路径的文本文件，两个技能同时静默失效，现象是「AI 就是不按规矩走」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installSkills, SKILLS } from "../lib/skills.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-skills-"));
}

test("装：两个目录各一份真实文件，都不是软链", () => {
  const dir = tmp();
  const result = installSkills(dir);
  assert.equal(result.created.length, SKILLS.length * 2);
  for (const skill of SKILLS) {
    for (const base of [".agents/skills", ".claude/skills"]) {
      const entry = path.join(dir, base, skill);
      assert.ok(fs.existsSync(path.join(entry, "SKILL.md")), `缺 ${base}/${skill}`);
      assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, `${base}/${skill} 不该是软链`);
    }
  }
});

test("装：幂等——再跑一次什么都不动", () => {
  const dir = tmp();
  installSkills(dir);
  const again = installSkills(dir);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.refreshed, []);
  assert.deepEqual(again.migrated, []);
});

test("升级：旧版留下的软链就地换成真实副本", () => {
  const dir = tmp();
  installSkills(dir);
  // 还原成旧形态：.claude/skills/boss-flow 是指向 .agents 的目录软链。
  const claudeEntry = path.join(dir, ".claude/skills/boss-flow");
  fs.rmSync(claudeEntry, { recursive: true, force: true });
  fs.symlinkSync(path.join("..", "..", ".agents", "skills", "boss-flow"), claudeEntry);
  assert.equal(fs.lstatSync(claudeEntry).isSymbolicLink(), true);

  const result = installSkills(dir);
  assert.deepEqual(result.migrated, [".claude/skills/boss-flow/SKILL.md"]);
  assert.equal(fs.lstatSync(claudeEntry).isSymbolicLink(), false);
  assert.match(fs.readFileSync(path.join(claudeEntry, "SKILL.md"), "utf8"), /name: boss-flow/);
});

test("让路：别人手写的同名技能不动", () => {
  const dir = tmp();
  const mine = path.join(dir, ".agents/skills/boss-flow/SKILL.md");
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, "---\nname: 我自己写的\n---\n别动我。\n");
  const result = installSkills(dir);
  assert.ok(result.skipped.includes(".agents/skills/boss-flow/SKILL.md"));
  assert.match(fs.readFileSync(mine, "utf8"), /别动我/);
});

test("交付技能：AI 负责预览、本地收尾与老板下一步", () => {
  const dir = tmp();
  installSkills(dir);
  const flow = fs.readFileSync(path.join(dir, ".agents/skills/boss-flow/SKILL.md"), "utf8");

  assert.match(flow, /启动并直接打开给老板看/);
  assert.match(flow, /只有真实环境限制/);
  assert.match(flow, /npx bosscoding finish/);
  assert.doesNotMatch(flow, /git checkout main/);
  assert.match(flow, /docs\/decisions\//);
  assert.match(flow, /不自动删除任务工作区/);
  assert.match(flow, /一句可直接说给 AI 的自然语言/);
});

test("四阶梯技能：先验收再注册，质检承诺不夸大", () => {
  const dir = tmp();
  installSkills(dir);
  const ladder = fs.readFileSync(path.join(dir, ".agents/skills/boss-ladder/SKILL.md"), "utf8");

  assert.match(ladder, /第一版已经打开给老板看，并且老板明确验收通过后，才提 GitHub/);
  assert.doesNotMatch(ladder, /第一次埋头干活/);
  assert.match(ladder, /自动检查/);
  assert.match(ladder, /本机保护/);
  assert.match(ladder, /不一定能硬性拦住网页合并/);
  assert.match(ladder, /不要让老板执行命令或清理工作区/);
});

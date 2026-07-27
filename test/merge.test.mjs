/**
 * 排队判定单测。核心是纯函数 decide()，所以竞态相关的行为可以确定性地测——
 * 这正是把「查一眼队列空不空」换成「我是不是号最小的」的收益：判定不再依赖时机。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide, parseRemote, runMerge } from "../lib/commands/merge.mjs";

const NOW = Date.parse("2026-07-27T12:00:00Z");
const fresh = new Date(NOW - 60 * 1000).toISOString(); // 1 分钟前动过
const stale = new Date(NOW - 40 * 60 * 1000).toISOString(); // 40 分钟没动静

const pr = (number, branch, extra = {}) => ({
  number,
  title: `活儿 ${number}`,
  draft: false,
  updated_at: fresh,
  head: { ref: branch },
  ...extra,
});

test("解析 origin：https 与 ssh 两种写法都认", () => {
  assert.deepEqual(parseRemote("https://github.com/KKKKhazix/BossCoding.git"), {
    owner: "KKKKhazix",
    repo: "BossCoding",
  });
  assert.deepEqual(parseRemote("git@github.com:KKKKhazix/BossCoding.git"), {
    owner: "KKKKhazix",
    repo: "BossCoding",
  });
  assert.equal(parseRemote("https://gitlab.com/a/b.git"), null);
});

test("我是号最小的 → 轮到我", () => {
  const r = decide({ pulls: [pr(7, "lane/a"), pr(9, "lane/b")], myBranch: "lane/a", now: NOW });
  assert.equal(r.verdict, "go");
  assert.equal(r.mine.number, 7);
});

test("前面有号更小的 → 等，并且说清在等谁", () => {
  const r = decide({ pulls: [pr(7, "lane/a"), pr(9, "lane/b")], myBranch: "lane/b", now: NOW });
  assert.equal(r.verdict, "wait");
  assert.equal(r.blocker.number, 7);
});

test("两条并行同时问，答案一致（这正是约定输给竞态的地方）", () => {
  const pulls = [pr(7, "lane/a"), pr(9, "lane/b")];
  const a = decide({ pulls, myBranch: "lane/a", now: NOW });
  const b = decide({ pulls, myBranch: "lane/b", now: NOW + 57 * 1000 }); // 相隔 57 秒
  assert.equal(a.verdict, "go");
  assert.equal(b.verdict, "wait");
  assert.equal(b.blocker.number, a.mine.number); // 谁赢由号决定，与谁先问无关
});

test("Draft 不占队列：草稿还没送检", () => {
  const pulls = [pr(7, "lane/a", { draft: true }), pr(9, "lane/b")];
  const r = decide({ pulls, myBranch: "lane/b", now: NOW });
  assert.equal(r.verdict, "go");
});

test("队头停滞超过 15 分钟按弃权放行", () => {
  const pulls = [pr(7, "lane/a", { updated_at: stale }), pr(9, "lane/b")];
  const r = decide({ pulls, myBranch: "lane/b", now: NOW });
  assert.equal(r.verdict, "go");
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].pr.number, 7);
});

test("弃权放行后不再回头抢占确认（否则永远轮不到，死循环）", () => {
  // 前面两个都僵着：放行必须一路放到我，而不是「跳过 7 之后又发现 8 比我小」。
  const pulls = [
    pr(7, "lane/a", { updated_at: stale }),
    pr(8, "lane/b", { updated_at: stale }),
    pr(9, "lane/c"),
  ];
  const r = decide({ pulls, myBranch: "lane/c", now: NOW });
  assert.equal(r.verdict, "go");
  assert.equal(r.skipped.length, 2);
});

test("弃权只赦免僵住的那个：它后面还活着的号更小者照样要等", () => {
  const pulls = [pr(7, "lane/a", { updated_at: stale }), pr(8, "lane/b"), pr(9, "lane/c")];
  const r = decide({ pulls, myBranch: "lane/c", now: NOW });
  assert.equal(r.verdict, "wait");
  assert.equal(r.blocker.number, 8);
});

test("我还没开 PR：队列空则放行，有人在排就等", () => {
  assert.equal(decide({ pulls: [], myBranch: "lane/new", now: NOW }).verdict, "go");
  assert.equal(decide({ pulls: [pr(7, "lane/a")], myBranch: "lane/new", now: NOW }).verdict, "wait");
});

test("--pr 指定编号时按编号认领，不看分支名", () => {
  const pulls = [pr(7, "lane/a"), pr(9, "lane/b")];
  const r = decide({ pulls, myBranch: "随便什么分支", myNumber: 7, now: NOW });
  assert.equal(r.verdict, "go");
});

test("端到端：退出码 0 ＝ 轮到你，1 ＝ 还没轮到", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-merge-"));
  execFileSync("git", ["init", "-b", "lane/b"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: dir, stdio: "ignore" });

  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    const fetchPulls = async () => [pr(7, "lane/a"), pr(9, "lane/b")];
    assert.equal(await runMerge(dir, { fetchPulls, now: NOW }), 1);
    const aloneOnQueue = async () => [pr(9, "lane/b")];
    assert.equal(await runMerge(dir, { fetchPulls: aloneOnQueue, now: NOW }), 0);
    // 查不到就明确失败，不能蒙着说「轮到你了」。
    const broken = async () => {
      throw new Error("boom");
    };
    assert.equal(await runMerge(dir, { fetchPulls: broken, now: NOW }), 1);
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
});

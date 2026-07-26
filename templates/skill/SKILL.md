---
name: boss-flow
description: 按 BossCoding 流程开始并交付一个开发任务。项目里装有 bosscoding（根目录有 AGENTS.md 与 npx boss check）且用户提出开发需求（加功能、修 bug、改配置）时使用；纯问答不触发。
---

# BossCoding 干活流程

1. 开工前读项目根目录的 AGENTS.md——规则文件、导师模式与红线都在里面，全程遵守。
2. 从 main 开一条新分支；一个任务一个分支一个 PR。
3. 改完先跑 `npm run preflight`（守卫＋测试）；红了先修，不带红提交。
4. 提交并开 Draft PR，正文写清改了什么、为什么。
5. 转 Ready 前查一下有没有别的 PR 已在排队（并行开发、串行合并）；有就等它先进。
6. CI 绿后按项目规则合并；CI 红了先修复或撤销，不新增门禁。
7. 触碰规则文件红线的操作（删数据、对外发布、花钱、动密钥）：先说明、等老板确认，再动手。

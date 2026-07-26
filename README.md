# 规矩（guiju）

> 不以规矩，不能成方圆。

**给 AI 协作项目的开发流程地基。**一条命令，把一套经过真实项目打磨的工程规矩装进你的新项目：规则文件、机器守卫、云端质检、决策档案、开工流程。之后你只管对 AI 说需求——它会按规矩干活，并且边干边用大白话教你每一步在做什么。

不挑工具：Codex、Claude Code、Kimi Code、Qwen Code、Cursor、GitHub Copilot、Trae、CodeBuddy、通义灵码、Gemini CLI、iFlow 读到的是同一份规矩。

## 三步开始（不需要会写代码）

```bash
npx guiju init
```

```bash
npm install
```

然后对你的 AI 说：**「读一遍 AGENTS.md，然后我们开工。」**

## 装了什么

| 文件 | 是什么 |
|---|---|
| `AGENTS.md` | 店规：AI 的行为规则真身。含**导师模式**（AI 必须用比喻和大白话向你解释一切）、干活流程、红线清单 |
| `CLAUDE.md` | 给 Claude Code 的门牌，一行导入指向店规——规则永远只有一份 |
| `npx guiju check` | 8 项守卫：密钥不进代码、.env 必须被忽略、脚本可执行位、规则单一真身、规则不膨胀、文档无死链、决策记录五节齐全、无裸待办。违反就红 |
| `.github/workflows/guiju.yml` | 质检口：每次改动申请（PR）自动跑守卫＋你的测试，不过检不进主干 |
| `docs/decisions/` | 决策档案室：「当初为什么这么定」只追加、不修改 |
| `.agents/skills/` 与 `.claude/skills/` | 开工技能：教 AI 按「分支 → 自检 → Draft PR → 排队 → 合并」的次序交付 |
| `.gemini/` 与 `.iflow/` | 两行配置，让 Gemini CLI 与 iFlow 也认同一份店规 |

## 它的三条设计原则

1. **约束力压在质检口上，不压在 AI 的自觉上。**各家 agent 能力参差，但「会读规则文件、会跑命令」人人都会；真正的强制在 CI（云端质检）——不管你雇的哪家 AI，改动都过同一道检。
2. **规则要么是机器查的，要么是有日期的裁决，要么别写。**能执行的规则住在守卫里（违反就红）；「为什么这么定」住在决策档案里（只追加）；现状靠跑命令看。散文文档注定腐烂，所以尽量不写散文。
3. **出了事故，先撤销修复，不是加流程。**新增任何一道门禁的前提：它挂着一次真实发生过的事故，并且同时删掉一道旧的。框架自带反过度治理的免疫系统。

## 更新机制

守卫与工具的逻辑住在 `guiju` 包里，你的项目只有一行版本引用。维护者发布改进后，你的项目**下次跑 CI 时自动用上**——版本化、留痕、可回退。你的 `AGENTS.md` 是你的店产，任何更新都不会远程改写它；`npx guiju update` 只刷新框架管理的文件（CI／决策模板／技能）。

## 维护者须知

- 运行时零第三方依赖（只用 Node 标准库），`node --test` 跑单测，`node bin/guiju.mjs check` 自检。
- 结构：`bin/`（命令入口）、`lib/guards/`（8 项守卫）、`lib/commands/`（init／check／update）、`templates/`（写进用户项目的全部资产）。
- 立法与发布纪律见 [AGENTS.md](AGENTS.md)；范围与形态的裁决理由见 [docs/decisions/2026-07-26-v1-scope.md](docs/decisions/2026-07-26-v1-scope.md)。

## 许可

[MIT](LICENSE)

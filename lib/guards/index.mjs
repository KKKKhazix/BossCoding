/**
 * 守卫注册表。次序即输出次序：先安全（密钥），再结构（规则文件），最后文档卫生。
 *
 * 立法纪律（见 docs/decisions/2026-07-26-v1-scope.md）：新增一个守卫的前提是
 * 它挂着一次真实事故，且误报经过实测收敛——误报多的守卫会被用户关掉，比没有更糟。
 */

import secrets from "./secrets.mjs";
import envIgnored from "./env-ignored.mjs";
import execBits from "./exec-bits.mjs";
import rulesSingleSource from "./rules-single-source.mjs";
import rulesBudget from "./rules-budget.mjs";
import docLinks from "./doc-links.mjs";
import decisionFormat from "./decision-format.mjs";
import noBareTodo from "./no-bare-todo.mjs";

export const guards = [
  secrets,
  envIgnored,
  execBits,
  rulesSingleSource,
  rulesBudget,
  docLinks,
  decisionFormat,
  noBareTodo,
];

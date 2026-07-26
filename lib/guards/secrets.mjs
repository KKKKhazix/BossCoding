/**
 * 密钥守卫：扫描所有被 git 追踪的文本文件，抓高置信度的密钥模式。
 *
 * 为什么扫全量工作区而不是 diff：新项目体量小，全量扫描秒级完成，
 * 且不需要 base commit——在任何浅克隆、任何 CI 环境下行为一致。
 *
 * 误报纪律：守卫误报多就会被关掉，那比没有更糟。所以
 * - credential 赋值规则带占位符豁免（example / your- / changeme 等不算）；
 * - 确属误报的行，行内加注释 `boss-allow-secret` 放行；
 * - 规则只收录「见到即几乎必真」的模式，不做启发式猜测。
 */

const SENSITIVE_FILE =
  /(^|\/)(\.env($|\.)|id_(rsa|dsa|ecdsa|ed25519)($|\.)|credentials?\.json$|.*\.(p12|pfx|pem|key)$)/i;
const SAFE_ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/i;
const ALLOW_MARK = "boss-allow-secret";
const PLACEHOLDER = /(example|placeholder|your[-_]|changeme|xxxx|dummy|<[^>]+>)/i;

const RULES = [
  ["私钥块", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["API token（sk- 开头）", /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "凭证赋值",
    // 不带引号分支必须吞满整个 token 且后面不能紧跟 "("：函数调用不是密钥；带引号的长字符串一律拦截。
    /\b(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*(?!process\.env\b)(?:["'][A-Za-z0-9_+\/=.-]{20,}["']|[A-Za-z0-9_+\/=-]{24,}(?![A-Za-z0-9_+\/=-]|\s*\())/i,
  ],
];

export default {
  name: "secrets",
  title: "密钥不进代码",
  run(ctx) {
    const problems = [];
    for (const file of ctx.trackedFiles()) {
      if (SENSITIVE_FILE.test(file) && !SAFE_ENV_TEMPLATE.test(file)) {
        problems.push({
          file,
          msg: "疑似密钥文件被 git 追踪（一旦 push 到远端，删除也救不回来）",
          fix: "git rm --cached 该文件，把规则加进 .gitignore；若它已被 push 过，里面的密钥必须立即轮换（重新生成并作废旧的）。",
        });
        continue;
      }
      if (/(^|\/)(node_modules|\.git)\//.test(file)) continue;
      const text = ctx.readTextIfSmallText(file);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(ALLOW_MARK)) continue;
        for (const [rule, regex] of RULES) {
          if (!regex.test(line)) continue;
          if (rule === "凭证赋值" && PLACEHOLDER.test(line)) continue;
          problems.push({
            file,
            line: i + 1,
            msg: `疑似${rule}写进了代码（内容已隐去）`,
            fix: "真值挪进 .env（.gitignore 已忽略它），代码里改读 process.env；已 push 过的密钥必须轮换。确属误报时在该行加注释 boss-allow-secret。",
          });
          break;
        }
      }
    }
    return problems;
  },
};

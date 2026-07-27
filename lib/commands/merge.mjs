/**
 * merge：回答一个问题——「现在轮到我合并了吗？」
 *
 * 为什么需要它（issue #2）：规则里「转 Ready 前先确认没有别的 PR 在排队」是约定，
 * 而「队列此刻空不空」是瞬时状态，查询与动作之间有时间窗。上游实测：两条并行的活
 * 相隔 57 秒各自查到「队列为空」，双双转 Ready，一个 PR 因此连跑 3 次 CI，另一个在
 * 门口停了 12 分钟。约定必然输给竞态。
 *
 * 判据换成「我是不是最小的 PR 号」：PR 号由 GitHub 原子分配、单调递增，构成全序，
 * 任何人任何时刻算出的赢家都一致（面包店取号法）。它不问「现在有没有人」，
 * 问「我是不是号最小的那个」——同一件事从瞬时状态变成了不随时间抖动的事实。
 *
 * 只读：本命令不转 Ready、不合并、不写任何 GitHub 资源。合并动作留给人或 agent 显式做，
 * 命令只给判定与退出码（0 ＝ 轮到你，1 ＝ 还没轮到），好让流程脚本拿它当闸。
 */

import { execFileSync } from "node:child_process";
import { paint } from "../context.mjs";
import { parseGitHubRemote, parseGitHubRepository, redactRemote } from "../git-remote.mjs";

/** 队头停滞多久算弃权。取 15 分钟：CI 一轮通常几分钟，够长到不误伤、够短到不空等。 */
const STALL_MS = 15 * 60 * 1000;

const API = "https://api.github.com";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** 从 origin 解析 owner/repo；认 https 与 ssh 两种写法。 */
export function parseRemote(url) {
  return parseGitHubRemote(url);
}

/**
 * 令牌可有可无：公开仓库不带令牌也能查（限速 60 次／小时），私有仓库必须有。
 *
 * 三个来源，最后一个是实测补上的（小白路径必踩）：四阶梯教新人建**私有**仓库，
 * 而连 GitHub 这一步几乎都是用 `gh auth login` 走完的——令牌就在 gh 手里。
 * 不问它，等于要求一个刚学会「什么是仓库」的人去设环境变量。
 */
export function findToken(root) {
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    if (process.env[key]) return process.env[key];
  }
  try {
    const configured = git(root, ["config", "--get", "bosscoding.token"]);
    if (configured) return configured;
  } catch {
    /* 没配就继续问 gh */
  }
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || null;
  } catch {
    return null; // gh 没装或没登录，按无令牌处理。
  }
}

async function fetchPullsFromGitHub({ owner, repo, token }) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "bosscoding" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls?state=open&per_page=100`, { headers });
  if (!res.ok) {
    // 四种失败四句话：把它们压成一句「查不到」，排查就得从头猜起。
    const hint =
      res.status === 404
        ? "仓库不存在，或者是私有仓库而我没拿到通行证。最省事的修法：装了 GitHub 命令行工具就跑一次 `gh auth login`（登录后本命令会自动取用它的通行证）；不想装就设环境变量 GITHUB_TOKEN，或 git config bosscoding.token <令牌>。"
        : res.status === 403
          ? "被限速或没权限。不带令牌每小时只能查 60 次；设 GITHUB_TOKEN 后额度大得多。"
          : res.status === 401
            ? "令牌无效或已过期（不是没令牌，是那个令牌不好使）。换一个，或清掉 GITHUB_TOKEN／GH_TOKEN 让它以匿名身份查公开仓库。"
            : "GitHub 接口没给出正常回应，稍后重试。";
    const error = new Error(`GitHub 返回 ${res.status}：${hint}`);
    error.friendly = true;
    throw error;
  }
  return res.json();
}

/**
 * 排队判定。参数可注入，便于测试与将来换数据源。
 * 返回 { verdict: "go" | "wait" | "unknown", ... }，由调用方决定怎么说话。
 */
export function decide({ pulls, myBranch, myNumber, now }) {
  // Draft（草稿）不占队列：还没送检就不算在排队。
  const queue = pulls.filter((p) => !p.draft).sort((a, b) => a.number - b.number);
  const mine = myNumber
    ? queue.find((p) => p.number === myNumber)
    : queue.find((p) => p.head?.ref === myBranch);

  const skipped = [];
  for (const pr of queue) {
    if (mine && pr.number === mine.number) return { verdict: "go", queue, mine, skipped };
    const idle = now - Date.parse(pr.updated_at);
    if (idle > STALL_MS) {
      // 弃权放行。放行之后不再回头做抢占确认——否则被放行的一方每轮都重新发现
      // 「前面还有个号更小的」，永远轮不到自己，死循环。
      skipped.push({ pr, idleMinutes: Math.round(idle / 60000) });
      continue;
    }
    return { verdict: "wait", queue, mine, blocker: pr, skipped };
  }
  // 走到这儿：队列里没有活跃的前序 PR（我自己的还没开，或者前面的都弃权了）。
  return { verdict: "go", queue, mine, skipped };
}

export async function runMerge(root = process.cwd(), options = {}) {
  const { fetchPulls = fetchPullsFromGitHub, now = Date.now(), prNumber = null } = options;

  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.error(paint.red("✗ 当前目录不是 git 仓库。"));
    console.error("  修：把这句话交给 AI：「我好像不在产品文件夹，请找到正确项目后再继续收尾。」");
    return 1;
  }

  // 「还没有远端」与「有远端但认不出」是两种含义不同的失败，不许压成一句
  // （纪律见 docs/decisions/2026-07-27-deploy-blueprint-errata.md 不变量 3）。
  let originUrl = null;
  try {
    // 读原始配置值而不是 `git remote get-url`：后者会套用 url.<base>.insteadOf 改写
    // （公司内网镜像、代理很常见），拿到的是传输用的地址，不是这个仓库的身份。
    originUrl = git(root, ["config", "--get", "remote.origin.url"]) || null;
  } catch {
    originUrl = null;
  }
  let remote = originUrl ? parseGitHubRemote(originUrl) : null;
  // 兜底：GitHub Actions 里 GITHUB_REPOSITORY 恒为 owner/repo，比任何地址解析都准；
  // 本地仓库的 origin 指向镜像或代理时，它也是唯一能用的身份来源。
  if (!remote) remote = parseGitHubRepository(process.env.GITHUB_REPOSITORY);
  if (!remote) {
    if (!originUrl) {
      // 本地阶段（四阶梯第 0–1 阶之间）：没有远端就没有队列，这不是错误。
      console.log(paint.green("本地阶段：这个项目还没连远端仓库（GitHub），没有别人跟你抢合并，不用排队。"));
      console.log("  验收通过后，对 AI 说：「执行 BossCoding 收尾。」它会自检并安全合并。");
      console.log(paint.dim("  想要异地备份和云端自动质检：产品满意后对 AI 说「带我连上 GitHub」。"));
      return 0;
    }
    // 远端不在 GitHub（Gitee、自建 GitLab……）：排队判定用的是 GitHub 的 PR 号，这里给不出答案。
    // 但「我给不出答案」不等于「你不许合并」——把判断交回给人，别拿一个红叉挡住单干的人。
    console.log(paint.yellow("排队判定只认 GitHub（判据是 GitHub 的 PR 号），你的远端不在 GitHub 上。"));
    console.log(`  你的远端：${redactRemote(originUrl)}`);
    console.log("  只有你一个人在改：不用排队，自检绿了就往下走。");
    console.log(paint.dim("  多人／多个 AI 并行：合并前人工确认没有别的改动在排队，别蒙着合。"));
    console.log(paint.dim("  origin 其实指向 GitHub 的镜像或代理时：设环境变量 GITHUB_REPOSITORY=<owner>/<仓库名>，本命令就能判了。"));
    return 0;
  }

  // symbolic-ref 而不是 rev-parse --abbrev-ref：还没有首个提交时后者返回字面量 HEAD，
  // 会让「我在哪条分支」静默答错。detached HEAD 下取空串，靠 --pr 认领。
  let myBranch = "";
  try {
    myBranch = git(root, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    myBranch = "";
  }
  let pulls;
  try {
    pulls = await fetchPulls({ ...remote, token: findToken(root) });
  } catch (error) {
    console.error(paint.red(`✗ 查不到排队情况：${error.friendly ? error.message : "连不上 GitHub"}`));
    if (!error.friendly) console.error("  修：检查网络后重试；查不到就按老办法人工确认队列，别蒙着合。");
    return 1;
  }

  const { verdict, queue, mine, blocker, skipped } = decide({ pulls, myBranch, myNumber: prNumber, now });

  for (const s of skipped) {
    console.log(paint.yellow(`○ #${s.pr.number} 已经 ${s.idleMinutes} 分钟没动静，按弃权处理，跳过。`));
  }

  if (verdict === "wait") {
    console.log(paint.yellow(`等一下：前面还有 #${blocker.number}「${blocker.title}」在排队。`));
    console.log(`  队列（按 PR 号从小到大，号小的先进）：${queue.map((p) => `#${p.number}`).join(" → ")}`);
    console.log(paint.dim("  并行干活、串行合并：等它进了主干再动你这条，能省掉一轮白跑的质检。"));
    console.log("  老板现在不用做什么；AI 等前一项完成后再继续。");
    return 1;
  }

  if (mine) {
    console.log(paint.green(`轮到你了：#${mine.number}「${mine.title}」是当前队列里号最小的。`));
  } else {
    console.log(paint.green(`队列是空的（没有别的 PR 在等），分支 ${myBranch} 可以往下走。`));
  }
  console.log("  下一步：老板验收通过后，由 AI 把这项改动送去合并。");
  console.log(paint.dim("  本命令只做排队判定，不会自行上传或合并。"));
  return 0;
}

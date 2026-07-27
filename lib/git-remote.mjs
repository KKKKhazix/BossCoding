/**
 * Git 远端身份与展示只有这一套判据。
 *
 * 身份判断必须严格：只有 hostname 恰好是 github.com 的标准 URL，或
 * git@github.com:<owner>/<repo> 标准 SCP 写法，才允许调用 GitHub。
 * 展示必须保守：凭据、查询参数、片段和本机绝对路径永不回显。
 */

const URL_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

function identity(owner, rawRepo) {
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  return { owner, repo };
}

function identityFromPath(rawPath) {
  const parts = rawPath.replace(/^\/+|\/+$/g, "").split("/");
  return parts.length === 2 ? identity(parts[0], parts[1]) : null;
}

export function parseGitHubRemote(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const scp = /^git@github\.com:([^?#]+)$/i.exec(raw);
  if (scp) return identityFromPath(scp[1]);

  try {
    const url = new URL(raw);
    if (!URL_PROTOCOLS.has(url.protocol) || url.hostname.toLowerCase() !== "github.com") return null;
    return identityFromPath(url.pathname);
  } catch {
    return null;
  }
}

export function parseGitHubRepository(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || /[?#]/.test(raw)) return null;
  return identityFromPath(raw);
}

export function isGitHubRemote(value) {
  return parseGitHubRemote(value) !== null;
}

function isLocalPath(raw) {
  return (
    raw.startsWith("/") ||
    raw.startsWith("~/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    /^file:/i.test(raw)
  );
}

function withoutControlCharacters(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** 只供人看，不供身份判断或网络请求。 */
export function redactRemote(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "未配置";

  const github = parseGitHubRemote(raw);
  if (github) return `https://github.com/${github.owner}/${github.repo}`;
  if (isLocalPath(raw)) return "本地地址（已隐藏）";

  try {
    const url = new URL(raw);
    if (url.protocol === "file:" || !url.hostname) return "本地地址（已隐藏）";
    const protocol = URL_PROTOCOLS.has(url.protocol) ? url.protocol : "remote:";
    const port = url.port ? `:${url.port}` : "";
    const pathname = withoutControlCharacters(url.pathname).replace(/[?#].*$/, "");
    return `${protocol}//${url.hostname.toLowerCase()}${port}${pathname}`;
  } catch {
    // 非 URL 的 SCP 写法：用户名可能本身就是令牌，所以一律去掉 @ 前内容。
    const scp = /^(?:[^@\s/:]+@)?([A-Za-z0-9.-]+):([^?#]+)(?:[?#].*)?$/.exec(raw);
    if (scp && !/^[A-Za-z]:$/.test(scp[1])) {
      return `${scp[1].toLowerCase()}:${withoutControlCharacters(scp[2])}`;
    }
    return "远端地址（已脱敏）";
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isGitHubRemote,
  parseGitHubRemote,
  parseGitHubRepository,
  redactRemote,
} from "../lib/git-remote.mjs";

test("GitHub 身份：只认 hostname 恰为 github.com 的标准 URL 与标准 SCP", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
  });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/owner/repo.git"), {
    owner: "owner",
    repo: "repo",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:owner/repo.git"), {
    owner: "owner",
    repo: "repo",
  });

  for (const malicious of [
    "https://github.com.evil.example/owner/repo.git",
    "https://github.com@evil.example/owner/repo.git",
    "https://evil.example/path/github.com/owner/repo.git",
    "github.com:owner/repo.git",
    "alice@github.com:owner/repo.git",
    "/tmp/github.com/owner/repo.git",
    "file://github.com/owner/repo.git",
    "https://github.com/owner/repo/extra.git",
  ]) {
    assert.equal(isGitHubRemote(malicious), false, malicious);
  }
});

test("GitHub Actions 身份：owner/repo 必须是完整且合法的两段", () => {
  assert.deepEqual(parseGitHubRepository("owner/repo"), { owner: "owner", repo: "repo" });
  assert.equal(parseGitHubRepository("owner/repo/extra"), null);
  assert.equal(parseGitHubRepository("../repo"), null);
  assert.equal(parseGitHubRepository("owner/repo?token=secret"), null);
});

test("远端展示：凭据、查询参数、片段和本机绝对路径都不回显", () => {
  const secretUrl = "https://oauth2:top-secret@github.com/owner/repo.git?token=query-secret#hash-secret";
  assert.equal(redactRemote(secretUrl), "https://github.com/owner/repo");

  const other = redactRemote("https://token:password@gitlab.com/owner/repo.git?access=secret#fragment");
  assert.equal(other, "https://gitlab.com/owner/repo.git");

  assert.equal(redactRemote("/Users/alice/private/repo.git"), "本地地址（已隐藏）");
  assert.equal(redactRemote("C:\\Users\\alice\\private\\repo.git"), "本地地址（已隐藏）");

  const all = [redactRemote(secretUrl), other, redactRemote("/Users/alice/private/repo.git")].join("\n");
  for (const secret of ["top-secret", "query-secret", "hash-secret", "password", "access=secret", "/Users/alice"]) {
    assert.doesNotMatch(all, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

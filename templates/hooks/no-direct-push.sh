#!/bin/sh
# bosscoding:no-direct-push-guard
#
# 禁止直推主干：改动走 PR（一次改动的申请单），过了质检才进 main。
# 由 BossCoding 安装到 .git/hooks/pre-push；`npx boss update` 会刷新本文件。
# 想停用：删掉本文件即可，BossCoding 不会偷偷装回来。
#
# 挂的真实事故：没有分支保护的仓库里，一次手误把没过质检的提交直接推上主干，
# 线上当场坏掉。GitHub 免费版的私有仓库开不了分支保护（2026-07 实查），
# 所以这道门禁只能在本地立。理由与误报清单见 BossCoding 仓库
# docs/decisions/2026-07-27-no-direct-push-hook.md。
#
# 只拦三件事同时成立的推送：推往 origin ＋ 目标是主干 ＋ 远端主干已存在。
# 因此：首次推送建立远端主干，放行（此时没有「绕过质检」可言）；
# 推功能分支，放行；推别的远端（备份镜像等），放行。

# CI 里的推送是流程自己的动作，不是「手一抖」。
[ -n "$CI" ] && exit 0

[ "$1" = "origin" ] || exit 0

# 主干叫什么由仓库说了算，不假设一定是 main（与 main-worktree.sh 同一套判据）。
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
default_branch=${default_branch#origin/}
if [ -z "$default_branch" ]; then
  if git show-ref --verify --quiet refs/heads/main; then
    default_branch=main
  elif git show-ref --verify --quiet refs/heads/master; then
    default_branch=master
  else
    exit 0 # 看不出主干是哪条，不猜、不拦。
  fi
fi

# stdin 每行：<本地引用> <本地提交号> <远端引用> <远端提交号>
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = "refs/heads/$default_branch" ] || continue
  case "$remote_sha" in
    *[!0]*) ;; # 远端主干已存在 → 往下走，拦
    *) continue ;; # 提交号全零＝远端还没有这条分支：首次推送，放行
  esac
  printf '\n✗ 禁止直推 %s：改动要走 PR（一次改动的申请单），过了质检才进主干。\n' "$default_branch" >&2
  printf '  这么走：git checkout -b <分支名> → 提交 → 推这条分支 → 开 PR。\n' >&2
  printf '  确实要直推（明知故犯而不是手抖）：git push --no-verify（git 内置逃生阀）。\n\n' >&2
  exit 1
done

exit 0

#!/bin/sh
# bosscoding:main-worktree-guard
#
# 主工作区只跑 main。由 BossCoding 安装到 .git/hooks/pre-commit 与 post-checkout
# （同一份判断挂两处，靠 $0 的文件名分工）；`npx boss update` 会刷新本文件。
# 想停用：删掉这两个 hook 文件即可，BossCoding 不会偷偷装回来。
#
# 挂的真实事故：两个 agent 同时在主工作区各自开分支干活，37 分钟内 7 次分支切换。
# 没丢代码纯属两边改的文件不重叠——真撞上时 git 会把未提交的改动安静地带去别人的
# 分支或直接换掉，不报任何错。
#
# 这条只能在本地拦：工作区状态不进 git，CI 拿到的是树和提交，看不出这笔是在哪个
# 工作区切出来的。

# CI 里没有「另一个 agent」，也没有人看警告。
[ -n "$CI" ] && exit 0

# 误报收敛：只有仓库真的开了独立工作区（≥2）才启用。单人单工作区是默认画像，
# 在主工作区开分支干活正是 BossCoding 教的流程，这时任何提醒都是纯误报。
worktrees=$(git worktree list 2>/dev/null | wc -l | tr -d ' ')
[ "${worktrees:-0}" -ge 2 ] || exit 0

# 判据用 git 自己的两个目录，比路径约定稳：linked worktree 的 git 目录在
# .git/worktrees/<名> 下，与 common dir 不同；主工作区两者相同。
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
common_dir=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd) || exit 0
[ "$git_dir" = "$common_dir" ] || exit 0

# detached HEAD（rebase／bisect 中途）放行——那不是「在这里开分支干活」。
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0

# 主干分支叫什么由仓库说了算，不假设一定是 main。
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
[ "$branch" != "$default_branch" ] || exit 0

repo_name=$(basename "$(dirname "$common_dir")")
worktree_hint="  1. 开独立工作区干活：git worktree add ../$repo_name-<任务名> -b <分支名>
  2. 改动已经改在这儿了：git stash → git checkout $default_branch → 到独立工作区 git stash pop"

case "${0##*/}" in
  post-checkout)
    # 只在切分支时说话（第三个参数为 1 才是分支切换，文件级 checkout 不算）。
    [ "$3" = "1" ] || exit 0
    # 此刻改正成本为零，所以只提醒不拦；git 本来也忽略本 hook 的退出码。
    printf '\n⚠ 主工作区切到了分支 %s（本仓库有 %s 个工作区，并行中）。\n' "$branch" "$worktrees" >&2
    printf '%s\n\n' "$worktree_hint" >&2
    exit 0
    ;;
  *)
    printf '\n✗ 主工作区只跑 %s，当前在分支 %s，拒绝提交。\n' "$default_branch" "$branch" >&2
    printf '  本仓库有 %s 个工作区：并行时两个 agent 在同一个工作区互相切分支，\n' "$worktrees" >&2
    printf '  会把未提交的改动安静地带去别人的分支或直接换掉，git 不报任何错。\n\n' >&2
    printf '%s\n\n' "$worktree_hint" >&2
    printf '  确实要在这里提交：git commit --no-verify（git 内置逃生阀）\n\n' >&2
    exit 1
    ;;
esac

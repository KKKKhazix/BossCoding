/**
 * 可执行位守卫：所有被追踪的 .sh 的 git mode 必须是 100755。
 *
 * 挂的真实事故（上游 aihot 仓库，2026-06）：一个被提交成 100644 的 watchdog 脚本
 * 被 cron 按绝对路径直调，EXIT 126 Permission denied，余额告警静默失效约 5 天。
 * 口径是 blanket：所有 .sh 一视同仁——一个不可执行的 shell 脚本本身就是异味，
 * 比「解析调用方推断哪些需要可执行」更稳。
 */

export default {
  name: "exec-bits",
  title: "shell 脚本带可执行位",
  run(ctx) {
    const problems = [];
    for (const line of ctx.trackedStages(["*.sh"])) {
      const mode = line.slice(0, 6);
      const tabIdx = line.indexOf("\t");
      const file = tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
      if (mode !== "100755") {
        problems.push({
          file,
          msg: `git mode 是 ${mode}，不是 100755（cron／CI 直调会 Permission denied 静默失败）`,
          fix: `运行 git update-index --chmod=+x ${file}（本地顺手 chmod +x ${file}），再重跑 npx bosscoding check。`,
        });
      }
    }
    return problems;
  },
};

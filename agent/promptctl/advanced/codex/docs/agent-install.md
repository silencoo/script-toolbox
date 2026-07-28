<!-- markdownlint-disable MD013 -->

# 复制给智能体安装 / Copy this to an agent

把下面这段发给你的编码智能体(Claude Code / Codex CLI 等),让它替你完成下载校验和预览:

```text
使用 script-toolbox 中的 agent/promptctl/advanced/codex/codex-instruct.py，并把我明确提供的 Markdown 路径传给 --file；不要猜测提示词路径，也不要把示例当成隐式默认。先运行 --version、--status 和带 --file 的 --dry-run，报告目标 .codex 目录、外部文件路径与 SHA-256、全局行为范围、MD/config/hooks/legacy/manifest 计划和备份路径。如果 status 发现 durable journal，只预览 --recover，并等我确认后才添加 --yes。完成后开启新 Codex 会话验证。不要删除任何备份或事务日志，不修改 Codex 二进制、网络、运行中进程或凭证。
```

English version:

```text
Use agent/promptctl/advanced/codex/codex-instruct.py from script-toolbox and pass the Markdown path I explicitly provide through --file. Do not guess a prompt path or treat the example as an implicit default. Run --version, --status, and --dry-run with --file first; report the target .codex directory, external-file path and SHA-256, global behavior scope, the MD/config/hooks/legacy/manifest plan, and backup paths. If status finds a durable journal, only preview --recover and wait for my confirmation before adding --yes. Start a new Codex session to verify after deployment. Do not delete any backup or transaction journal, and do not modify the Codex binary, network, running processes, or credentials.
```

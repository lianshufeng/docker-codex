---
name: codex-reset-forecast
description: 当用户询问 Codex 额度重置时间、Tibo/thsottiaux 重置信号、重置概率或希望预测 Codex reset 时使用。默认先读取现有预测 JSON，再用内置实时清单审计 Tibo Posts 的 ID 与原文完整性；只有 ID、原文或状态变化时才重算，稳定历史默认由脚本本地复用。禁止绕过清单和 AI 自行修改概率。
---

> 技能版本：3.16.5（5.4-mini 固定入口）

## 5.4-mini 固定入口（必须先执行）

用户只需直接调用本技能，无需提供或理解任何命令行参数。加载本 `SKILL.md` 不计入业务命令；加载后唯一首个业务命令必须是无参数运行 `node /home/node/.agents/skills/codex-reset-forecast/scripts/forecast.mjs`。脚本自行使用固定状态文件和临时清单路径，通过 `https://proxy.jpy.wang/x.com/thsottiaux` 读取 X `Posts` 最近至少 3 条主帖，通过同一代理的单帖页面提取完整原文，再用新鲜 feed 补充自身帖子串关系并完成复用门禁。禁止改写入口、拼接参数、探测路径、读取脚本或回读目标 JSON。

代理只作为公开 X 页面传输层：产物和来源必须保留 canonical `https://x.com/...` URL，独立性分组仍为 `x_original`；不得把代理算作第二来源，也不得向代理发送 Cookie、Authorization、token 或其他凭据。

严格按入口 JSON 分支：`status="blocked"` 或 `action="stop"` 时立即原样报告 `stage` 与 `reason` 并结束，之后禁止任何本地命令、远程搜索、读取 JSON 或输出缓存概率；`action="reuse_existing"` 且 `display_allowed=true` 时只使用入口返回的 `forecast_summary` 回答；`action="full_refresh"` 时才为入口返回的 `missing_post_ids`、`mismatched_post_ids` 和 `required_posts` 补齐远程证据并进入完整刷新。任何没有 `display_allowed=true` 的结果都禁止展示旧概率。

一次批量远程抓取必须为入口清单中缺失或不匹配的每个帖子补齐分类、中文与核验来源，并覆盖 `codexreset.org`、`codex-reset.com/tibo` 和 OpenAI 官方状态；英文原文必须直接使用 `required_posts[].text_original`，禁止摘要、改写或截短。禁止只用旧 ID 的精确搜索证明“没有更新”。“最新总体动态”严格使用入口的 `latest_overall_post`，帖子串增量游标严格使用 `probe_post`，两者不得互换。

入口返回 `action="full_refresh"` 表示目标结果不存在、发现新增/错配帖子或现有结果不可复用；不得把基座时间当结果时间。必须把入口给出的最新 ID/时间仅作为下界，补齐当前增量后生成四个产物。所有本地确定性比较交给脚本。完整输入仅抓基座之后的帖子；为绑定来源而重复提交基座同 ID 帖子时，脚本保留已核验原文和分类，只有明确修正才填 `correction:true`。

# Codex 额度重置时间预测技能

## 唯一执行状态机

严格按 `COLLECT → RUN` 执行，禁止在脚本返回 `blocked` 后继续生成概率：

1. `COLLECT`：只无参数运行固定脚本，建立确定性完整性清单和复用门禁；只有它返回 `action="full_refresh"` 才用远程实时能力补齐清单列出的正文、分类及其他来源。内置基座视为有效历史，除非用户明确要求重建历史。
2. `RUN`：完整刷新禁止写输入文件。原样用带 TTY 的 `exec_command` 启动 `stty -echo 2>/dev/null || true; IFS= read -r CODEX_RESET_DELTA; stty echo 2>/dev/null || true; export CODEX_RESET_DELTA; node /home/node/.agents/skills/codex-reset-forecast/scripts/forecast.mjs --input-env CODEX_RESET_DELTA --live-collection /tmp/codex-reset-live.json --print-report`；脚本会自动复用固定状态文件中的历史。取得 session ID 后用 `write_stdin` 发送不超过 3000 UTF-8 字节的单行紧凑 JSON加换行。不要改写命令，不用管道、`printf`、heredoc、内联 JSON、base64 或 `apply_patch`。

紧凑 JSON 固定为 `{"as_of_utc":"UTC","posts":[{"id":"ID","at":"UTC","url":"X URL","text":"英文","zh":"中文","type":"TYPE","level":LEVEL,"evidence":"分类依据","confirmed_event":true,"latest":true}],"sources":[{"id":"x","url":"来源URL","group":"x_original","scopes":["latest_overall"],"post_id":"顶部主帖ID"},{"id":"mirror","url":"独立来源URL","group":"search_engine","scopes":["latest_overall"],"post_id":"顶部主帖ID"},{"id":"official","url":"https://status.openai.com/","group":"openai_official","scopes":["official_status"]}],"status_indicator":"operational"}`。`posts[]` 必须补齐清单 `required_posts` 中缺失或原文不匹配的每个 ID，禁止只提交最大 ID；`text` 逐字使用清单原文，脚本还会在合并后再次用清单恢复 ID、时间、URL 与原文，缺一条即拒绝写结果。只有清单 `latest_overall_post` 填 `latest:true`；已误收的普通回复用 `{"id":"ID","exclude":true}` 删除。英文明确表示 `have been reset`、`I've reset`、`I have reset` 或同义的已完成 Codex 全局重置时，固定填 `type:"reset_signal",level:4`并给出 `zh` 和 `evidence`；同一重置帖子串只有信息最完整的一条填 `confirmed_event:true`，其他已完成表述填 `confirmed_event:false`，避免重复计数；脚本会确定性生成对应的确认重置事件。`as_of_utc` 必须原样使用清单的 `checked_at_utc`。只提交缺失/不匹配/新增/修正帖子；默认省略 reasoning 和三个历史数组。`latest_overall` 来源必须各自使用不同 URL；`fetched_at` 只有来源正文明确给出时才填。若确实超过 3000 字节，分多次 `write_stdin`，只在最后一段加换行。

正常执行不调用 `--help`、`--smoke-test`、`--self-test`，不读取脚本，不回读完整 JSON。脚本返回 `blocked` 后不得自行生成概率。

## 请求轮次预算

- 首次批量远程抓取复用本地清单已核验的 Tibo/X ID 与原文，只补两个 tracker 和 OpenAI 官方状态；完整刷新必须复用这批证据中的全部合格增量，只补缺失字段，禁止重新逐条搜索 X。
- 快速复用通常不超过 3 次工具调用，完整刷新通常不超过 5 次；这是成本目标，不是停止门禁。
- 缺字段或候选早于本地最新帖子时只补缺口，直到门禁完整或远程来源确实不可用。


## 硬门禁与输出

- 只预测 Codex 全局善意额度重置；第三方概率不入模，AI 不得估计或修改脚本概率。
- 最新总体动态须由两个不同 `group` 的新鲜远程来源绑定同一 ID；OpenAI 官方状态须新鲜。过期辅助 Tracker 只降级，承担上述硬门禁的来源过期则阻断。
- `latest_overall` 来源填 `post_id`；脚本用 `posts[]` 同 ID 自动绑定时间与 URL。来源 URL、分组和本次实际证据必须真实，`fetched_at` 不得伪造。
- 有基座只提交新增/修正帖子；不传完整历史、逐时解释或概率。常见帖子类型由脚本归一化，预测相关新帖仍须 `zh` 和 `evidence`。
- 来源冲突但门禁完整时生成 `degraded/low`；缺少新鲜双来源、官方来源、最新候选或 10 次可信历史时阻断且不写失败产物。
- 脚本固定生成并验证 JSON、HTML、本地服务器和启动入口。完整刷新原样返回 `--print-report`；快速复用只报告 ID 未变、结果时间和 JSON 路径，不复述内容。
- 只有用户明确给出接收 URL 才 POST；不得把 Tibo 称为 OpenAI 官方，不承诺一定重置。

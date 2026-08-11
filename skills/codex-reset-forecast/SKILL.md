---
name: codex-reset-forecast
description: 当用户询问 Codex 额度重置时间、Tibo/thsottiaux 重置信号、重置概率或希望预测 Codex reset 时使用。默认先读取现有预测 JSON，再通过一次远程实时抓取比较 Tibo 最新总体帖子 ID；ID 相同则立即复用，只有缺少有效 JSON、发现新 ID 或用户明确强制刷新时才抓取当前证据并重算，稳定历史默认由脚本本地复用。禁止本地直连和 AI 自行修改概率。
---

> 技能版本：3.15.9（5.4-mini 固定入口）

## 5.4-mini 固定入口（必须先执行）

首个本地命令必须是 `node /home/node/.agents/skills/codex-reset-forecast/scripts/forecast.mjs --state /workspace/codex-reset-forecast.json`。路径固定，禁止用 `pwd`、`ls`、`rg`、`find`、`sed`、`jq` 探测，也不得读取脚本、资产、`references/`、manifest 或目标 JSON；本文件已包含正常执行所需全部契约。`--state` 会在目标不存在时返回内置基座，并提供复用回答所需的紧凑摘要。

一次批量远程抓取必须直接读取 `https://codex-reset.com/api/feed`，并同时覆盖 Tibo/X `Posts` 页最新动态、精确 ID、`codexreset.org`、`codex-reset.com/tibo` 和 OpenAI 官方状态；禁止只用旧 ID 的精确搜索证明“没有更新”。“最新总体动态”严格指 X `Posts` 页面最上方的帖子串主帖，不是该帖子串中 ID 更大的子帖。增量抓取同时接受主帖，以及 `is_reply=true` 且 `replying_to="thsottiaux"` 的自身帖子串补充；排除发给其他账号的普通 `Replies` 动态。Feed 仅在 `stale=false` 且 `fetched_at` 新鲜时参与发现。probe 候选必须是全部合格增量的最大 ID；无新增时必须使用 `--state` 返回的 `probe_floor_post_id` 及其绑定帖子，禁止改用可能较小的 `latest_overall_post_id`。页面顶部主帖只用于完整刷新的 `latest:true` 和 `sources[].post_id`，不用于 probe。随后必须以非交互方式直接运行 `node .../forecast.mjs --state /workspace/codex-reset-forecast.json --probe-post-id <游标ID> --probe-post-at <UTC> --probe-post-url <URL> --probe-source-url <来源URL> --probe-checked-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`；probe 禁止使用 `stty`、`read`、`write_stdin`、`--input-env` 或任何等待标准输入的包装。`--probe-checked-at` 必须现场取当前 UTC，禁止使用 Feed 的 `fetched_at`。`retry_probe` 只补缺口，不重复搜索已确认字段。

远程搜索后必须实际执行上述 probe 命令；“搜索结果 ID 看起来相同”不等于门禁通过。只有 `--state` 已给出 `result_reusable=true`，且 probe 明确返回 `action="reuse_existing"`，才允许复用并结束；任一条件不满足都必须完整刷新。

收到 `base_source="bundled_seed"`、`status="baseline_only"` 或 `result_reusable=false` 表示目标结果不存在：它不是可复用预测，严禁报告“复用”或把基座时间当结果时间；必须把最新 ID/时间仅作为下界，批量远程抓取当前增量，使用上面的固定 probe 参数进入完整刷新并生成四个产物。所有本地确定性比较交给脚本。完整输入仅抓基座之后的帖子；为绑定来源而重复提交基座同 ID 帖子时，脚本保留已核验原文和分类，只有明确修正才填 `correction:true`。

# Codex 额度重置时间预测技能

## 唯一执行状态机

严格按 `COLLECT → RUN` 执行，禁止在脚本返回 `blocked` 后继续生成概率：

1. `COLLECT`：仅用远程实时能力获取当前紧凑增量；本地不得联网。内置基座视为有效历史，除非用户明确要求重建历史。
2. `RUN`：完整刷新禁止写输入文件。原样用带 TTY 的 `exec_command` 启动 `stty -echo 2>/dev/null || true; IFS= read -r CODEX_RESET_DELTA; stty echo 2>/dev/null || true; export CODEX_RESET_DELTA; node /home/node/.agents/skills/codex-reset-forecast/scripts/forecast.mjs --input-env CODEX_RESET_DELTA --print-report`（有可复用历史时加 `--base-history /workspace/codex-reset-forecast.json`）；取得 session ID 后用 `write_stdin` 发送不超过 3000 UTF-8 字节的单行紧凑 JSON 加换行。不要改写命令，不用管道、`printf`、heredoc、内联 JSON、base64 或 `apply_patch`。

紧凑 JSON 固定为 `{"as_of_utc":"UTC","posts":[{"id":"ID","at":"UTC","url":"X URL","text":"英文","zh":"中文","type":"TYPE","level":LEVEL,"evidence":"分类依据","confirmed_event":true,"latest":true}],"sources":[{"id":"x","url":"来源URL","group":"x_original","scopes":["latest_overall"],"post_id":"顶部主帖ID"},{"id":"mirror","url":"独立来源URL","group":"search_engine","scopes":["latest_overall"],"post_id":"顶部主帖ID"},{"id":"official","url":"https://status.openai.com/","group":"openai_official","scopes":["official_status"]}],"status_indicator":"operational"}`。`posts[]` 必须包含基座后抓到的每条合格增量，禁止只提交最大 ID；只有 X `Posts` 页面顶部的帖子串主帖填 `latest:true`，子帖不填或填 `latest:false`；已误收的普通回复用 `{"id":"ID","exclude":true}` 删除。英文明确表示 `have been reset`、`I've reset`、`I have reset` 或同义的已完成 Codex 全局重置时，固定填 `type:"reset_signal",level:4`并给出 `zh` 和 `evidence`；同一重置帖子串只有信息最完整的一条填 `confirmed_event:true`，其他已完成表述填 `confirmed_event:false`，避免重复计数；脚本会确定性生成对应的确认重置事件。`as_of_utc` 必须原样使用 probe 返回的 `checked_at_utc`；若跳过 probe，先运行 `date -u +%Y-%m-%dT%H:%M:%SZ`，禁止猜测、取整或使用当天零点。只提交基座后的新增/修正帖子；默认省略 reasoning 和三个历史数组。`latest_overall` 来源必须各自使用不同 URL；`fetched_at` 只有来源正文明确给出时才填。若确实超过 3000 字节，分多次 `write_stdin`，只在最后一段加换行。

正常执行不调用 `--help`、`--smoke-test`、`--self-test`，不读取脚本，不回读完整 JSON。脚本返回 `blocked` 后不得自行生成概率。

## 请求轮次预算

- 首次批量远程抓取同时直读 `https://codex-reset.com/api/feed` 并覆盖最新 Tibo/X `Posts`、精确 ID、两个 tracker 和 OpenAI 官方状态；完整刷新必须复用这批证据中的全部合格增量，只补缺失字段，禁止逐查询、逐 URL 调用。
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

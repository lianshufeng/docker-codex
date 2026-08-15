# 远程输入数据契约

先按 SKILL.md 无参数运行脚本，通过固定 X 代理和 feed 建立实时完整性清单，再把远程实时 Web Search、远程网页工具或远程连接器补充的独立来源整理为输入 JSON。除固定入口的公开页面采集外，本地脚本不得联网。

## 顶层结构

```json
{
  "current": {},
  "sources": [],
  "refresh": {},
  "reasoning_context": {},
  "historical_events": [],
  "historical_signals": [],
  "historical_contexts": []
}
```

正常增量优先使用紧凑格式：顶层 `classification_version="2.0.0"`、`as_of_utc`、`posts[]`、`sources[]`、可选 `reset_events[]`、`status_indicator`。帖子别名为 `id/at/url/text/type/level/reset_meaning/zh/evidence/confirmed_event/window_end/correction`；来源别名为 `id/name/url/group/scopes/post_id/fetched_at/status/ref`。正式生成必须同时提供 `--live-collection`，且 `posts[]` 与基座合并后必须覆盖清单的每个 `required_posts[].post_id`；清单可发现最大游标之前遗漏的中间帖子，并用 X 代理单帖页/feed 的 `text_original` 确定性修复摘要、截短或改写。脚本自动补齐远程方法、抓取时间和 `latest_overall` 的帖子绑定。`latest_overall` 来源必须提供 `post_id`，并绑定清单的 `latest_overall_post`；不同来源 URL 和分组必须真实独立。默认省略 reasoning 与历史数组。

本文件只在快速门禁决定完整刷新后读取。`refresh` 包含 `checked_at_utc`、`last_full_refresh_at_utc`、`status_indicator` 和 `active_incident_id`。使用 `--base-history` 时，三个历史数组只提交新增或修正记录；无基座时再读取 [历史重建契约](history-rebuild.md)。

`--probe-base64` 接收本次轻量远程抓取的 `checked_at_utc`、单个或多个 `sources` 及 `latest_overall_post`，与 `--existing` 指定 JSON 的 `current.latest_overall_post` 确定性比较。probe 的来源对象最少只需 `name`、`url`、`retrieved_at_utc`，其余仅用于预检的字段由脚本补齐；完整刷新输入仍严格遵守下文来源契约。普通请求在 `reuse_existing` 时结束，强制刷新则把同 ID 结果作为锚点并继续；`retry_probe` 时只补脚本指出的缺口，不能因调用次数目标而接受早于本地基座的候选。

`current` 必须包含 `as_of_utc`、`cross_source_consistent`、`tibo_work_timezone` 和增量 `recent_tibo_posts`。`latest_overall_post`、`latest_reset_signal` 可省略；脚本合并基座时间线后按顺序和 `post_type` 确定性派生，若输入仍重复提供且不一致则自动使用时间线值并把结果降级，而不是直接阻断。`cross_source_consistent = false` 表示来源冲突并触发降级预测。`tibo_work_timezone` 使用带夏令时规则的 IANA 时区，默认 `America/Los_Angeles`。`post_type` 标准值为 `reset_signal`、`codex`、`limits`、`release`、`other`；`reset_meaning` 标准值为 `none`、`weak`、`directional`、`explicit_future`、`completed`，分别严格对应 Lv.0—4。紧凑实时输入禁止使用历史兼容别名。

`recent_tibo_posts[]` 最终保存 10—30 条；有基座时只提交新增或修正记录，脚本按 `post_id` 合并。每条新增或修正记录都必须由 LLM 阅读完整英文原文后填写 `post_type`、`signal_level`、`reset_meaning`、中文和分类依据；不得由关键词规则代替分类。`none/weak/directional/explicit_future/completed` 必须分别与等级 `0/1/2/3/4` 一致，只有后四者可使用 `post_type="reset_signal"`。Lv.3 必须由原文明说未来将执行重置，只有结合上下文推断“惊喜”可能是重置时最高为 Lv.2；`completed` 必须有明确已经完成的英文语义，未来预告不可作为确认事件。两个 `is_latest_*` 标志由脚本重算。帖子 ID、URL 和 Snowflake 时间必须绑定，时间误差最多 60 秒。

Lv.3 原文包含明确或可计算的承诺上限时填写 `window_end`（ISO 8601 UTC）。`reset_events[]` 只用于 Tibo 没有完成公告但外部证据确认全局额度已静默重置的情况，字段为 `id/at/effective_at/url/confidence/source_refs[]`；`source_refs` 至少绑定两个不同 `group`、均声明 `reset_history` 的本次来源。单来源观察、第三方预测概率或用户猜测不得作为确认事件。承诺窗口和 2 小时宽限均已结束但没有合格事件时，生成过程阻断精确概率。

`sources[]` 必须包含 `source_id`、`name`、`url`、`retrieved_at_utc`、`source_reported_fetched_at_utc`、`independence_group`、`evidence_scopes`、`retrieval_method`、`status`、`evidence_ref`。凡 `evidence_scopes` 含 `latest_overall`，还必须填写 `observed_post_id`、`observed_post_at_utc`、`observed_post_url`，三者须与该来源实际看到的同一条帖子记录绑定；Tracker 只展示重置记录时不得声明 `latest_overall`。其他来源将这三个字段设为 `null`。脚本生成的输出还包含 `effective_retrieved_at_utc` 和由脚本计算的 `fresh`；输入中的 `fresh` 不作为门禁依据。

- `retrieved_at_utc`：本次远程工具返回结果的时间。
- `source_reported_fetched_at_utc`：feed/API 正文自带的 `fetched_at`；没有则使用 `null`。脚本取它与 `retrieved_at_utc` 中更早者计算新鲜度，禁止用生成时间覆盖来源自报时间。
- `independence_group`：来源独立性分组，例如 `x_original`、`search_engine`、`codex_reset_tracker`、`openai_official`。核验最新总体动态的两个来源必须属于不同分组。
- `evidence_scopes`：只使用本来源实际支持的范围，例如 `latest_overall`、`latest_reset_signal`、`reset_history`、`official_status`、`release_context`。

`retrieval_method` 只能是 `chatgpt_remote_web_search` 或 `remote_connector`。`status` 可使用 `ok`、`conflict` 或 `failed`；`conflict` 表示抓取成功但内容不一致，只有 `failed` 不计入。至少一个 `evidence_scopes` 含 `official_status` 的新鲜来源必须来自 `openai.com` 或其子域名；第三方状态镜像只能作为辅助证据。

`reasoning_context` 可省略，或只填一份 `evidence_summary`、`supporting_factors`、`counter_factors`、`uncertainty`、`evidence_refs`。脚本把它扩展到所有预测范围；这些展示字段不参与概率、系数、状态或门禁。旧版 `horizons[]` 仍兼容。

历史字段和标签仅在重建历史时按 [历史重建契约](history-rebuild.md)。结论、逐范围推理、HTML 与概率全部由脚本确定性生成，模型不得改写。

## 刷新契约

- 快速门禁先校验现有近期时间线的数量、顺序及 ID/时间/URL/正文绑定，再比较最新总体帖子精确 ID 与发布时间；不加载历史、翻译、模型或旧概率正文。
- 现有 JSON 缺失、损坏、schema/model 版本不兼容时返回 `full_refresh`。
- 同 ID 且完整性清单无缺口、无原文不匹配时返回 `reuse_existing`，不得写文件或重复 POST；存在 `collection_gap` 或 `collection_mismatch` 时即使最大 ID 相同也必须完整刷新。
- 同 ID 但 Lv.3 承诺窗口在上次生成后已经结束时返回 `full_refresh/signal_outcome_window_elapsed`，不得复用窗口结束前的概率。
- 远程 ID 更新时返回 `full_refresh`，并复用预检数据作为完整刷新第一来源。
- 远程 ID/时间倒退、缺失或来源不新鲜时返回 `retry_probe`；继续针对缺口批量补抓，只有确认远程来源不可用时才保留现有产物并停止。
- 完整刷新失败时不得覆盖现有有效产物。
- 存在结构兼容的固定预测文件时，正式完整刷新自动在脚本内部复用其历史，无需模型附加参数；工作区没有预测文件时自动使用技能内置只读历史基座，仍只抓当前增量，不重新下载稳定历史。强制刷新或完整重算仍重新抓取当前证据并完整运行模型与回测，只有用户明确要求“重建历史”时才重新下载全部稳定历史。
- 增量通过带 TTY 的 shell `read` 和一次 `write_stdin` 发送单行压缩 JSON，再由 `--input-env` 读取；关闭 TTY 回显，不写临时文件。禁止 heredoc、内联 JSON、base64 和 `apply_patch`，避免输入差异被重复回显。`--validate-input*` 仅供人工诊断。
- 正式生成使用 `--print-report`，在同一进程内校验四个固定产物和编码并输出中文 Markdown；不得回读完整 JSON或再调用 `--report`。后者只用于人工诊断或重显已有结果。

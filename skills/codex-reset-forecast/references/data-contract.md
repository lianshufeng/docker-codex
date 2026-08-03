# 远程输入数据契约

只把 ChatGPT/Codex 远程实时 Web Search、远程网页工具或远程连接器返回的数据整理为输入 JSON。本地脚本不得联网。

## 顶层结构

```json
{
  "current": {},
  "sources": [],
  "refresh": {},
  "reasoning_context": { "horizons": [] },
  "historical_events": [],
  "historical_signals": [],
  "historical_contexts": []
}
```

`refresh` 每次执行都包含 `mode:"full_refresh"`、`checked_at_utc`、`last_full_refresh_at_utc`、`status_indicator` 和 `active_incident_id`。现有缓存只用于防倒退检查和失败保护，不得触发快速复用或仅本地重算。

`--probe-base64` 仅为旧调用兼容入口，固定返回 `full_refresh`，不得据此跳过后续完整流程。

`current` 必须包含 `as_of_utc`、`cross_source_consistent`、`tibo_work_timezone`、`latest_overall_post`、`latest_reset_signal` 和 `recent_tibo_posts`。`cross_source_consistent = false` 表示来源内容冲突并触发降级预测，不单独阻断流程。`tibo_work_timezone` 使用带夏令时规则的 IANA 时区，默认 `America/Los_Angeles`；不得使用固定 UTC 偏移代替。帖子对象必须包含 `post_id`、`published_at_utc`、`url`、`text`、`signal_level`、`classification_evidence`。来源冲突时，`latest_overall_post` 使用带精确 ID、发布时间和 URL 的最新可审计候选；缺少这些字段的更晚搜索摘要只进入 `reasoning_context`。`latest_reset_signal` 只有在精确 ID、发布时间、原文和分类齐全时才能进入 `historical_signals` 作为当前信号，否则模型必须使用 `baseline_fallback`。

`recent_tibo_posts[]` 固定保存按发布时间倒序排列的最新 3—6 条总体动态，每条必须包含 `post_id`、`published_at_utc`、`url`、`text_original`、`text_zh`、`translation_method`、`post_type`、`signal_level`、`classification_evidence`、`is_latest_overall`、`is_latest_reset_signal`。展示等级允许 `0—4`；等级 `4` 表示已完成，禁止降级为 `3`。`translation_method` 固定为 `chatgpt`；`post_type` 只使用 `reset_signal`、`codex`、`limits`、`release`、`other`。第一条必须与 `latest_overall_post` 一致并令 `is_latest_overall = true`。

`sources[]` 必须包含 `source_id`、`name`、`url`、`retrieved_at_utc`、`retrieval_method`、`status`、`fresh`、`evidence_ref`。`retrieval_method` 只能是 `chatgpt_remote_web_search` 或 `remote_connector`。`status` 可使用 `ok`、`conflict` 或 `failed`；`conflict` 表示抓取成功但内容与另一来源不一致，仍计入新鲜远程来源数量，只有 `failed` 不计入。

`reasoning_context.horizons[]` 必须完整覆盖 `2、4、8、12、24、72` 小时，每项固定包含 `horizon_hours:number`、`llm_evidence_summary:string`、`supporting_factors:string[]`、`counter_factors:string[]`、`uncertainty:string`、`evidence_refs:string[]`。这些字段由 ChatGPT 基于本次已抓取证据生成，只负责解释，不得包含可覆盖模型概率、系数、模型状态或门禁的字段。

`historical_events[]` 必须包含 `event_id`、`event_type`、`announced_at_utc`、`effective_at_utc`、`post_id`、`source_url`、`confidence`、`reason_tags`、`included_in_training`、`exclusion_reason`。

`historical_signals[]` 必须包含 `post_id`、`published_at_utc`、`url`、`text`、`signal_level`、`intent_class`、`has_explicit_timing`、`promised_window_end_at_utc`、`outcome_status`、`outcome_time_kind`、`reset_at_utc`、`latency_lower_hours`、`latency_upper_hours`、`observation_end_at_utc`、`confidence`、`classification_evidence`、`matched_reset_event_id`、`hours_to_reset`、`reset_within_4h`、`reset_within_24h`、`reset_within_72h`。历史预测信号等级只能为 `0—3`；等级 `4` 只能保存在结果事件和近期动态中。

同一轮重置前的多条相关帖子必须合并为一个信号事件，保留最早信号时间并用最高可信信号等级和最明确的意图类型标注，禁止把同一结果重复计为多个独立成功样本。能够核实具体重置时间时必须填写 `reset_at_utc` 和精确延迟；只有承诺窗口而无法取得具体时间时才使用区间删失。

`intent_class` 只使用 `weak_mention`、`directional_reset`、`explicit_commitment`；`outcome_time_kind` 只使用 `exact`、`interval_censored`、`right_censored`。明确重置时间使用 `exact`；只有官方承诺窗口而无精确确认时间时使用 `interval_censored`；观察截止仍未确认时使用 `right_censored`，且必须填写 `observation_end_at_utc`。不得把尚未覆盖完整预测范围的右删失样本当作失败。

`historical_contexts[]` 必须包含 `context_id`、`context_type`、`occurred_at_utc`、`source_url`。`context_type` 只使用 `incident`、`release`、`milestone`。

## 标签规则

- 只有明确、全局、可信度至少为 `0.7` 的实际重置使用 `event_type = "confirmed_reset"` 和 `included_in_training = true`。
- 预告使用 `preview_signal`，误报使用 `rejected_signal`，banked reset 使用 `banked_reset`，额度提升使用 `credits_or_boost`。
- 确认重置的帖子只能作为结果，不能作为该次重置发生前的预测特征。
- 每个排除事件都保留，并填写 `exclusion_reason`。
- 所有时间使用 ISO 8601 UTC；最终展示再转换为北京时间。

## 输出结论契约

最终 JSON 必须包含固定 `conclusion` 对象：`headline:string`、`summary:string`、`primary_horizon_hours:number|null`、`primary_deadline_beijing:string|null`、`primary_probability:number|null`、`primary_probability_percent:number|null`、`most_likely_window_start_beijing:string|null`、`most_likely_window_end_beijing:string|null`、`most_likely_window_probability:number|null`、`confidence_level:low|medium|high|unavailable`、`confidence_explanation:string`、`reason_keys:string[]`。

结论必须由模型脚本从 `forecast`、`model`、`history` 和 `explanation` 确定性生成。HTML 和 AI 不得重新选择预测范围、估算概率或提升置信等级。

脚本把 `reasoning_context` 与模型结果合并到 `forecast.horizons[].reasoning`：`model_basis` 与 `cumulative_effect` 由脚本确定性生成；LLM 内容只能填充证据摘要、支持因素、反向因素、不确定性和引用。最终每个预测节点都必须同时具备模型依据和 LLM 证据解读。

生成 `codex.html` 时只能写入静态页面结构、样式和 JSON 加载/渲染逻辑，禁止写入 `application/json` 数据块、内置快照或任何预测结果。页面仅支持 HTTP(S)，禁止包含 `file://` 判断、文件选择器或其他本地文件读取逻辑；本地访问统一通过 `open-codex.cmd` 启动 `codex-local-server.mjs`。JSON URL 必须以当前页面所在目录为基准拼接固定文件名 `codex-reset-forecast.json` 并追加 `?_t=<当前毫秒时间戳>`；例如 `/codex/index.html` 必须请求 `/codex/codex-reset-forecast.json`，不得请求站点根目录 JSON。

## 刷新契约

- 指纹字段固定为：数据结构版本、模型版本、最新总体帖子 ID/时间、最新重置相关帖子 ID/时间/等级、最近确认重置 ID/时间、OpenAI 状态和活动事故 ID。
- `fetched_at` 只校验本次抓取是否新鲜，不参与指纹。
- 指纹只用于产物审计和防倒退检查，不得决定是否继续执行。
- 无论指纹是否变化，每次都完整抓取、翻译、解释、运行模型、回测并生成产物。
- 完整刷新失败时不得覆盖现有有效产物。

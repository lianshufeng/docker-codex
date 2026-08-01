# 远程输入数据契约

只把 ChatGPT/Codex 远程实时 Web Search、远程网页工具或远程连接器返回的数据整理为输入 JSON。本地脚本不得联网。

## 顶层结构

```json
{
  "current": {},
  "sources": [],
  "reasoning_context": { "horizons": [] },
  "historical_events": [],
  "historical_signals": [],
  "historical_contexts": []
}
```

`current` 必须包含 `as_of_utc`、`cross_source_consistent`、`latest_overall_post`、`latest_reset_signal` 和 `recent_tibo_posts`。帖子对象必须包含 `post_id`、`published_at_utc`、`url`、`text`、`signal_level`、`classification_evidence`。

`recent_tibo_posts[]` 固定保存按发布时间倒序排列的最新 3—6 条总体动态，每条必须包含 `post_id`、`published_at_utc`、`url`、`text_original`、`text_zh`、`translation_method`、`post_type`、`signal_level`、`classification_evidence`、`is_latest_overall`、`is_latest_reset_signal`。`translation_method` 固定为 `chatgpt`；`post_type` 只使用 `reset_signal`、`codex`、`limits`、`release`、`other`。第一条必须与 `latest_overall_post` 一致并令 `is_latest_overall = true`。

`sources[]` 必须包含 `source_id`、`name`、`url`、`retrieved_at_utc`、`retrieval_method`、`status`、`fresh`、`evidence_ref`。`retrieval_method` 只能是 `chatgpt_remote_web_search` 或 `remote_connector`。

`reasoning_context.horizons[]` 必须完整覆盖 `2、4、8、12、24、72` 小时，每项固定包含 `horizon_hours:number`、`llm_evidence_summary:string`、`supporting_factors:string[]`、`counter_factors:string[]`、`uncertainty:string`、`evidence_refs:string[]`。这些字段由 ChatGPT 基于本次已抓取证据生成，只负责解释，不得包含可覆盖模型概率、系数、模型状态或门禁的字段。

`historical_events[]` 必须包含 `event_id`、`event_type`、`announced_at_utc`、`effective_at_utc`、`post_id`、`source_url`、`confidence`、`reason_tags`、`included_in_training`、`exclusion_reason`。

`historical_signals[]` 必须包含 `post_id`、`published_at_utc`、`url`、`text`、`signal_level`、`intent_class`、`has_explicit_timing`、`promised_window_end_at_utc`、`outcome_status`、`outcome_time_kind`、`reset_at_utc`、`latency_lower_hours`、`latency_upper_hours`、`observation_end_at_utc`、`confidence`、`classification_evidence`、`matched_reset_event_id`、`hours_to_reset`、`reset_within_4h`、`reset_within_24h`、`reset_within_72h`。

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

生成 `codex.html` 时必须把完整输出 JSON 同批次嵌入 `application/json` 数据块。HTTP(S) 模式优先抓取 `./codex-reset-forecast.json`；`file://` 模式读取内置快照。两种模式不得使用不同的计算逻辑。

# 历史重建契约

仅在没有可复用基座或用户明确要求“重建历史”时读取。

- `historical_events[]`：`event_id`、`event_type`、`announced_at_utc`、`effective_at_utc`、`post_id`、`source_url`、`confidence`、`reason_tags`、`included_in_training`、`exclusion_reason`。
- `historical_signals[]`：`post_id`、`published_at_utc`、`url`、`text`、`signal_level`、`intent_class`、`has_explicit_timing`、`promised_window_end_at_utc`、`outcome_status`、`outcome_time_kind`、`reset_at_utc`、`latency_lower_hours`、`latency_upper_hours`、`observation_end_at_utc`、`confidence`、`classification_evidence`、`matched_reset_event_id`、`hours_to_reset`、`reset_within_4h`、`reset_within_24h`、`reset_within_72h`。
- `historical_contexts[]`：`context_id`、`context_type`、`occurred_at_utc`、`source_url`；类型仅用 `incident`、`release`、`milestone`。

只有明确、全局且可信度至少 `0.7` 的实际重置使用 `confirmed_reset` 并纳入训练。预告、误报、banked reset、credits/boost 和未知事件必须保留排除原因。确认重置只能作为结果，不能作为该次重置前的预测特征。

历史信号等级只能为 `0—3`；同一轮重置前的多条相关帖子合并为一个信号事件，保留最早时间、最高可信等级和最明确意图。`intent_class` 仅用 `weak_mention`、`directional_reset`、`explicit_commitment`。

能核实具体结果时间时使用 `exact`；只有承诺窗口时使用 `interval_censored`；观察截止仍未确认时使用 `right_censored` 并填写 `observation_end_at_utc`。不得把尚未覆盖完整预测范围的右删失样本当作失败。所有时间使用 ISO 8601 UTC。

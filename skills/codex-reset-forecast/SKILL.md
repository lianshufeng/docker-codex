---
name: codex-reset-forecast
description: 当用户询问 Codex 额度重置时间、Tibo/thsottiaux 重置信号、重置概率或希望预测 Codex reset 时使用。必须通过 ChatGPT/Codex 远程实时 Web Search 或远程连接器重新抓取 Tibo 动态、意图—真实重置配对、历史重置和 OpenAI 状态，禁止本地直连；再调用确定性脚本执行以 Tibo 信号延迟为主、当地工作时段为时间分配、历史重置间隔为弱先验的生存预测与信号起点滚动回测。禁止 AI 自行估计或修改概率。以北京时间输出固定 JSON 和动态加载该 JSON 的静态页面；当用户明确给出接收 URL 并要求提交结果时，在 JSON 成功生成后以 application/json POST 到该 URL。
---

> 技能版本：3.5.1（纯网络加载与当前页面目录 JSON 定位）

# Codex 额度重置时间预测技能


## 零、强制实时抓取门禁（最高优先级）

本节优先级高于本技能其他所有规则。**每次调用都必须执行完整抓取、双来源校验、翻译、证据解读、模型计算、回测和产物校验；禁止因 Tibo 数据指纹未变化而提前返回或跳过任一步骤。**

### 0.A 禁止指纹短路

1. 不得调用 `--probe-base64` 决定是否继续，也不得返回 `reuse_existing` 或 `recalculate_only`。
2. 即使 Tibo 最新总体动态、最新重置相关动态、最近确认重置和 OpenAI 状态均未变化，也必须继续完成后续完整流程。
3. 现有 `codex-reset-forecast.json` 只能用于防倒退检查和失败时保留有效产物，不得用于跳过抓取、翻译、证据解读、模型计算或回测。
4. `fetched_at` 只用于本次来源新鲜度校验；数据指纹仅作为产物审计字段，不得作为流程分支条件。

### 0.0 强制使用 ChatGPT/Codex 远程代理抓取

1. 对本技能涉及的所有外部链接和实时数据，包括 X、搜索引擎、`codex-reset.com`、OpenAI 状态页及其他公开来源，必须使用当前 ChatGPT/Codex 会话提供的远程实时 Web Search、远程网页打开工具或已配置的远程搜索连接器抓取。
2. 禁止使用本地 Shell、Python `urllib`/`requests`、`curl`、`wget`、本地浏览器自动化或其他从用户设备、Docker 容器、工作区环境直接发出的数据抓取请求。唯一例外是用户明确给出接收 URL 并要求提交最终 JSON 时，允许模型脚本在生成成功后向该 URL 执行一次 POST。
3. 本地工具只能处理、排序和校验已经由远程能力返回的数据，不得自行补抓任何 URL。
4. 抓取前必须确认远程工具处于实时模式；缓存搜索、模型记忆和历史结果不能满足实时抓取要求。
5. 若当前模型提供方不支持远程实时 Web Search，远程工具不可用，或无法确认请求由远程服务执行，不得降级成本地直连；若存在有效缓存则保留并说明无法刷新，否则必须说明“当前无法通过 ChatGPT/Codex 远程能力完成实时抓取”，并停止预测。

### 0.1 禁止使用旧数据代替本次抓取

1. 不得把模型记忆、上一次回答、上一次抓取结果、缓存页面或用户之前提供的截图，当作本次的“最新数据”。
2. 每次调用都必须通过远程能力生成新的抓取时间，并在正式回答开头展示。
3. 上一次已知帖子 ID 和时间只能用于“防倒退检查”，不能替代当前抓取。

### 0.2 必须同时获取两类帖子

每次执行必须分别确认以下两类帖子，二者不得混为一谈：

- `最新总体动态`：Tibo 当前公开时间线中发布时间最新的一条帖子，不论是否提到 Codex、reset 或额度；
- `最新重置相关动态`：在最新 10—30 条帖子中，与 Codex、reset、额度、limit、usage、quota、launch、ship、efficiency 等相关且发布时间最新的一条。

**严禁只执行关键词搜索后，就把命中的旧帖子当成 Tibo 最新消息。**必须先做不带 reset/Codex 关键词的账号总体时间线查询，再做重置相关筛选。

### 0.3 双来源核验是概率输出的放行条件

1. 每次执行至少使用两个彼此独立的实时来源核验 `最新总体动态`。可用组合包括：
   - Tibo 的 X 原始主页或单帖页面；
   - 实时搜索引擎返回的 Tibo 账号最新结果；
   - 有 `fetched_at`、帖子 ID 和发布时间的第三方公开 feed 或镜像。
2. 同一网站的 feed 与 forecast 接口不算两个独立来源。
3. 两个来源至少应在以下任一项上一致：
   - 最新帖子 ID；
   - 最新帖子发布时间；
   - 最新帖子正文的可唯一识别片段。
4. 若第二来源显示了更晚的帖子，必须返回重新抓取，不能继续使用较旧帖子预测。
5. 若两个来源冲突且无法解决：
   - 不得声称“已经读取最新消息”；
   - 不得输出新的累计概率表；
   - 只能说明“最新动态存在来源冲突，本次暂停预测”。

### 0.4 新鲜度与完整性检查

1. 至少一个动态来源必须提供本次抓取时间，例如 `fetched_at`、响应时间或搜索抓取时间。
2. 动态源抓取时间距离当前北京时间原则上不得超过 **20 分钟**；超过时必须防缓存重试或更换实时来源。
3. 帖子本身较早不等于数据源陈旧；只要抓取时间新鲜且已确认当前没有更晚帖子即可。
4. 对获取到的 10—30 条帖子，必须按发布时间排序；若发布时间缺失，使用帖子 ID 作为辅助排序依据。
5. 若接口同时返回 `newest_post_at`、时间线首条记录和最新帖子 ID，必须检查三者一致。
6. 若本次抓到的“最新帖子”比对话中已经明确出现过的帖子 ID 更小或发布时间更早，视为数据源倒退，必须重试并换源。

### 0.5 必须检查的其他实时信息

完成最新动态校验后，还必须检查：

- 最近一次已确认的 Codex 全局重置记录；
- 最新相关帖子之后是否已有“已重置”确认；
- OpenAI 官方状态页或官方公告；
- 近期可核实的重置间隔和发帖到落地的时间差。

### 0.6 失败时禁止伪实时预测

若本次无法联网，或无法完成最新总体动态的双来源一致性确认：

- 不得继续给出看似实时的概率表；
- 必须明确写出“本次无法确认 Tibo 最新总体动态，因此不生成新的重置概率”；
- 用户截图只能作为辅助核对，不能替代实时查询。

完整刷新失败时不得覆盖现有有效产物；应说明失败原因并保留上次结果。

### 0.7 输出前硬门禁

每次执行只有以下条件全部为真，才能输出新的概率表：

- `抓取时间已确认且不超过20分钟`；
- `最新总体动态已确认`；
- `最新总体动态已通过第二来源核验`；
- `最新重置相关动态已从最新时间线中筛选`；
- `最近一次实际重置已核对`；
- `没有未解决的来源时间或帖子 ID 冲突`；
- `本次概率已丢弃旧结论并重新计算`。

每次正式输出开头必须先列出：

`数据抓取时间：YYYY年MM月DD日 HH:mm（北京时间）`

`Tibo 最新总体动态：YYYY年MM月DD日 HH:mm｜帖子 ID｜内容摘要`

`第二来源核验：来源名称｜核验到的帖子 ID 或发布时间｜一致/冲突`

`最新重置相关动态：YYYY年MM月DD日 HH:mm｜帖子 ID｜内容摘要`

即使最新总体动态与重置无关，也必须展示；这是证明本次没有漏读更新的必要字段。

## 一、技能目标

根据 Tibo（X 账号 `@thsottiaux`）近期公开发言和可核实的历史重置记录，通过确定性统计模型预测下一次 Codex 全局善意额度重置可能发生的北京时间。

只预测全局善意重置，不预测个人 5 小时或周额度窗口。AI 只负责远程抓取、按固定规则结构化和解释模型结果，不得自行生成概率。

## 二、触发条件

用户出现以下意图时调用本技能：

- “Codex 什么时候重置”
- “预测一下 Codex 重置时间”
- “Tibo 又发重置消息了吗”
- “几小时内重置概率多少”
- “根据 Tibo 历史经验判断下一次 reset”
- “给我 2 小时、4 小时、8 小时、24 小时、3 天、1 个月的重置概率”

即使用户只说“重置时间”“Tibo 重置”，结合上下文确认指的是 Codex 时也应调用。

## 三、必须使用的数据

每次调用时都必须通过 ChatGPT/Codex 远程能力重新抓取完整历史、双来源动态和 OpenAI 状态，并重新生成翻译与 LLM 证据解读。不得根据数据指纹或现有缓存缩短流程。

优先检查：

1. Tibo 的 X 主页：`https://x.com/thsottiaux`
2. Tibo 最近与 Codex、reset、resets、limits、credits、quota、usage、bank、model release、launch 等相关的公开发言
3. 可公开访问的历史重置追踪记录，例如 `codex-reset.com` 的 feed、timeline 或历史页面；禁止把第三方 forecast 作为模型输入
4. OpenAI 官方状态页或官方公开信息，用于排查是否存在故障补偿、额度策略变化或正式公告

数据优先级：

1. OpenAI 官方公开信息
2. Tibo 本人的原始发言
3. 有时间戳的第三方历史追踪数据
4. 其他转述、评论或社区猜测

第三方追踪网站只能作为辅助证据，必须明确其并非 OpenAI 官方来源。

## 四、时间处理规则

1. 所有时间统一转换为北京时间（UTC+8）。
2. 输出必须使用绝对时间，例如：`2026年8月1日 13:00`。
3. 不直接用“几小时后”“明天上午”等模糊表达作为最终结论。
4. 当原帖只说“几小时后”时，应结合发帖时间生成一个时间窗口，例如：
   - 原帖时间：2026年7月31日 12:53（北京时间）
   - 预测窗口：2026年7月31日 15:00—18:00（北京时间）
5. 当前基准时间必须写明，并使用用户当前时区；本技能最终展示仍统一为北京时间。

## 五、事件与信号标签

按 [远程输入数据契约](references/data-contract.md) 整理数据。只把明确、全局、可信度至少为 `0.7` 的实际重置标记为 `confirmed_reset` 正样本。将预告、误报、banked reset、credits/boost 和未知事件分别标记，全部保留排除原因。

Tibo 帖子的 `signal_level` 固定为：`0` 无关；`1` 只谈额度或效率；`2` 明确提到 reset 但无时间承诺；`3` 明确表示即将执行；`4` 已完成。`current.recent_tibo_posts` 必须原样保留等级 `4`；历史预测信号只能使用 `0—3`。等级 `4` 只能作为结果，禁止降级成 `3` 或用于事前预测。每次分类必须保存支持判断的原文片段。

## 六、统计模型与硬门禁

每次执行必须调用 `node scripts/forecast.mjs --input <远程快照.json>`，不得先调用 `--probe-base64` 尝试复用或仅重算。模型使用 [预测模型与放行规则](references/model.md) 中的“Tibo 信号延迟主模型 + 当地工作时段分配 + 历史间隔弱先验 + 重置后冷却”。在 Windows PowerShell 中，禁止把含中文的原始 JSON 直接通过管道传给 Node；必须先以 UTF-8 转为 Base64，再输入脚本。必须把 Tibo 重置意图与之后真实重置的精确时间、承诺窗口或未落地观察期配对；使用带夏令时规则的 IANA 工作时区，并从历史重置当地小时学习时段分布。脚本不得联网，AI 不得自行估计、补齐、平滑或修改概率。

固定预测节点为 2、4、8、12、24、72 小时，禁止生成超过 72 小时的预测。少于 10 次可信重置时阻断。每次必须执行以历史 Tibo 信号为预测起点的逐步回测，最新信号只作为留出测试答案而不得进入该折训练；至少 3 折且 24 小时 Brier 不劣于相同信号起点的历史间隔基线，才允许标记回测通过。

## 七、每次调用的固定顺序

1. 获取当前北京时间，回读现有 JSON，仅用于防倒退检查和失败保护。
2. 不带关键词抓取 Tibo 最新 10—30 条总体动态并完成独立第二来源核验；把最新 3—6 条保存为中英双语结构。
3. 从同一批动态筛选最新重置相关帖子，检查其后是否已有确认重置；远程抓取完整历史、预告和误报，并检查 OpenAI 状态、发布与里程碑背景。
4. 严格按 `references/data-contract.md` 生成全新的远程快照 JSON 和 2、4、8、12、24、72 小时 LLM 证据解读，再运行无网络模型脚本。
5. 每次重新执行模型计算和滚动回测，不得复用旧概率、旧翻译或旧证据解读代替本次流程。
6. 回读并校验 `codex-reset-forecast.json` 与 `codex.html`；对话和网页只能从 JSON 展示结论与数据，并输出绝对路径。
7. 若用户明确要求把生成的 JSON 提交到某个 URL，调用脚本时追加 `--post-url <URL>`；只能在 JSON 原子写入并回读校验成功后提交，最后报告 HTTP 状态。用户未明确给出 URL 时禁止推测或提交。

## 八、固定磁盘输出契约

最终固定生成 `codex-reset-forecast.json`、静态页面 `codex.html`、本地服务器 `codex-local-server.mjs` 和一键入口 `open-codex.cmd`，均保存到当前项目根目录；Docker 中固定保存到 `/workspace`。所有文件使用 UTF-8 无 BOM，并通过临时文件原子替换。`codex.html` 只能包含静态页面结构、样式和 JSON 加载/渲染逻辑，严禁嵌入、复制或硬编码任何预测 JSON 数据。页面仅支持 HTTP(S) 加载，不得包含 `file://` 分支、文件选择器或其他本地文件兼容逻辑；本地使用必须双击 `open-codex.cmd` 启动仅监听 `127.0.0.1` 的临时 HTTP 服务。页面必须从当前页面 URL 所在目录加载固定文件名 `codex-reset-forecast.json`：例如页面为 `/codex/index.html` 时只能请求 `/codex/codex-reset-forecast.json?_t=<当前毫秒时间戳>`，禁止请求站点根目录 `/codex-reset-forecast.json`。页面使用中文响应式布局，不得依赖本地构建工具；外部依赖只能使用国内访问友好的 CDN，默认优先使用无第三方依赖的原生 HTML/CSS/JavaScript/SVG。每次覆盖旧结果；阻断时仍生成同一结构和页面，并令 `status = "blocked"`。

显式 POST 回调固定使用本次完整刷新生成文件的完整 JSON 文本作为请求体，方法为 `POST`，请求头为 `Content-Type: application/json; charset=utf-8`。只接受 HTTP(S) URL 和 2xx 响应，不跟随重定向，30 秒超时，默认只提交一次以避免重复写入。提交失败时保留已经生成的本地文件、返回失败并明确错误；不得声称提交成功，也不得提交旧文件。

所有 key 必须存在且不得改名。数组缺失时使用 `[]`，可空对象使用 `null`，数值缺失使用 `null`；禁止 `NaN` 和 `Infinity`。概率使用 0—1 的 `number`，展示百分比使用 0—100 的 `integer`。

固定顶层结构：

```json
{
  "schema_version": "1.8.1",
  "file_name": "codex-reset-forecast.json",
  "site": {
    "file_name": "codex.html",
    "data_path": "./codex-reset-forecast.json",
    "language": "zh-CN",
    "max_horizon_hours": 72,
    "local_launcher": "./open-codex.cmd",
    "local_server": "./codex-local-server.mjs",
    "direct_file_supported": false,
    "access_modes": ["local_http", "http", "https"],
    "data_loading_priority": ["current_page_directory_json", "http_cache_bust"]
  },
  "generated_at_utc": "string",
  "generated_at_beijing": "string",
  "status": "ok|degraded|blocked",
  "blocked_reasons": [],
  "refresh": {
    "mode": "full_refresh",
    "data_fingerprint": "string|null",
    "checked_at_utc": "string",
    "last_full_refresh_at_utc": "string",
    "status_indicator": null,
    "active_incident_id": null,
    "last_confirmed_reset_event_id": null,
    "last_confirmed_reset_at_utc": null,
    "reuse_max_age_minutes": 20,
    "full_refresh_max_age_hours": 24
  },
  "sources": [],
  "current": {
    "as_of_utc": "string",
    "as_of_beijing": "string",
    "tibo_work_timezone": "America/Los_Angeles",
    "last_confirmed_reset_at_utc": null,
    "latest_overall_post": null,
    "latest_reset_signal": null,
    "recent_tibo_posts": []
  },
  "history": {
    "observation_start_utc": null,
    "observation_end_utc": "string",
    "confirmed_reset_count": 0,
    "signal_count": 0,
    "excluded_event_count": 0,
    "events": [],
    "signals": [],
    "contexts": [],
    "intervals": []
  },
  "model": {
    "name": "tibo_signal_worktime_survival",
    "version": "3.1.0",
    "variant": "signal_primary|baseline_fallback|none",
    "status": "trained|degraded|blocked",
    "formula": "string",
    "coefficients": {
      "intercept": null,
      "log_hours_since_last_reset": null,
      "post_reset_cooldown": null,
      "decayed_tibo_signal": null,
      "recent_incident": null,
      "recent_release_or_milestone": null,
      "utc_hour_sin": null,
      "utc_hour_cos": null
    },
    "hyperparameters": {
      "time_step_hours": 1,
      "l2_lambda": null,
      "signal_decay_hours": null,
      "post_reset_cooldown_hours": null
    },
    "training": {
      "sample_count": 0,
      "positive_count": 0,
      "negative_count": 0,
      "start_at_utc": null,
      "end_at_utc": null
    },
    "validation": {
      "method": "signal_origin_expanding_window",
      "fold_count": 0,
      "brier_score_4h": null,
      "brier_score_24h": null,
      "brier_score_72h": null,
      "log_loss": null,
      "calibration_error": null,
      "baseline_brier_score_24h": null,
      "latest_holdout": null,
      "passed": false
    },
    "signal_adjustment": {
      "method": "signal_latency_empirical_bayes_with_worktime",
      "prior_strength": 1,
      "current_signal_post_id": null,
      "current_signal_level": null,
      "current_signal_intent_class": null,
      "current_signal_age_hours": null,
      "historical_intent_count": 0,
      "exact_outcome_count": 0,
      "interval_censored_outcome_count": 0,
      "right_censored_count": 0,
      "baseline_variant": null,
      "work_timezone": "America/Los_Angeles"
    }
  },
  "forecast": {
    "horizons": [],
    "most_likely_windows": []
  },
  "conclusion": {
    "headline": "string",
    "summary": "string",
    "primary_horizon_hours": null,
    "primary_deadline_beijing": null,
    "primary_probability": null,
    "primary_probability_percent": null,
    "most_likely_window_start_beijing": null,
    "most_likely_window_end_beijing": null,
    "most_likely_window_probability": null,
    "confidence_level": "low|medium|high|unavailable",
    "confidence_explanation": "string",
    "reason_keys": []
  },
  "explanation": {
    "summary": "string",
    "factors": [],
    "limitations": [],
    "risk_notice": "string"
  }
}
```

固定数组元素 key：

- `sources[]`：`source_id:string`、`name:string`、`url:string`、`retrieved_at_utc:string`、`retrieval_method:string`、`status:string`、`fresh:boolean`、`evidence_ref:string`。
- `history.events[]`：`event_id:string`、`event_type:string`、`announced_at_utc:string`、`effective_at_utc:string|null`、`post_id:string|null`、`source_url:string`、`confidence:number`、`reason_tags:string[]`、`included_in_training:boolean`、`exclusion_reason:string|null`。
- `history.signals[]`：除原有字段外，固定包含 `intent_class:string`、`has_explicit_timing:boolean`、`promised_window_end_at_utc:string|null`、`outcome_status:string`、`outcome_time_kind:string`、`reset_at_utc:string|null`、`latency_lower_hours:number|null`、`latency_upper_hours:number|null`、`observation_end_at_utc:string`、`confidence:number`；用于审计“表达意图后是否以及何时真实重置”。
- `history.contexts[]`：保存 `context_id`、`context_type`、`occurred_at_utc`、`source_url`，用于本次模型计算和产物审计；下次执行仍须重新抓取。
- `history.intervals[]`：`interval_id:string`、`start_at_utc:string`、`end_at_utc:string`、`duration_hours:number`、`event_observed:boolean`、`event_id:string|null`。
- `current.recent_tibo_posts[]`：`post_id:string`、`published_at_utc:string`、`url:string`、`text_original:string`、`text_zh:string`、`translation_method:string`、`post_type:string`、`signal_level:number`、`classification_evidence:string`、`is_latest_overall:boolean`、`is_latest_reset_signal:boolean`；展示等级允许 `0—4`，等级 `4` 必须显示为“已完成重置”。
- `forecast.horizons[]`：`horizon_hours:number`、`deadline_utc:string`、`deadline_beijing:string`、`cumulative_probability:number`、`display_probability_percent:number`、`baseline_probability:number`、`signal_probability_delta:number`、`confidence_lower:number`、`confidence_upper:number`、`signal_posterior:object`、`reasoning:object`。
- `forecast.horizons[].reasoning`：`model_basis:string`、`llm_evidence_summary:string`、`supporting_factors:string[]`、`counter_factors:string[]`、`cumulative_effect:string`、`uncertainty:string`、`evidence_refs:string[]`。`model_basis` 和 `cumulative_effect` 由脚本根据模型结果生成；其余字段来自 ChatGPT 对已抓取证据的结构化解读，不得参与或修改概率计算。
- `forecast.most_likely_windows[]`：`start_at_beijing:string`、`end_at_beijing:string`、`window_probability:number`、`rank:number`。
- `conclusion`：所有 key 固定；时间、概率和主要预测范围必须直接来自 `forecast`，`reason_keys` 必须来自 `explanation.factors[].feature_key`，阻断时使用 `null` 和 `unavailable`。
- `explanation.factors[]`：`feature_key:string`、`feature_value:number`、`direction:string`、`contribution_log_odds:number`、`evidence_refs:string[]`、`explanation:string`。

## 九、固定对话输出

先展示抓取时间、最新总体动态、第二来源核验和最新重置信号。随后从 JSON 的 `forecast.horizons` 输出：

| 预计截止时间（北京时间） | 距当前约 | 累计重置概率 | 模型状态 |
|---|---:|---:|---|

再从 `explanation.factors` 输出：

| 模型因素 | 当前值 | 影响方向 | 对数优势贡献 | 数据依据 |
|---|---:|---|---:|---|

表格只能使用 JSON 中的 `deadline_beijing`、`horizon_hours`、`display_probability_percent` 和模型状态。每个预测范围还必须能查看对应 `reasoning` 的模型依据、LLM 证据解读、支持因素、反向因素、累计效应、不确定性和证据引用。不得在对话或 HTML 中另算一套概率。最后列出最可能窗口、模型版本、样本数、滚动回测结果、局限、风险说明，以及 JSON 和 HTML 绝对路径；若指定了 POST URL，还必须列出提交 URL 和 HTTP 状态。

`codex.html` 中“预测概率明细”“最近历史重置”“模型与回测指标”三个报表必须默认展开并允许手动收缩。Tibo 区域必须展示 `current.recent_tibo_posts` 的中文翻译和英文原文：中文在前，英文在后，最新总体动态和最新重置信号分别显示标签。

页面默认面向已经关注 Codex 重置动态的爱好者，直接展示判断、数据和动态；不得在“为什么这样判断”“Tibo 近期动态”等栏目标题下添加教学式副标题、阅读提示、翻译说明或免责声明式赘述。

“预测概率明细”的每条主记录必须支持点击整行展开或收起其下方的结构化推理摘要，不得单独显示“查看完整理由”按钮；主记录前须显示克制美观的折叠箭头，展开时同步改变方向，并须支持 Enter 或空格键操作。展开内容必须明确区分“统计模型依据（Tibo 信号延迟 + 工作时段 + 历史间隔弱先验）”和“LLM 证据解读”，禁止以 LLM 解读冒充模型计算。

页面必须仅通过 HTTP(S) 自动加载 `codex-reset-forecast.json`，不得包含 `file://` 判断、文件选择器或任何本地文件读取逻辑。本地用户必须通过 `open-codex.cmd` 和 `codex-local-server.mjs` 进入 HTTP 页面。JSON URL 必须以当前页面 URL 所在目录为基准拼接固定文件名并追加 `?_t=<当前毫秒时间戳>`；页面部署为 `/codex/index.html` 或 `/codex/codex.html` 时，请求必须落在 `/codex/codex-reset-forecast.json`。禁止根路径硬编码、内置快照或 HTML 数据回退。

页面只展示本次预测的生成时间和浏览器当前本地时间，不得向最终用户显示“预测已过期”“请重新执行技能”或有效期倒计时，也不得把已超过截止时间的节点置灰。预测更新频率由外部调度器负责。图表横轴固定表示“从模型计算时点起 +2h、+4h……”，前端禁止把概率平移成“从浏览器现在起未来 N 小时概率”，也禁止在浏览器中重新计算或修改概率。

## 十、引用要求

只要使用联网信息，所有关键事实必须附引用，并应能让读者看出本次确实重新抓取了数据，包括：

- 本次数据抓取时间或动态源的 `fetched_at`
- Tibo 原帖内容、帖子 ID（可取得时）和发布时间
- 最近一次确认重置时间
- 历史间隔或第三方追踪数据
- OpenAI 官方状态或额度政策

不得伪造无法访问的帖子内容。若 X 无法直接读取，应明确说明，并使用可核实的镜像、搜索摘要或追踪页面交叉验证。

## 十一、禁止事项

- 不得把 Tibo 的发言称为 OpenAI 官方公告，除非有明确官方身份和出处支持。
- 不得把累计概率误写成每个时间段的独立概率。
- 不得只写“4 小时后”“明天”，必须给出北京时间的年月日和小时。
- 不得在没有新数据时照抄上一次结果。
- 不得仅凭用户截图或旧的搜索结果声称“已抓取最新数据”。
- 不得只读取“最新相关帖子”而跳过“最新总体动态”；否则无法证明时间线没有漏抓。
- 不得在不同来源的最新帖子时间冲突时，直接选用较旧来源继续预测。
- 不得在 ChatGPT/Codex 远程联网请求发生前先生成概率和结论。
- 不得使用本地 Shell、脚本、命令行下载器或本地浏览器直接访问本技能涉及的任何外部链接。
- 不得让本地模型脚本联网抓取预测数据；它只能读取远程能力已经整理好的快照 JSON。仅允许按用户明确给出的 URL 提交已经校验并落盘的最终 JSON。
- 不得由 AI 自行生成、修正、取整或覆盖模型概率、系数、门禁和贡献方向。
- 不得从第三方 forecast 接口复制概率作为本模型结论。
- 不得先写对话表格再补写 JSON；必须先写并回读 JSON，再从同一文件生成表格。
- 不得为了显得准确而给出 37.4% 之类的伪精确数字。
- 不得承诺一定重置、一定恢复全部额度或一定在某时发生。

## 十二、简洁版输出原则

用户未要求详细分析时，默认输出：

1. 一句模型结论与模型状态
2. 一张从 JSON 生成的概率表
3. 一张模型贡献解释表
4. 1—3 个最可能时间窗口
5. 样本数与滚动回测指标
6. 一句非官方风险说明
7. `codex-reset-forecast.json` 的绝对路径

避免重复解释“累计概率”超过一次。

# Web 交互提问验收

验收日期为 2026-11-13。执行端使用 [Codex 0.167.2 正式版](https://github.com/openai/codex/releases/tag/rust-v0.167.2)，通过该二进制生成 TypeScript 协议并核对 `isBlocking`、`questions` 和 `delivery`。本机 CLI 0.125.0 的生成协议仅用于核对缺字段时的兼容行为，未作为验收基线。

## 协议和行为

- 同步提问处理 `item/tool/requestUserInput`。每题使用答案数组，选项按标签返回，备注使用 `user_note: ` 前缀，未回答的题目使用空数组。没有 `isBlocking` 时按阻塞式处理。非阻塞问题遵循上游终端的 60 秒等待和 60 秒倒计时，当前页面开始选择或填写后停止该页面的倒计时。
- 异步提问读取助手消息的 `questions`，使用稳定的问题标识区分同名问题。回答按上游客户端格式提交为新一轮用户输入。执行中的会话等到空闲后才能提交。跳过仅关闭当前页面的卡片，刷新后可以重新显示。其他客户端提交答案后，历史中的回答标识可关闭对应卡片。
- 同步请求使用原始请求 ID 和执行端实例校验，按请求串行提交。Docker 桥为 Web 提供仍待处理的请求快照，可在浏览器或 Web 服务重启后恢复。桌面桥尝试通过 `thread/resume` 触发上游重放，实际是否收到取决于桌面桥和执行端能力。

源码依据见上游 [提问协议](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputParams.ts)、[终端同步提问](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs)、[异步回答格式](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/context-fragments/src/answered_question.rs)和[恢复时重放待处理请求](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/app-server/src/outgoing_message.rs)。

## 已通过

- 隔离 Compose 项目 `codex-input-acceptance` 使用独立工作目录、用户数据、配置和端口。测试容器挂载 0.167.2 二进制，浏览器使用现有镜像预装 Playwright 和 Chromium。
- `npm run typecheck`、`npm run build`、49 项 Web 测试和 4 项桥接协议测试通过。覆盖同步答案校验和原有 MCP 表单、异步问题归属、重复提交、同名问题及待处理请求快照。修改文件以 UTF-8 无 BOM 回读，中文及双语入口正常。
- 在真实 0.167.2 app-server、MQTT 和浏览器之间，分别完成同步和异步提问、网页答题、模型接口收到答案并继续输出。模型接口使用 `web/test/user-input-provider.cjs` 提供可控 Responses SSE。浏览器脚本为 `web/test/user-input-ui.cjs`。
- 双账号可查看同一会话和提问。一方回答后双方关闭卡片。并发答题仅接受一次，切换会话保留本页草稿，刷新、浏览器重连和 Web 服务重启恢复待答问题。停止任务或执行端重启后，旧同步请求不能提交。未登录不能读取问题或提交答案。
- 浅色、深色和手机视口已截图。浏览器响应夹具验证密码输入、键盘提交、提交失败保留内容和重试，以及虚拟时钟触发非阻塞问题自动跳过。

## 验收限制和记录

独立测试的现有模型服务在提问前返回 HTTP 504，最小请求重试也在 60 秒内未返回。因此真实模型发起同步和异步问题的目标仍未通过。可控响应测试验证了真实 app-server 的协议和端到端传输。正式 Windows 桌面桥没有进行浏览器闭环验收。

最终浏览器结果见 Git 忽略的 `web/test-results/input-ui.json`，各次运行有单独报告。实际模型失败见 `input-live.json`，截图为 `input-*.png`。复跑时在同一隔离网络启动模型夹具，并在脚本输出 `RESTART_WEB` 和 `RESTART_EXECUTOR` 时分别重启对应服务。浏览器脚本须在独立容器运行，避免执行端重启时中断测试进程。

测试资源清单和清理结果见 `input-cleanup.json`。已清理本轮登记的 16 个自建会话及对应测试目录，隔离账号记录保留在测试数据目录。

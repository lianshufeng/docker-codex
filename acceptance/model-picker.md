# Web 模型与思考强度验收

使用独立的 MQTT、Web、`CODEX_HOME`、工作目录和测试账号。浏览器在独立容器中使用镜像预装的 Playwright 和 Chromium。测试未连接正式 Windows 桌面。

| 场景 | 实测结果 |
| --- | --- |
| Codex 0.170.0 与可控 Responses 服务 | 浏览器确认普通和计划模式下的模型与强度均送达服务。覆盖运行时锁定、非法档位拒绝、重试去重、两个账号共享任务状态、历史和中文附件，以及未登录拒绝。 |
| Codex 0.170.0 跨服务商 | 在同一目录创建使用另一服务商的会话，首轮到达对应服务。重启 app-server 后在同一会话继续，服务路由与强度保持。 |
| Codex 0.167.2 | 目录仅展示启动服务商，提交其他服务商返回 409。同一服务商的计划模式请求把所选高档传到推理接口。 |
| vLLM 0.18.0、llama.cpp 8499 | 使用 Qwen3-0.6B，在关闭执行端 `features.multi_agent` 后分别完成真实流式任务。直接测试两个服务的 `reasoning.effort=none/high` 均返回推理内容，未确认该模型和版本组合的档位差异。 |
| 官方 GPT 目录 | 单元测试覆盖目录分页、模型新增和下架、档位校验。本轮未使用已确认可调用官方 GPT 的凭据，未验证实际生成。 |

运行 `npm --prefix web run typecheck`、`npm --prefix web run build`、`npm --prefix web test` 和 `npm --prefix app-server test`。Web 测试 54 项、桥接测试 4 项通过。

浏览器测试脚本为 [model-picker-ui.cjs](../web/test/model-picker-ui.cjs)。在隔离网络启动 [可控模型服务](../web/test/model-picker-provider.cjs)，在执行端配置 `fixture_a`、`fixture_b`，分别指向夹具的 `/a/v1`、`/b/v1`，默认使用 `fixture_a` 的 `gpt-5.4`。Web 的 `modelProviders` 为甲服务配置 `gpt-5.4` 的 `low/medium/high` 和 `gpt-5.3-codex` 的 `none/high`，默认分别设为 `medium` 和 `none`。为乙服务配置 `gpt-5.4` 的 `low/high`，默认 `low`。从同一隔离网络运行浏览器脚本，两个参数依次为 Web 和夹具的 HTTP 地址。

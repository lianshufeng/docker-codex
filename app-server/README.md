# Codex app-server MQTT 服务

服务由独立 Mosquitto Broker 和 Codex 容器组成，Codex 容器内的桥接进程管理一个 app-server 子进程。独立 CLI Compose 位于根目录 `docker-compose-cli.yaml`。Web 示例直接读取远端线程并按 cwd 分组，多个登录用户共享所有业务数据。

## 启动

无需 `.env`，默认账号密码已经配置好，可直接启动。MQTT 客户端账号密码在 `mosquitto/config/mqtt.json`（不是 Codex 模型密钥）：

```json
{
  "username": "admin",
  "password": "admin@2026"
}
```

Broker 对应的默认密码哈希也已放在 `mosquitto/config/passwords`。默认 topic 前缀为 `codex/admin/`。修改密码时，先修改 JSON，再用以下命令输入同一密码更新 Broker：

```bash
docker run --rm -it --mount "type=bind,source=./mosquitto/config,target=/auth" eclipse-mosquitto:2 mosquitto_passwd /auth/passwords admin
```

`mosquitto/config/mqtt.json` 只读挂载给桥接，`mosquitto/config/` 整个目录只读挂载给 Broker。仓库提供的是公开的默认账号密码，部署时请修改，实际密码不要提交 Git。凭据文件仍排除在 Docker 构建上下文之外，`mosquitto/data/` 仍忽略 Git。用户名同时作为实例 ID，只允许字母、数字、下划线和连字符；更换用户名时也需在密码文件中创建相同账号。确保凭据能分别被 node（UID 1000）和 mosquitto（UID 1883）读取；Linux 宿主机的数据目录需允许 UID 1883 写入。Codex 模型认证仍由 `codex-home/auth.json` 和 `codex-home/config.toml` 管理。

默认连接地址 `mqtt://127.0.0.1:1883`，容器内桥接默认连接 `mqtt://mqtt:1883`；仅连接其他 Broker 时在 JSON 中额外填写 `url`。端口和挂载目录在 Compose 对应位置修改。

服务 Compose 直接使用固定路径和配置值，不读取环境变量作为默认值；验收脚本另行生成隔离测试配置，不修改部署文件。

```bash
docker compose -f docker-compose.yaml up -d
docker compose -f docker-compose.yaml logs -f codex-app-server
```

修改两个凭据文件后重新创建服务以重新加载挂载文件：

```bash
docker compose -f docker-compose.yaml up -d --force-recreate
```

服务模式挂载的 CODEX_HOME 与 CLI 相同，可先按根 README 完成登录。启动与线程查询无需调用模型，实际任务需要有效认证及可用模型。桥接不会关闭 Codex 沙箱或审批策略。

Mosquitto 镜像由 Compose 的 image 配置。Broker 默认仅映射宿主机回环地址，同 Compose 网络中的服务通过 `mqtt:1883` 访问。跨主机部署需要配置 TLS；JSON 的 url 支持 `mqtts://`，保持证书校验开启。

## 协议

Web 和新客户端统一使用桌面兼容接口，业务请求直接沿用 app-server JSON-RPC。旧客户端仍可使用下文的信封接口。从旧镜像部署时，需要构建包含当前桥接代码的镜像，再重建 app-server 容器。

| Topic | 统一接口 |
|---|---|
| `codex/+/status` | 发现就绪实例。仅选择唯一同时满足 `attached=true` 和 `writerReady=true` 的实例。 |
| `codex/<实例>/command` | 发布 `{ "id": "客户端唯一请求ID", "method": "model/list", "params": {} }`，QoS 1，禁止保留消息。 |
| `codex/<实例>/reply/<id>` | JSON-RPC 响应或桥接错误。以主题和请求 ID 关联。 |
| `codex/<实例>/observed/output` | JSON-RPC 通知及反向请求。 |

请求 ID 使用 1–64 个字母、数字、下划线或连字符。反向请求的结果通过 `rpc/respond` 提交，参数为 `{ "requestId": 原反向请求ID, "result": {} }`。新桥在状态中公布 `protocolVersion: 1`、`runId`、`methods` 和 `maxRequestBytes`。`methods` 为 `*` 表示透传，由 app-server 判定支持的方法。旧桌面桥使用相同主题，但省略能力声明。客户端在发送超时或断线后应先查询状态，避免自动重放。Broker 须允许状态发现，业务读写仍按实例主题授权。

使用 MQTT 5。同一实例只由一个可信业务后端协调输入，确保在途 JSON-RPC 请求 ID 唯一。Broker 用户名等于实例 ID，ACL 限制其访问 `codex/<用户名>/#`。其他租户需要各自账号、实例和隔离的数据目录。不要把此账号直接分发给终端用户。

| Topic | 说明 |
|---|---|
| `codex/admin/command` | 标准 app-server JSON-RPC 请求、通知及反向请求响应 |
| `codex/admin/reply/<id>` | 标准请求的直接响应 |
| `codex/admin/in` | 兼容旧客户端的请求信封 |
| `codex/admin/out` | 桥接发布原始 RPC 消息或桥接错误 |
| `codex/admin/status` | 保留的状态，包含 state、runId、time；异常断线的遗嘱为 offline |

先订阅 out 和 status，等待 `state=ready`，保存 runId。桥接独占 initialize/initialized，业务端不要再次初始化。

输入示例（messageId 必须唯一，expiresAt 使用发送时刻之后不超过 60 秒的毫秒时间戳）：

```json
{
  "messageId": "业务生成的唯一消息标识",
  "runId": "最近一次ready状态中的runId",
  "expiresAt": 1794000030000,
  "payload": { "id": 1, "method": "thread/list", "params": { "limit": 1 } }
}
```

输出示例：

```json
{
  "type": "rpc",
  "runId": "当前进程标识",
  "eventId": "输出事件唯一标识",
  "time": 1794000000000,
  "payload": { "id": 1, "result": { "data": [] } }
}
```

`payload` 保留 app-server 请求、响应或通知，不按方法白名单裁剪。审批请求也从 out 发出，业务端将对应 `{id,result}` 或 `{id,error}` 放入新输入信封返回。输入请求 ID 不得以 `__bridge_` 开头。

输入和输出使用 QoS 1、retain=false。桥接拒绝带 retain 标记的指令并禁止订阅时回放保留指令。调用方不得发送 retained 指令。相同 messageId 在有效期内仅处理一次；重试必须保留原 messageId、runId、expiresAt 和 payload。业务端按 eventId 去重输出。

`type=bridgeError` 表示桥接拒绝输入，payload 包含 code 和可解析的 messageId。MQTT PUBACK 仅表示消息投递，不代表 RPC 已执行或任务已完成，应以 RPC 响应和 turn/completed 等事件为准。

## 异常和容量边界

- 标准 JSON-RPC 桥接不按业务方法或固定消息大小裁剪，MQTT Broker 和进程背压负责保护资源。大文件使用独立 MQTT 二进制分块接口，块大小由状态能力声明。
- `status.fileTransfer` 声明版本、块大小和文件上限。请求主题为 `codex/<实例>/files/request/<请求ID>`，对应回包为 `files/reply/<请求ID>`。请求和响应均使用 QoS 1，关闭 retain。数据包依次包含 4 字节大端 JSON 头长度、UTF-8 JSON 头和可选二进制块。上传按 `begin`、`write`、`finish` 操作，`status` 查询进度，`abort` 取消。下载用 `open` 获取版本和大小，`read` 按偏移读取并校验版本。
- 输入待写及输出缓冲采用背压，队列耗尽时报告桥接错误并停止继续接收。
- 标准 `command` 通道不设置业务请求数量、方法或 JSON 大小上限；MQTT 协议最大报文和进程背压仍然适用。
- Broker 短时断线会重连并重新订阅，输出暂存在内存；订阅成功后重新发布就绪状态。调用方也应等重新订阅和新就绪事件后发指令。
- 输出缓冲耗尽时服务明确退出，由 Compose 重启；不静默丢事件并宣称完成。
- app-server 异常退出后约 2 秒重启，生成新 runId。旧 runId 指令被拒绝。
- SIGTERM/SIGINT 关闭子进程，超时后强制终止，退出时标记离线。

队列和去重状态不跨桥接进程重启保存，不承诺业务操作恰好执行一次。runId 变化、事件缺失或超时后，业务端应先查询线程和任务状态，再决定恢复或重试，不能自动重放有副作用的命令。Broker 持久化也不等于任务结果持久化。

## 验证

在 app-server 目录安装锁定依赖并运行单元测试：

```bash
npm ci
npm test
```

真实链路测试从仓库根目录运行，环境中的密码和实例 ID 应与服务一致：

```bash
MQTT_PASSWORD='你的密码' node app-server/test/smoke.mjs
```

PowerShell：

```powershell
$env:MQTT_PASSWORD='你的密码'
node app-server/test/smoke.mjs
```

测试会主动杀死测试 app-server 子进程并重启 Broker，应在独立测试部署中运行。它覆盖真实 RPC、错误输入、去重、子进程恢复、Broker 重连及跨实例发布拒绝，不消耗模型调用。模型生成、工具执行和实际审批需使用测试账号另外验收。

### 真实模型验收

从仓库根目录执行：

```bash
node app-server/test/acceptance.mjs
```

脚本使用独立 Compose 项目 `codex-mqtt-acceptance` 和端口 18884，复制 `codex-home` 的 config.toml、auth.json 到隔离运行目录；可通过 `ACCEPTANCE_CODEX_HOME` 和 `ACCEPTANCE_MQTT_PORT` 覆盖。需要先构建 `docker-codex:app-server`，并安装 app-server 的 npm 依赖。验收会消耗已配置模型的调用额度。

覆盖 40 个并发 RPC、两个工作槽调度四个真实任务、JSON 计算与中文文件、线程上下文、流式文本、实际工具执行、中断、运行中 Broker 重启、审批拒绝往返、容器重启后的线程恢复。全访问沙箱仅用于此隔离样本验收，不改变服务默认策略。测试中的线程和文件均为自建样本。

报告在 `acceptance/results/report.json`，样本文件在 `acceptance/.runtime/workspace`。这些目录与复制的认证均被 Git 和 Docker 构建上下文忽略。脚本结束会停止并删除测试容器，保留本地报告和样本用于复核；不修改源认证文件和原会话数据库。

停止服务：

```bash
docker compose -f docker-compose.yaml down
```

停止服务会保留宿主机 `mosquitto/data/` 中的数据。

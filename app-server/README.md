# Codex app-server MQTT 服务

服务由独立 Mosquitto Broker 和 Codex 容器组成，Codex 容器内的桥接进程管理一个 app-server 子进程。现有 CLI Compose 保持不变。用户与线程 ID 的对应关系由业务后端维护。

## 启动

无需 `.env`，Compose 只挂载凭据文件，不生成或修改账号密码。首次创建 `mosquitto/config/mqtt.json`，填写 MQTT 客户端账号密码（不是 Codex 模型密钥）：

```json
{
  "username": "default",
  "password": "替换成你的密码"
}
```

Mosquitto 配置放在 `mosquitto/config/`，数据放在 `mosquitto/data/`。用自带命令交互输入同一密码，生成 `mosquitto/config/passwords`：

```bash
docker run --rm -it --mount "type=bind,source=./mosquitto/config,target=/auth" eclipse-mosquitto:2 mosquitto_passwd -c /auth/passwords default
```

`mosquitto/config/mqtt.json` 只读挂载给桥接，`mosquitto/config/` 整个目录只读挂载给 Broker。客户端凭据、密码文件和 `mosquitto/data/` 均已忽略 Git 和构建上下文。用户名同时作为实例 ID，只允许字母、数字、下划线和连字符；更换用户名时也需在密码文件中创建相同账号。确保凭据能分别被 node（UID 1000）和 mosquitto（UID 1883）读取；Linux 宿主机的数据目录需允许 UID 1883 写入。Codex 模型认证仍由 `codex-home/auth.json` 和 `codex-home/config.toml` 管理。

默认连接地址 `mqtt://127.0.0.1:1883`，容器内桥接默认连接 `mqtt://mqtt:1883`；仅连接其他 Broker 时在 JSON 中额外填写 `url`。端口和挂载目录在 Compose 对应位置修改。

服务 Compose 直接使用固定路径和配置值，不读取环境变量作为默认值；验收脚本另行生成隔离测试配置，不修改部署文件。

```bash
docker compose -f docker-compose-app-server.yaml up -d
docker compose -f docker-compose-app-server.yaml logs -f codex-app-server
```

修改两个凭据文件后重新创建服务以重新加载挂载文件：

```bash
docker compose -f docker-compose-app-server.yaml up -d --force-recreate
```

服务模式挂载的 CODEX_HOME 与 CLI 相同，可先按根 README 完成登录。启动与线程查询无需调用模型，实际任务需要有效认证及可用模型。桥接不会关闭 Codex 沙箱或审批策略。

Mosquitto 镜像由 Compose 的 image 配置。Broker 默认仅映射宿主机回环地址，同 Compose 网络中的服务通过 `mqtt:1883` 访问。跨主机部署需要配置 TLS；JSON 的 url 支持 `mqtts://`，保持证书校验开启。

## 协议

使用 MQTT 5。同一实例只由一个可信业务后端协调输入，确保在途 JSON-RPC 请求 ID 唯一。Broker 用户名等于实例 ID，ACL 限制其访问 `codex/<用户名>/#`。其他租户需要各自账号、实例和隔离的数据目录。不要把此账号直接分发给终端用户。

| Topic | 说明 |
|---|---|
| `codex/default/in` | 业务后端发送请求、通知及对 Codex 反向请求的响应 |
| `codex/default/out` | 桥接发布原始 RPC 消息或桥接错误 |
| `codex/default/status` | 保留的状态，包含 state、runId、time；异常断线的遗嘱为 offline |

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

- 输入最大 1 MiB、stdout 单行最大 1 MiB。
- 输入待写缓冲最大 8 MiB；输出缓冲最大 4096 条且不超过 8 MiB。
- 去重最多保存 10000 个未过期标识，满时拒绝新输入，不淘汰仍有效的标识。
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
docker compose -f docker-compose-app-server.yaml down
```

停止服务会保留宿主机 `mosquitto/data/` 中的数据。

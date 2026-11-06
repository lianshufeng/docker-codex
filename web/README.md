# Web 示例

React 前端和 Node.js 服务端位于本目录，复用现有 MQTT 桥接与单个 Codex app-server。一个 Node.js 进程提供页面、API 和 WebSocket；不需要数据库或新镜像。

## 启动

先在仓库根目录启动 Codex 和 Broker：

```bash
docker compose -f docker-compose-app-server.yaml up -d
```

再启动 Web：

```bash
cd web
docker compose up -d
```

打开 [http://localhost:3000](http://localhost:3000)，注册自己的账号。没有预置 Web 用户。

Web 使用 `node:24-bookworm-slim`，挂载本目录为 `/app`、`../workspace` 为 `/workspace`，与 Codex 共享同一份文件。使用 Node 镜像自带的 node 用户（UID 1000），与 Codex 保持一致。首次启动自动安装锁定依赖并构建前端；依赖和页面输入没有变化时，再次启动会跳过这两步。无需制作镜像或设置 `.env`。

依赖位于挂载的 `web/node_modules`。Linux 宿主机上确保 `web/` 和 `workspace/` 对 UID 1000 可写；不要让 root 运行 Web 后创建只有 root 能写的项目目录。不同系统不要同时共用同一 node_modules 执行本机和容器构建。

查看日志、停止服务：

```bash
docker compose logs -f
docker compose down
```

停止 Web 不影响 Codex 正在执行的任务。

## 配置

直接编辑 `config.json`。默认通过 `host.docker.internal:1883` 访问根 Compose 已映射的 MQTT 端口，Compose 配置了 host-gateway，同时适用于 Docker Desktop 和支持 host-gateway 的 Linux Docker。

MQTT 默认公开示例账号为 admin / admin@2026，与 `mosquitto/config/mqtt.json` 和 Broker 密码文件保持一致。更换账号密码时同步修改这三个位置，实际部署密码不要提交 Git。浏览器不会接收 MQTT 凭据。

- `port`：Node 服务端监听端口，修改后同步修改 Compose 端口。
- `workspaceRoot`：Web 容器内的共享磁盘路径。
- `codexWorkspaceRoot`：传给 Codex cwd 的容器路径，默认也是 `/workspace`。
- `dataDirectory`：用户数据目录，相对于 web/。
- `sandbox`、`approvalPolicy`：新线程的执行策略。默认沿用验收用的 danger-full-access / never，可按自己的环境调整。

## 数据规则

```text
web/data/users.json                 # 用户、密码哈希、登录凭据哈希
workspace/用户ID/项目ID/
  .web-project.json                 # 项目显示名、会话ID与threadId映射
  实际文件……
```

ID 由服务端生成，项目改名不移动目录。项目列表扫描磁盘，不另存项目索引。JSON 修改串行化并原子替换；仅支持单个 Web 服务进程，不要横向扩容后共写 users.json。

聊天历史直接使用 app-server 的分页接口，兼容尚未物化的空线程与旧线程读取；不重复记录聊天 JSONL。刷新或重连后重新加载历史。Codex 重启后未发送过消息的空线程可能没有持久化记录，Web 只为这种空会话重新创建线程，不重放任务。

`config.json` 的 `maxConcurrentTasks` 为 Web 服务所有用户共享的任务并发上限，默认 4，必须是正整数，修改后重启 Web 生效。同项目的不同会话可以并发，同一会话只允许一个任务，追加要求和停止不占新名额。达到上限返回 HTTP 429，暂不排队；任务完成或停止后释放名额，Web 重启后从 app-server 恢复运行状态。直接通过 MQTT 发起的外部任务不受此 Web 配置限制。

消息框支持 Ctrl+V 粘贴剪贴板图片，可预览、移除、仅发送图片或随文字发送。每条最多 4 张 PNG、JPEG、WebP 或 GIF，单张不超过 2 MB。图片保存在当前项目 attachments 目录，通过共享路径作为 localImage 传给 app-server，历史消息可再次查看；删除附件文件后对应预览将失效。识图效果取决于配置的模型是否支持视觉输入。

回复中的 Markdown 图片、指向图片文件的链接和 imageView 事件可直接显示图片，点击可打开原图。支持当前项目内的相对路径、绝对路径、file/sandbox 路径，以及 HTTP/HTTPS 图片地址。本地图片通过登录鉴权接口读取，不能访问其他用户或项目外的文件；删除图片后显示不可用提示。网页截图任务可要求 Codex 在回复中输出 `![截图](./screenshot.png)`。

执行中禁止删除项目、运行中的会话和项目文件；操作完成后可删除。项目删除会逐个删除线程并持久化进度，失败可重试。同项目并发任务共享项目目录，应避免同时修改同一个文件。

删除项目会同时删除挂载目录 `/workspace/用户ID/项目ID` 及其中的全部文件，用户目录为空时一并清理；启动时也会清理已注册用户遗留的空目录。删除单个会话仅删除聊天线程及映射，保留项目共享文件；文件可在文件面板单独删除。

文件接口只允许当前用户项目路径，拒绝路径穿越与符号链接，隐藏 `.web-` 元信息；下载使用文件流。项目里的元信息不是可信权限凭证，服务端会核对线程 cwd。

**示例边界：** 所有用户共享一个 app-server、一个运行身份及工作空间；cwd 和目录划分不是模型命令的强隔离。Web 接口和事件做用户归属检查，但这不是面向不可信用户的安全沙箱。不要直接公开默认密码的 MQTT Broker，也不要把本示例当作已完成生产多租户隔离。

## 验收

两份 Compose 启动后，在 web/ 执行：

```bash
docker compose exec -T web npm test
docker compose exec -T web npm run typecheck
docker compose exec -T web npm audit --omit=dev
```

完整接口验收从宿主机执行（需要 Node.js 和 Docker CLI；依赖由启动时准备）：

```bash
node test/acceptance.mjs
```

它会创建独立命名的两个测试用户和项目，通过真实远程模型生成浏览器截图、Word、PDF、JSON，检查下载、历史、跨用户拒绝、运行中保护、停止、改密和删除；中间重启 Web。会消耗模型额度。测试只删除它自己创建的项目，保留测试用户和忽略 Git 的 `test-results/acceptance.json`，不会触碰原有项目。

前端界面可从浏览器注册、创建项目和会话后直接验收。右上角“文件”打开项目文件管理；左下角用户菜单提供改密、退出；项目和会话行悬停显示改名和删除按钮。

连接与空会话恢复的独立验收：`node test/recovery.mjs`。该测试会重启 Broker 和 app-server，应在验收环境运行；它只操作自己创建的项目，不调用模型。

源代码及配置以 UTF-8 无 BOM 保存。data、dist、node_modules、test-results 均忽略 Git。

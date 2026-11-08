# Web 示例

React 前端和 Node.js 服务端位于本目录，复用现有 MQTT 桥接与单个 Codex app-server。一个 Node.js 进程提供页面、API 和 WebSocket；不需要数据库或新镜像。

## 启动

先在仓库根目录启动 Codex 和 Broker：

```bash
docker compose -f docker-compose.yaml up -d
```

再启动 Web：

```bash
cd web
docker compose up -d
```

打开 [http://localhost:3000](http://localhost:3000)，注册自己的账号。没有预置 Web 用户。

Web 使用 `node:24-bookworm-slim`，仅挂载本目录为 `/app`，使用镜像自带的 node 用户（UID 1000）。工作目录和文件全部由 MQTT 对接的 app-server 访问，Web 无需工作目录挂载。首次启动自动安装锁定依赖并构建前端；依赖和页面输入没有变化时，再次启动会跳过这两步。无需制作镜像或设置 `.env`。

依赖位于挂载的 `web/node_modules`。Linux 宿主机上确保 `web/` 对 UID 1000 可写；执行端的 workspace 权限由其运行身份决定。不同系统不要同时共用同一 node_modules 执行本机和容器构建。

启动缓存会区分操作系统、CPU 架构和 Node.js 主版本，并检查当前平台的 Vite 启动文件。从 Docker 切换到 Windows 原生启动时会自动重新安装对应依赖。

查看日志、停止服务：

```bash
docker compose logs -f
docker compose down
```

停止 Web 不影响 Codex 正在执行的任务。

## 配置

直接编辑 `config.json`。仓库默认 `mqtt.url` 为 `mqtt://127.0.0.1:1883`；在 Docker 内运行 Web 时，启动前改为 `mqtt://host.docker.internal:1883`（Linux Compose 已添加宿主机网关）。Web 通过统一的 MQTT 接口发现唯一就绪的执行端。同一账号应只看到一个就绪实例。切换 Docker 或桌面仅修改 MQTT 地址、端口、账号和密码，没有模式开关。

MQTT 默认公开示例账号为 admin / admin@2026，与 `mosquitto/config/mqtt.json` 和 Broker 密码文件保持一致。更换账号密码时同步修改这三个位置，实际部署密码不要提交 Git。浏览器不会接收 MQTT 凭据。

- `port`：Node 服务端监听端口，修改后同步修改 Compose 端口。
- `dataDirectory`：仅用户和登录数据目录，相对于 web/；原 `workspaceRoot`、`codexWorkspaceRoot` 不再使用。
- `sandbox`、`approvalPolicy`：新线程的执行策略。默认沿用验收用的 danger-full-access / never，可按自己的环境调整。

### 连接 Windows 桌面

在 [CodexSeesionManager](https://github.com/lianshufeng/CodexSeesionManager) 启动远程状态服务并确认写端就绪。把 `mqtt.url` 改为 `mqtt://127.0.0.1:1883` 并填写桌面 Broker 凭据。将 `host` 设为 `127.0.0.1` 可仅从本机访问，将 `sandbox` 设为 `workspace-write` 可按项目工作区执行。然后使用 Windows 原生 Node.js 启动：

```powershell
cd web
node start.mjs
```

Web 不直接读取本机项目文件，Windows 路径同样交给远端 app-server。桥只负责 MQTT、管道转发、请求关联和传输背压，不按业务方法设置白名单。新版桌面桥状态声明 `methods: "*"`，由 app-server 返回方法支持情况。文件分块大小由执行端能力声明。旧打包版桥仍需升级。

会话改名通过 `thread/name/set` 写入执行端，并重新读取确认。旧桥不支持命名时，“创建会话”直接创建未命名会话，不显示不可用的名称输入框。新桥命名失败但线程已创建时，Web 返回已创建的会话并提示名称未保存，避免再次确认产生重复线程。新版桌面桥透传普通标准 RPC，由 app-server 决定方法支持情况。

本次新版桥源码位于相邻的 `CodexSeesionManager` 仓库，已通过独立 Windows app-server 和 18885 端口验证；生产桌面未替换、未重启。切换执行端后列表从新执行端重新查询，不自动迁移线程或重放任务。

## 数据规则

```text
web/data/users.json                 # 唯一本地持久化业务数据：用户、密码与登录凭据哈希
执行端任意已有绝对目录/               # 线程 cwd；按目录分组显示为项目
  attachments/随机前缀-原文件名       # 通过分块文件接口上传
  实际文件……
```

项目来自分页 `thread/list`，并补充 `thread/loaded/list` 中尚未物化的线程；项目 ID 由规范化 cwd 编码，展示名称为目录末段。app-server 没有通用项目管理 API，桌面里只收藏了目录但没有会话的项目不会出现，可手动选择该目录创建会话。登录 JSON 修改串行化并原子替换；仅支持单个 Web 服务进程，不要横向扩容后共写 users.json。既有 `.web-project.json` 和目录保留，但不再读取或写入。

聊天历史直接使用 app-server 的分页接口，不重复记录聊天 JSONL。刷新或重连后重新加载历史。Codex 重启后未发送过消息的空线程可能没有持久化记录；Web 遵循执行端状态，不另建替代线程。当前列表查询未归档线程，可归档会话，恢复归档可在原客户端操作。

切换模型服务时，优先保留原 model_provider 标识，只修改对应 base_url 和模型名称；标识不代表实际服务商。当前 app-server 会检查历史会话与全局 provider 是否一致，直接改名或删除旧 provider 可能导致旧会话无法继续。

Web 不设置任务并发上限。多个会话可以并发运行，执行端负责调度、审批和资源保护。Web 只在同一会话的删除、改名和状态读写期间使用短锁避免重复提交。

消息框支持 Ctrl+V 粘贴剪贴板图片，可预览、移除、仅发送图片或随文字发送。附件数量和容量由执行端及 MQTT 传输能力决定。小文件经 app-server `fs/*` 管理，大文件通过 MQTT 分块传输，显示进度并支持失败续传。上传完成后消息只引用执行端附件路径，图片以远端绝对路径作为 localImage 传给 app-server。历史消息可再次查看，删除附件后预览失效。识图效果取决于模型。

回复中的 Markdown 图片、图片文件链接和 imageView 事件可显示图片。支持当前项目内的相对路径、Windows/POSIX 绝对路径、file/sandbox 路径及 HTTP/HTTPS 图片地址。远端图片经登录鉴权接口读取，限制在所选目录内；删除图片后显示不可用提示。可要求在回复中输出 `![截图](./screenshot.png)`。

运行中的会话不可删除，目录内有活动任务时文件不可删除。同目录并发任务共享文件，应避免同时修改同一个文件。外部客户端也能操作相同执行端，并发检查不能代替执行端权限与文件锁。

项目只是目录分组，不支持整体改名或删除目录；归档单个会话调用 `thread/archive`，保留历史、目录和文件。归档最后一个会话后该分组可能消失，目录仍保留。文件或子文件夹可单独删除，并明确提示不可恢复。

文件目录通过 app-server 的 `fs/*` 读取，路径和符号链接仍由服务端校验。普通文件内容使用 MQTT 分块文件接口，块大小由执行端能力声明，SHA-256 校验后原子提交。下载支持 Range，执行端文件变化会终止本次下载。文件接口不接受 UNC 路径和特殊文件名。

上传失败后可在同一浏览器重新选择原文件继续。上传进度保留 24 小时，过期临时文件在该附件目录下一次开始新上传时清理。旧桥不声明分块能力时，Web 会提示升级连接服务。

**共享边界：** 多账号仅区分登录，每个账号具有相同的线程、历史、任务、审批和文件权限，事件向所有已登录账号广播，不做用户隔离。cwd 和路径校验不是模型命令的安全沙箱。浏览器没有 MQTT 凭据或任意 RPC 入口。不要向不可信用户开放，也不要公开默认密码的 Broker。

## 验收

两份 Compose 启动后，在 web/ 执行：

```bash
docker compose exec -T web npm test
docker compose exec -T web npm run typecheck
docker compose exec -T web npm audit --omit=dev
```

完整接口验收从宿主机执行（需要 Node.js 和 Docker CLI；依赖由启动时准备）：

```bash
node test/shared-acceptance.mjs http://127.0.0.1:31021 mqtt://127.0.0.1:18884 /workspace
```

先用根目录和 Web Compose 的配置生成隔离实例，临时 Broker 为 18884、Web 为 31021，执行端 workspace 使用专属测试目录。该脚本验证执行端先创建会话、两个 Web 账号共享列表与改名、真实附件任务与跨账号事件、历史、远端下载删除、未登录拒绝和线程删除保留文件。会消耗模型额度，只删除自建目录及线程，测试账号和 `test-results/shared-acceptance.json` 保留并忽略 Git。Web 测试容器不挂载 workspace，用以证明没有本地文件依赖。

前端可注册后直接查看已有会话。新建项目时，后端通过 app-server 文件接口判断执行端路径类型，而非 Web 宿主机系统：Linux 只填写项目名，自动创建 `/workspace/项目名`；同名已有目录复用，不覆盖文件。Windows 在网页文件夹选择器中点选盘符和目录，支持上一级与“此电脑”，确认后创建会话。已有项目下的新会话直接沿用原目录。Windows 选择的是 MQTT 执行端的文件夹，不是浏览器本机的上传目录，无需手填绝对路径。右上角“文件”管理远端文件；左下角用户菜单提供改密、退出。生产桌面禁止运行会重启服务的脚本；仅允许专属测试目录和线程，优先用独立 app-server 与新版桌面桥完成有写入的验收。

旧 `test/acceptance.mjs`、`test/recovery.mjs` 针对历史隔离模式，已停用，不能作为当前共享模式验收入口。

浏览器验收使用镜像已有 Playwright，不安装浏览器。隔离 Codex 容器中执行 `test/shared-ui-acceptance.cjs`（可通过标准输入传入），验证注册、创建远端目录与会话、真实附件任务、下载、刷新历史和手机侧栏；脚本固定连接测试网络的 Web 31021 与 Broker，禁止用于正式部署。

源代码及配置以 UTF-8 无 BOM 保存。data、dist、node_modules、test-results 均忽略 Git。

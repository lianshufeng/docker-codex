# Docker Codex · AI 助手与 MQTT 接入

简体中文 · [English](README.en.md)

用 Docker Compose 运行 Codex，让它在你的项目目录里执行命令、修改代码、生成文件。可以在浏览器里用 **AI 助手** 发任务、查看进度和下载成果，也可以让自己的后端通过 **MQTT** 调用 Codex。

## 效果图

**项目与会话** · 多个账号共享执行端的会话，按工作目录分组，一个目录下可以开多个会话。

![AI 助手工作台，左侧展示多个项目和会话](docs/screenshots/workspace.png)

**聊天与成果** · 在同一页面查看任务回复和生成的文件，可直接下载。

![AI 助手显示发布清单及可下载的项目文件](docs/screenshots/files.png)

<details>
<summary>查看登录界面</summary>

![AI 助手登录页，支持创建账号](docs/screenshots/login.png)

</details>

## 快速启动

需要 Docker 和 Docker Compose。以下命令都在仓库根目录执行。

### 1. 启动 Codex app-server + MQTT

```bash
docker compose -f docker-compose.yaml up -d
```

首次使用且尚未配置模型认证时，可以用设备码登录。按终端提示在浏览器完成授权，然后重启 app-server 以加载认证。

```bash
docker compose -f docker-compose-cli.yaml run --rm codex login --device-auth
docker compose -f docker-compose.yaml restart codex-app-server
```

只做后端集成，到这一步即可。宿主机可通过 `mqtt://127.0.0.1:1883` 连接 Broker。实际执行任务需要可用的模型和认证。默认 MQTT 账号用于本地试用，部署前请更换。 [MQTT 配置与协议](app-server/README.md)

### 2. 启动 Web（AI 助手）

保持上一步的服务运行。首次启动先复制配置示例，已有配置时跳过复制：

```bash
cp web/.config.json web/config.json
docker compose -f web/docker-compose.yml up -d
```

启动前将 `web/config.json` 的 `mqtt.url` 设置为容器可访问的 `mqtt://host.docker.internal:1883`。首次启动会安装锁定的依赖并构建前端。打开 [http://localhost:3000](http://localhost:3000)。默认允许自行注册，设定 `web/config.json` 的 `allowRegistration` 为 `false` 并重启 Web 服务可关闭注册。已有账号仍可登录。已有会话会从执行端直接读取；新建项目时，Linux 执行端只需填写项目名称，自动在 `/workspace/项目名` 创建目录和会话；Windows 执行端通过文件夹选择器点选已有目录，无需输入绝对路径。可以发「生成一份三条待办的发布清单，保存为 launch-checklist.md」，再点右上角 **文件** 查看并下载成果。 [Web 配置与验收](web/README.md)

Web 通过统一的 MQTT 接口连接 Docker 或 Windows 桌面。两种桥都转发标准 app-server JSON-RPC，Web 只需切换 MQTT 地址、端口和凭据。会话来自 app-server，文件由执行端提供，Web 无需挂载工作目录。完整文件功能依赖桥支持 `fs/*` 转发和分块传输。 [Windows 启动与限制](web/README.md#连接-windows-桌面)

网页首屏读取最近 30 个会话和当前会话最近 50 个历史条目，可继续向上翻页或一键回到最新消息。浏览器只订阅当前会话的正文，长命令输出按需读取，本地回复图片先显示缩略图，兼容项目内路径和执行端项目外绝对路径（包括桌面桥的临时图片），通过登录鉴权后直接读取。支持协作模式的执行端可在输入框下方切换「计划模式」，接收并回答交互提问。

Windows 原生启动使用 `mqtt://127.0.0.1:1883`，Docker 内访问宿主机使用 `mqtt://host.docker.internal:1883`。切换运行平台时，启动脚本自动重新安装对应平台的依赖。

## 功能与工作原理

- **多用户、多项目、多会话**。账号只用于登录，所有账号共享同一个 app-server 的会话、历史、任务与文件；项目按线程 `cwd` 分组，不维护本地项目和会话映射。目录分组不提供改名和整体删除，会话归档保留历史、目录和文件。会话名称通过 `thread/name/set` 保存并读取确认，旧桌面桥可创建未命名会话，命名功能需更新连接服务。
- **任务与文件**。支持流式回复、追加要求、停止任务、回答单题或多题交互提问、按 MCP 请求自动生成表单（单选、多选、文本、数字和是非题）或打开外部交互链接、通过输入框「+」多选本地文件、粘贴图片和预览回复图片。小文件通过 app-server `fs/*` 管理，大文件使用统一 MQTT 分块传输后保存到执行端 `attachments/`，支持进度、SHA-256 校验、失败续传、Range 下载和中断清理。附件数量和容量由执行端及 MQTT 背压决定，图片支持 PNG、JPEG、WebP、GIF。文件面板支持浏览、下载和删除，目录中有任务运行时禁止删除。业务方法由 app-server 决定，桥只做标准协议转发。
- 创建或归档会话经执行端确认后，界面立即更新，项目列表在后台同步。
- 回复支持 GitHub 风格 Markdown，包括表格、任务列表、删除线和脚注，也支持代码高亮和 LaTeX 公式。
- **手机操作**。窗口宽度不超过 800px 时，项目菜单默认收起，左上角按钮打开菜单，选择会话后自动关闭。项目行展开会话列表，右上角打开文件抽屉，点击遮罩或关闭按钮返回聊天。触屏输入支持回车换行，点击发送按钮发送消息。
- **查找项目和会话**。侧栏可按项目名或会话名搜索，最近会话默认显示 8 条，点击「查看更多会话」每次追加 20 条。会话按最近发送消息或任务完成时间排序，旧会话用创建时间兜底。项目按最近会话的工作目录分组，首批最多加载 10 个。滚动到项目列表底部，点击「加载更多项目」从上次的位置继续读取，最多追加 10 个。展开项目时补读该目录的会话。
- **会话状态**。侧栏用旋转图标标记正在执行的会话。任务在其他会话或隐藏标签页中结束后显示蓝色未读圆点，查看该会话后清除。未读标记按浏览器和登录账号保存。任务恢复输出或结束时，重连提示会自动消失。
- **部署方式**。Web 使用现成的 Node.js 镜像或本机 Node.js，仅登录数据保存在本地 JSON；Codex 自行管理工作目录。所有账号共享一个 app-server 和运行身份，适用于可信用户，无用户数据隔离。

浏览器通过 HTTP 和 WebSocket 连接 Web 后端。业务后端通过 MQTT 与桥接进程通信，桥接进程再通过标准输入和输出与 Codex app-server 交换 JSON-RPC 消息。MQTT 凭据由业务后端持有。

接入时，先订阅 `codex/+/status`，发现唯一 `attached=true`、`writerReady=true` 的实例，向 `codex/<实例>/command` 发送 app-server 请求，通过 `reply/<id>` 关联响应、`observed/output` 接收流式事件。Docker 桥继续兼容原有 `in/out` 信封接口。 [MQTT 主题与协议](app-server/README.md#协议) · [OpenAI 官方 Codex App Server API 文档](https://developers.openai.com/codex/app-server)

<details>
<summary>展开 Codex CLI、镜像工具与高级配置</summary>

## Codex CLI 参考

独立 CLI 使用根目录 `docker-compose-cli.yaml`，命令需通过 `-f` 指定该文件。MQTT 服务模式使用默认的 `docker-compose.yaml`，配置和消息协议见 [app-server 服务说明](app-server/README.md)。

Web 前后端示例位于 [web/](web/README.md)，使用该目录下的 `docker-compose.yml` 启动，无需工作目录挂载、数据库或构建新镜像。

镜像已预装 Node.js Playwright 与 Chromium headless shell，无需在任务中安装浏览器。可直接执行 `playwright screenshot --browser chromium https://example.com screenshot.png`，或通过 `require('playwright')` 使用默认无头浏览器。`codex-home/AGENTS.md` 提供运行说明，随现有目录挂载进入服务；不要将多个工具探测命令的非零退出码误认为浏览器缺失。

常用工具包括 curl、wget、file、zip/unzip、Poppler，以及 Python 的 python-docx、python-pptx、openpyxl、Pillow、requests、BeautifulSoup。LibreOffice Writer、Calc、Impress 无界面版可将常见 Word、Excel、PPT 文档转成 PDF，再用 `pdftoppm` 按页导出图片；结构化内容提取优先使用 Python 办公库，扫描件 OCR 不在当前镜像范围内。镜像还预装单个 `ffmpeg` 可执行文件，可读取视频、按时间抽帧并制作联系表；不含 `ffplay`、`ffprobe`。PPT 包的安装名是 `python-pptx`，导入名为 `pptx`；Playwright 没有 `fetch` 子命令，静态网页用 curl，动态网页通过 Playwright API 提取。python/python3 与 pip/pip3 统一使用 `/opt/office-venv`，避免登录 Shell 切换 PATH 后使用错误环境。

系统命令补充网络诊断（ping、dig、nslookup、nc、ip、ss）、文件处理（find、tree、du、tar、gzip、zip/unzip）和文本处理（rg、jq、sed、awk、diff、patch、timeout）。不额外安装进程排查工具。网络命令已安装不代表目标站点允许 ICMP 或端口访问，需按实际网络结果判断。

SSH 客户端随镜像预装，包含 ssh、scp、sftp、ssh-keygen、ssh-agent、ssh-add、ssh-keyscan；用于远程连接、文件传输及密钥管理，不安装 SSH 服务端。

镜像工具可在断网环境验收：`docker run --rm -i --network none --entrypoint bash 镜像名 -s < acceptance/tools-smoke.sh`（Linux/macOS Shell）。验收实际创建并读取 Word、Excel、PPT，使用 LibreOffice 转换三类办公文档并逐页生成图片，使用 FFmpeg 生成短视频并抽帧，启动预装浏览器生成截图和 PDF，检查 PDF 提取、渲染及 ZIP 工具。

这个示例用于记录并快速复用 Codex CLI 的常用 Docker 命令，包括：

- ChatGPT Device Code 登录
- 持久化或挂载 `auth.json`
- API Key 登录
- OpenAI-compatible 中转/API 网关
- 用户级技能和项目级技能挂载
- 交互式与非交互式调用

## 目录结构

```text
.
├── Dockerfile
├── docker-compose.yaml         # 默认的 app-server + MQTT 服务
├── docker-compose-cli.yaml     # 独立 CLI
├── codex-home/
│   ├── .config.toml       # 仓库配置模板
│   └── config.toml        # 本地配置，由模板复制，Git 忽略
├── skills/
│   └── example-skill/
│       └── SKILL.md
└── workspace/
```

容器内路径：

| 宿主机 | 容器内 | 用途 |
|---|---|---|
| `./workspace` | `/workspace` | Codex 操作的项目 |
| `./codex-home` | `/home/node/.codex` | 配置、认证、历史、日志 |
| `./skills` | `/home/node/.agents/skills` | 用户级技能 |

## 1. 初始化

首次使用时，从模板生成本地 `config.toml`。下面的命令会保留已有配置。

Linux/macOS：

```bash
[ -e codex-home/config.toml ] || cp codex-home/.config.toml codex-home/config.toml
docker build -t docker.cnb.cool/vvllm/codex .
```

Windows PowerShell：

```powershell
if (-not (Test-Path codex-home/config.toml)) { Copy-Item codex-home/.config.toml codex-home/config.toml }
docker build -t docker.cnb.cool/vvllm/codex .
```

默认操作当前目录下的 `workspace`。要操作真实项目，直接修改 Compose 中的工作目录挂载：

```yaml
- /home/you/projects/my-project:/workspace
```

Windows Docker Desktop 示例：

```yaml
- C:/Users/you/projects/my-project:/workspace
```

## 2. 推荐登录：Device Code

容器或远程环境优先使用 Device Code：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex login --device-auth
```

浏览器完成授权后，凭据会写入：

```text
./codex-home/auth.json
```

检查登录状态：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex login status
```

启动交互式 Codex：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex
```

## 3. 使用宿主机已有的 auth.json

当前 Compose 已将整个 `./codex-home` 挂载为容器的 `CODEX_HOME`。最简单的方法是把已有认证文件复制进去。

Linux/macOS：

```bash
mkdir -p codex-home
cp ~/.codex/auth.json ./codex-home/auth.json
chmod 600 ./codex-home/auth.json
docker compose -f docker-compose-cli.yaml run --rm codex login status
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force codex-home
Copy-Item "$HOME\.codex\auth.json" ".\codex-home\auth.json"
docker compose -f docker-compose-cli.yaml run --rm codex login status
```

也可以只挂载单个文件。先创建 `secrets/auth.json`，再取消 `docker-compose-cli.yaml` 中这行注释：

```yaml
- ./secrets/auth.json:/home/node/.codex/auth.json
```

注意：`auth.json` 会在令牌刷新时被 Codex 更新，因此不要用只读挂载。

## 4. 使用 OpenAI API Key

Linux/macOS：

```bash
export OPENAI_API_KEY='你的密钥'
printf '%s' "$OPENAI_API_KEY" \
  | docker compose -f docker-compose-cli.yaml run --rm -T -e OPENAI_API_KEY codex login --with-api-key
```

Windows PowerShell：

```powershell
$env:OPENAI_API_KEY='你的密钥'
$env:OPENAI_API_KEY |
  docker compose -f docker-compose-cli.yaml run --rm -T -e OPENAI_API_KEY codex login --with-api-key
```

检查：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex login status
```

## 5. 使用中转/API 网关

这里的“中转”按 OpenAI-compatible API 网关处理，通常使用中转方提供的独立 API Key，而不是把 ChatGPT 的 `auth.json` 交给中转方。

在 `codex-home/config.toml` 中配置以下内容，模型名称和地址按中转服务修改；已有配置只修改对应字段，不要重复添加同名字段：

```toml
cli_auth_credentials_store = "file"
model = "中转支持的模型名"
model_provider = "relay"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.relay]
name = "OpenAI-compatible relay"
base_url = "https://你的中转地址/v1"
env_key = "RELAY_API_KEY"
wire_api = "responses"
```

启动时直接传入中转密钥：

```bash
docker compose -f docker-compose-cli.yaml run --rm -e RELAY_API_KEY='你的中转密钥' codex
```

非交互调用：

```bash
docker compose -f docker-compose-cli.yaml run --rm -T -e RELAY_API_KEY='你的中转密钥' codex exec \
  "检查当前项目，输出技术栈、启动方式和明显问题"
```

前提：中转服务必须兼容 Codex 使用的 Responses API。仅兼容传统 Chat Completions 接口的中转不一定可用。

## 6. 挂载和调用技能

### 用户级技能

将技能放在：

```text
skills/<技能名>/SKILL.md
```

Compose 会将整个 `skills` 目录只读挂载到：

```text
/home/node/.agents/skills
```

示例已经包含：

```text
skills/example-skill/SKILL.md
```

进入 Codex 后可以：

```text
/skills
```

或者在提示词中显式调用：

```text
$example-skill 检查当前项目
```

### 项目级技能

项目专用技能可以直接放到项目中：

```text
<项目根目录>/.agents/skills/<技能名>/SKILL.md
```

因为项目根目录已挂载到 `/workspace`，Codex 会自动发现这些技能。

## 7. 常用命令

查看版本：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex --version
```

交互式运行：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex
```

一次性执行任务：

```bash
docker compose -f docker-compose-cli.yaml run --rm -T codex exec \
  "阅读项目并生成一份中文架构说明"
```

进入容器 Shell：

```bash
docker compose -f docker-compose-cli.yaml run --rm --entrypoint bash codex
```

临时挂载另一个项目：

```bash
docker compose -f docker-compose-cli.yaml run --rm -v /path/to/project:/workspace codex
```

更新 Codex CLI：

```bash
docker build --pull --no-cache -t docker.cnb.cool/vvllm/codex .
```

Dockerfile 顶部集中维护基础镜像和 Playwright 的固定值，Codex 默认使用 `latest` 跟随 npm 最新正式版。Python 依赖固定版本维护在 [requirements.txt](requirements.txt)。重建时需重新执行 Codex 安装层才能获取新版，已有镜像不会自动更新。临时指定 Codex 版本可用：

```bash
docker build --build-arg CODEX_VERSION=0.xxx.x -t docker.cnb.cool/vvllm/codex .
```

## 8. 安全注意事项

1. `auth.json` 包含访问令牌，应视同密码，不能提交到 Git、发到群聊或上传到工单。
2. 中转服务可能看到提示词、代码内容和 API 请求，仅使用可信服务。
3. 不建议把 ChatGPT 登录产生的 `auth.json` 发送给第三方中转；普通中转优先使用其独立 API Key。
4. `skills` 默认只读挂载；Codex 需要创建或修改技能时，可临时移除 `:ro`。
5. 只挂载需要 Codex 操作的项目，不要直接挂载整个用户主目录。

## 9. Docker 内沙箱问题

Codex 自身还会使用文件系统沙箱。若宿主机内核不允许容器继续创建嵌套沙箱，可能出现 namespace 或 `bwrap` 相关错误。

在确认容器本身只挂载了可信目录后，可临时测试：

```bash
docker compose -f docker-compose-cli.yaml run --rm codex --sandbox danger-full-access
```

完整的非交互调用示例：

```bash
docker compose -f docker-compose-cli.yaml run --rm -T --interactive=false codex --sandbox danger-full-access --ask-for-approval never exec --skip-git-repo-check "ping"
```

其中 `-T --interactive=false` 禁用终端交互，`--ask-for-approval never` 禁用审批提示，`--skip-git-repo-check` 允许在非 Git 仓库中执行任务。

这会关闭 Codex 在容器内部的额外沙箱，不等于关闭 Docker 隔离，但会让 Codex 能访问容器内所有已挂载内容，因此不要挂载无关敏感目录。

</details>

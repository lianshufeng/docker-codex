# Codex CLI Docker Compose 快速入门

MQTT 服务模式使用独立的 `docker-compose-app-server.yaml`，配置和消息协议见 [app-server 服务说明](app-server/README.md)。原有 CLI 启动方式保持不变。

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
├── docker-compose.yml
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
docker compose run --rm codex login --device-auth
```

浏览器完成授权后，凭据会写入：

```text
./codex-home/auth.json
```

检查登录状态：

```bash
docker compose run --rm codex login status
```

启动交互式 Codex：

```bash
docker compose run --rm codex
```

## 3. 使用宿主机已有的 auth.json

当前 Compose 已将整个 `./codex-home` 挂载为容器的 `CODEX_HOME`。最简单的方法是把已有认证文件复制进去。

Linux/macOS：

```bash
mkdir -p codex-home
cp ~/.codex/auth.json ./codex-home/auth.json
chmod 600 ./codex-home/auth.json
docker compose run --rm codex login status
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force codex-home
Copy-Item "$HOME\.codex\auth.json" ".\codex-home\auth.json"
docker compose run --rm codex login status
```

也可以只挂载单个文件。先创建 `secrets/auth.json`，再取消 `docker-compose.yml` 中这行注释：

```yaml
- ./secrets/auth.json:/home/node/.codex/auth.json
```

注意：`auth.json` 会在令牌刷新时被 Codex 更新，因此不要用只读挂载。

## 4. 使用 OpenAI API Key

Linux/macOS：

```bash
export OPENAI_API_KEY='你的密钥'
printf '%s' "$OPENAI_API_KEY" \
  | docker compose run --rm -T -e OPENAI_API_KEY codex login --with-api-key
```

Windows PowerShell：

```powershell
$env:OPENAI_API_KEY='你的密钥'
$env:OPENAI_API_KEY |
  docker compose run --rm -T -e OPENAI_API_KEY codex login --with-api-key
```

检查：

```bash
docker compose run --rm codex login status
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
docker compose run --rm -e RELAY_API_KEY='你的中转密钥' codex
```

非交互调用：

```bash
docker compose run --rm -T -e RELAY_API_KEY='你的中转密钥' codex exec \
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
docker compose run --rm codex --version
```

交互式运行：

```bash
docker compose run --rm codex
```

一次性执行任务：

```bash
docker compose run --rm -T codex exec \
  "阅读项目并生成一份中文架构说明"
```

进入容器 Shell：

```bash
docker compose run --rm --entrypoint bash codex
```

临时挂载另一个项目：

```bash
docker compose run --rm -v /path/to/project:/workspace codex
```

更新 Codex CLI：

```bash
docker build --pull --no-cache -t docker.cnb.cool/vvllm/codex .
```

固定 Codex 版本：

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
docker compose run --rm codex --sandbox danger-full-access
```

完整的非交互调用示例：

```bash
docker compose run --rm -T --interactive=false codex --sandbox danger-full-access --ask-for-approval never exec --skip-git-repo-check "ping"
```

其中 `-T --interactive=false` 禁用终端交互，`--ask-for-approval never` 禁用审批提示，`--skip-git-repo-check` 允许在非 Git 仓库中执行任务。

这会关闭 Codex 在容器内部的额外沙箱，不等于关闭 Docker 隔离，但会让 Codex 能访问容器内所有已挂载内容，因此不要挂载无关敏感目录。

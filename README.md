# Codex CLI Docker Compose 快速入门

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
├── .env.example
├── codex-home/
│   └── config.toml
├── config/
│   └── proxy.toml
├── skills/
│   └── example-skill/
│       └── SKILL.md
└── workspace/
```

容器内路径：

| 宿主机 | 容器内 | 用途 |
|---|---|---|
| `WORKSPACE_DIR` | `/workspace` | Codex 操作的项目 |
| `./codex-home` | `/home/node/.codex` | 配置、认证、历史、日志 |
| `./skills` | `/home/node/.agents/skills` | 用户级技能 |

## 1. 初始化

Linux/macOS：

```bash
cp .env.example .env
docker compose build
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
docker compose build
```

默认操作当前目录下的 `workspace`。要操作真实项目，修改 `.env`：

```dotenv
WORKSPACE_DIR=/home/you/projects/my-project
```

Windows Docker Desktop 示例：

```dotenv
WORKSPACE_DIR=C:/Users/you/projects/my-project
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

先编辑：

```text
config/proxy.toml
```

至少修改：

```toml
model = "中转支持的模型名"

[model_providers.relay]
base_url = "https://你的中转地址/v1"
```

然后在 `.env` 填写：

```dotenv
RELAY_API_KEY=你的中转密钥
```

启动：

```bash
docker compose --profile relay run --rm codex-relay
```

非交互调用：

```bash
docker compose --profile relay run --rm -T codex-relay exec \
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

指定不同项目，不修改 `.env`：

```bash
WORKSPACE_DIR=/path/to/project docker compose run --rm codex
```

更新 Codex CLI：

```bash
docker compose build --pull --no-cache
```

固定 Codex 版本：

```dotenv
CODEX_VERSION=0.xxx.x
```

然后重新构建：

```bash
docker compose build --no-cache
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

这会关闭 Codex 在容器内部的额外沙箱，不等于关闭 Docker 隔离，但会让 Codex 能访问容器内所有已挂载内容，因此不要挂载无关敏感目录。

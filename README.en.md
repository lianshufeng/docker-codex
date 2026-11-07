# Docker Codex · AI Assistant and MQTT integration

[简体中文](README.md) · English

Run Codex with Docker Compose so it can execute commands, edit code, and generate files in your project directory. Use the **AI Assistant** in your browser to submit tasks, follow progress, and download results, or connect your own backend to Codex over **MQTT**.

## Screenshots

**Projects and sessions** · Each account can create multiple projects, with multiple chat sessions per project.

![AI Assistant workspace with multiple projects and sessions in the sidebar](docs/screenshots/workspace.png)

**Chat and results** · Review the task response and download generated files from the same page.

![AI Assistant showing a launch checklist and its downloadable project file](docs/screenshots/files.png)

<details>
<summary>See the sign-in page</summary>

![AI Assistant sign-in page with account registration](docs/screenshots/login.png)

</details>

## Quick start

You need Docker and Docker Compose. Run these commands from the repository root.

### 1. Start Codex app-server and MQTT

```bash
docker compose -f docker-compose-app-server.yaml up -d
```

If you haven't configured model credentials yet, you can sign in using a device code. Follow the terminal instructions to authorize in your browser, then restart app-server to load the credentials.

```bash
docker compose run --rm codex login --device-auth
docker compose -f docker-compose-app-server.yaml restart codex-app-server
```

For a backend-only integration, stop here. Connect to the broker at `mqtt://127.0.0.1:1883` from the host. Running tasks requires a working model and credentials. The default MQTT account is for local trials. Replace it before deployment. [MQTT configuration and protocol (Chinese)](app-server/README.md)

### 2. Start the Web AI Assistant

Keep the services from step 1 running, then run:

```bash
docker compose -f web/docker-compose.yml up -d
```

The first startup installs locked dependencies and builds the frontend. Open [http://localhost:3000](http://localhost:3000), register, create a project, and start a chat. Try asking for a three-item launch checklist saved as `launch-checklist.md`, then open **文件** (Files) in the upper right to view and download it. [Web configuration and verification (Chinese)](web/README.md)

## Features and how it works

- **Multiple users, projects, and sessions.** Each account manages its own projects. Sessions keep separate chat histories and share files within the same project.
- **Tasks and files.** Stream replies, send follow-up instructions during a task, stop tasks, paste images, preview images in replies, and browse, download, or delete project files. The Web service defaults to four concurrent tasks across all users, with one active task per session.
- **Deployment.** Web and Codex share the host's `workspace/` directory. Web uses an existing Node.js image and file-based storage. All accounts share one app-server and one execution identity. The example is intended for trusted users.

The browser connects to the Web backend over HTTP and WebSocket. The backend talks to the bridge over MQTT, and the bridge exchanges JSON-RPC messages with Codex app-server over standard input and output. MQTT credentials stay with the backend.

Subscribe to `codex/admin/status` and `codex/admin/out`. Once the state is `ready`, use the current `runId` to send requests such as `thread/start` or `turn/start` to `codex/admin/in`. Read responses and streaming events from `out`. [MQTT envelope and topics (Chinese)](app-server/README.md#协议) · [Official OpenAI Codex App Server API documentation](https://developers.openai.com/codex/app-server)

<details>
<summary>Expand CLI, image tools, and advanced configuration</summary>

## Codex CLI reference

The standalone CLI uses the root `docker-compose.yml`. MQTT mode uses `docker-compose-app-server.yaml`, and Web uses `web/docker-compose.yml`.

### Image tools

Playwright and Chromium headless shell are preinstalled. Use `playwright screenshot --browser chromium https://example.com screenshot.png` or `require('playwright')`. Runtime instructions are mounted from `codex-home/AGENTS.md`. Read each tool's result separately when diagnosing failures.

The image includes curl, wget, file, zip/unzip, Poppler, and Python libraries for Word, PowerPoint, Excel, images, HTTP, and HTML parsing. Install names and import names can differ, such as `python-pptx` and `pptx`. Static pages can be fetched with curl, and dynamic pages read through Playwright. Python and pip aliases consistently use `/opt/office-venv`, including in login shells.

Network tools include ping, dig, nslookup, nc, ip, and ss. File and text tools include find, tree, du, tar, gzip, rg, jq, sed, awk, diff, patch, and timeout. Network access depends on the destination and host environment. SSH client tools include ssh, scp, sftp, ssh-keygen, ssh-agent, ssh-add, and ssh-keyscan.

Run the offline tool smoke test from a Linux/macOS shell:

```bash
docker run --rm -i --network none --entrypoint bash IMAGE -s < acceptance/tools-smoke.sh
```

It creates and reads office files, captures a browser screenshot and PDF, and checks PDF extraction, rendering, and ZIP tools.

### Initialize and mount directories

To build locally, first copy the configuration template while preserving an existing configuration.

Linux/macOS:

```bash
[ -e codex-home/config.toml ] || cp codex-home/.config.toml codex-home/config.toml
docker build -t docker.cnb.cool/vvllm/codex .
```

PowerShell:

```powershell
if (-not (Test-Path codex-home/config.toml)) { Copy-Item codex-home/.config.toml codex-home/config.toml }
docker build -t docker.cnb.cool/vvllm/codex .
```

| Host directory | Container directory | Purpose |
|---|---|---|
| `./workspace` | `/workspace` | Project files |
| `./codex-home` | `/home/node/.codex` | Configuration, credentials, history, logs |
| `./skills` | `/home/node/.agents/skills` | User skills |

To work on another host project, change the workspace volume to `/home/you/projects/my-project:/workspace`, or `C:/Users/you/projects/my-project:/workspace` on Docker Desktop.

### Authentication

Device-code login is suitable for containers and remote hosts:

```bash
docker compose run --rm codex login --device-auth
docker compose run --rm codex login status
docker compose run --rm codex
```

Credentials are persisted in `codex-home/auth.json`. You can copy an existing file.

Linux/macOS:

```bash
mkdir -p codex-home
cp ~/.codex/auth.json ./codex-home/auth.json
chmod 600 ./codex-home/auth.json
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force codex-home
Copy-Item "$HOME\.codex\auth.json" ".\codex-home\auth.json"
```

Alternatively, create `secrets/auth.json` and enable its commented volume in the CLI Compose file. Keep it writable for token refresh.

For API-key login, use your own key.

Linux/macOS:

```bash
export OPENAI_API_KEY='YOUR_KEY'
printf '%s' "$OPENAI_API_KEY" | docker compose run --rm -T -e OPENAI_API_KEY codex login --with-api-key
```

PowerShell:

```powershell
$env:OPENAI_API_KEY='YOUR_KEY'
$env:OPENAI_API_KEY | docker compose run --rm -T -e OPENAI_API_KEY codex login --with-api-key
```

### OpenAI-compatible gateway

Edit the relevant fields in `codex-home/config.toml`, avoiding duplicate keys:

```toml
cli_auth_credentials_store = "file"
model = "GATEWAY_MODEL"
model_provider = "relay"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.relay]
name = "OpenAI-compatible relay"
base_url = "https://YOUR_GATEWAY/v1"
env_key = "RELAY_API_KEY"
wire_api = "responses"
```

Pass the gateway key when running:

```bash
docker compose run --rm -e RELAY_API_KEY='YOUR_KEY' codex
docker compose run --rm -T -e RELAY_API_KEY='YOUR_KEY' codex exec "Inspect this project and summarize its stack and startup steps"
```

The gateway must support the Responses API used by Codex. Use the gateway's own credentials and evaluate its access to prompts and code.

### Skills and common commands

Put user skills in `skills/NAME/SKILL.md`. Compose mounts them read-only at `/home/node/.agents/skills`. The included example can be selected through `/skills` or called with `$example-skill Inspect this project`. Project skills belong in `.agents/skills/NAME/SKILL.md` within the mounted project.

The base image and Playwright are pinned at the top of Dockerfile. Codex defaults to npm's `latest` release, and Python dependencies are pinned in [requirements.txt](requirements.txt). Fetching a newer Codex requires rerunning its installation layer during a rebuild. Existing images do not update automatically.

```bash
# Version, interactive CLI, and one-shot task
docker compose run --rm codex --version
docker compose run --rm codex
docker compose run --rm -T codex exec "Read the project and write an architecture summary"
# Container shell and temporary project mount
docker compose run --rm --entrypoint bash codex
docker compose run --rm -v /path/to/project:/workspace codex
# Refresh Codex from npm latest; other versions are pinned in Dockerfile and requirements.txt
docker build --pull --no-cache -t docker.cnb.cool/vvllm/codex .
# Override the Codex version for one build
docker build --build-arg CODEX_VERSION=0.xxx.x -t docker.cnb.cool/vvllm/codex .
```

### Credentials and sandbox settings

Keep `auth.json` private and out of Git. Use trusted gateways and keep ChatGPT login credentials private. Remove the skills volume's `:ro` only when skill editing is needed. Mount only the project directories needed for the task.

If the host blocks nested sandbox creation and reports namespace or bwrap errors, test the following after reviewing the mounted directories:

```bash
docker compose run --rm codex --sandbox danger-full-access
docker compose run --rm -T --interactive=false codex --sandbox danger-full-access --ask-for-approval never exec --skip-git-repo-check "ping"
```

The second command disables terminal interaction and approval prompts and allows a non-Git working directory. Full access removes Codex's additional in-container sandbox, giving it access to all mounted content. Review mounts accordingly.

</details>

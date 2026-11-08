# 共享 app-server 改造验收记录

日期：2026-11-09。Web 本地只维护登录，项目按远端线程 cwd 分组，多个账号共享线程和文件。实测 Docker 为 codex-cli 0.167.0，独立 Windows 执行端为 0.167.0-alpha.3.2。

## 验收环境与保护

- Docker：由根目录及 Web Compose 配置生成独立项目 `codex-unified-acceptance`，MQTT 18884，Web 31021。Codex 使用独立 home/workspace，Web 仅挂载源码目录，不挂载 workspace。临时配置和运行数据在忽略 Git 的 `acceptance/.runtime/unified`、`web/test-results`。
- Windows：独立启动测试 app-server，以相邻 `CodexSeesionManager` 仓库的新版桌面桥源码附加该测试进程，MQTT 18885，Web 31022。使用独立 home/workspace；没有附加、重启或替换生产桌面进程。
- 生产桌面：只读取 MQTT 状态，并调用一次只读 `thread/list`，未创建、修改或删除生产线程和文件。当前正在运行的正式实例仍是旧打包桥，未替换或重启；新版桥已在独立 Windows app-server 上验收。
- 测试目录和线程使用随机标识，脚本只清理自己记录的资源；测试账号及报告保留。默认部署 MQTT 端口仍为 1883，临时端口没有写回部署文件。

## 通过的场景

| 场景 | Docker | 独立 Windows + 新版桌面桥 |
|---|---|---|
| 连续超过 128 次只读请求，桥仍可用 | 通过 | 通过 |
| 执行端先创建线程，两个 Web 账号无需本地映射即可发现 | 通过 | 通过 |
| B 改名直接写入 app-server，A 可看到相同会话 | 通过 | 通过 |
| 未登录查询、下载拒绝；路径穿越拒绝 | 通过 | 通过 |
| 中文子目录创建浏览、远端文件下载、绝对路径图片读取 | 通过 | 通过 |
| A 上传附件并调用真实模型，B 收到流式事件并读取历史 | 通过 | 通过 |
| 同会话重复发送、运行中删除会话或文件拒绝 | 通过 | 通过 |
| 不同会话并发运行，同一会话重复提交仍受保护 | 通过 | 通过 |
| B 追加要求、停止 A 发起的任务，历史显示 interrupted | 通过 | 通过 |
| B 删除文件，A 下载返回 404；删除线程保留目录文件 | 通过 | 通过 |
| 不生成 .web-project.json，禁止整体删除目录分组 | 通过 | 通过 |

Docker 浏览器使用镜像内已有 Chromium：注册、创建远端目录和会话、上传附件并执行真实任务、附件链接下载、刷新恢复历史、390px 手机侧栏均通过；无前端运行错误和横向溢出。浏览器验收发现并修复创建目录与确认会话之间的时序问题。

自动检查：Web 14 项测试、TypeScript 检查、桥协议 4 项测试通过；Web 生产依赖审计无漏洞；桌面桥两个 Python 文件编译检查通过。新增回归检查确保 HTTP 多步操作中执行端变化后不继续写入另一个执行端。

Windows 原生 `node start.mjs` 从 Linux 依赖切换后重新安装对应平台依赖、成功构建并提供 HTTP 200 页面；使用独立 31022 端口验证后已停止。所有本轮测试容器、独立 Web 和测试 app-server 均已停止，生产 MQTT 1883 保持运行。

## 范围和限制

- 生产桌面当前运行的旧打包桥尚未更新。修复已写入 `E:/git/github/CodexSeesionManager/app/services/app_server_mqtt_service.py` 与 `app_server_pipe_writer.py`，需在合适窗口更新运行中的桥后，才能验收生产桌面的完整写入链路。本次没有自动部署这些源码。
- 普通文件使用单块 512 KiB 的 MQTT 分块传输，不设置业务文件总大小上限；上传使用临时文件、块校验和整文件 SHA-256 后原子改名，下载支持 Range。旧桥没有该能力时，Web 会提示升级执行端桥。
- 无用户隔离。各账号可以改名、停止、审批或删除同一执行端的数据；执行端权限才是访问边界。
- app-server 没有通用项目管理接口。项目是非归档线程的 cwd 分组，未建立线程的收藏目录不会自动出现；目录分组不提供整体改名删除。空线程是否跨 app-server 重启保留由执行端决定。
- 审批沿用命令/文件变更的允许拒绝流程；交互提问等其他反向请求未做完整界面适配，未在本轮验收中宣称通过。
- 反向请求的待审批信息仅保存在当前 Web 进程内存；Web 重启后的审批恢复没有持久化兜底，必要时需在原客户端处理或停止任务。
- 未使用旧的用户隔离和恢复验收脚本；它们已加停用保护，避免误重启生产服务。

## 复验入口

`web/test/shared-acceptance.mjs <Web URL> <MQTT URL> <执行端测试父目录> [报告名称]`：仅对专用验收端点运行。Docker 测试父目录 `/workspace`；Windows 必须使用专门创建的绝对测试目录，不能填写正式项目。

接口报告：`web/test-results/shared-acceptance.json`、`web/test-results/shared-windows-acceptance.json`。浏览器报告及截图：`tmp/shared-ui-acceptance.json`、`tmp/shared-ui-desktop.png`、`tmp/shared-ui-mobile.png`。这些运行产物均不提交。

## 新建项目交互补充验收

2026-11-09 按用户要求更新：Linux 执行端只填项目名，自动在 `/workspace/项目名` 建目录和会话，已有同名目录复用；Windows 提供网页远端文件夹选择器，支持盘符、逐级进入、上一级和“此电脑”，不要求输入绝对路径。后端通过 MQTT 文件接口探测执行端路径语义，不依赖 Web 或浏览器所在的系统。

- Docker 真实浏览器通过“只填项目名”创建目录和会话，后续附件任务、下载、刷新历史与手机侧栏仍通过。
- Linux Docker 浏览器访问独立 Windows 测试 Web 31022，通过新版桌面桥 18885 读取真实盘符、进入专属测试文件夹、返回上级再选择，最终创建会话；目录和线程已清理。生产桌面未操作。
- Web 16 项测试及 TypeScript 检查通过，覆盖 Linux 目录名与路径穿越校验、同名目录复用、Windows 盘符发现和断线错误处理。目录选择仍要求桥支持 `fs/*`。
- 本次用户体验用 Docker 环境继续运行在 Web 31021、MQTT 18884；Windows 独立测试进程已停止。

界面报告：`tmp/project-windows-acceptance.json`；截图：`tmp/project-name-dialog.png`、`tmp/project-windows-dialog.png`。测试使用镜像已有 Chromium，未安装浏览器。

## 大文件传输补充验收

- Linux Docker 和独立 Windows 桌面桥均验证了 100 MiB、128 MiB 中文名文件上传下载及整文件 SHA-256 比对。两端通过重复块、续传、Range 请求、超限拒绝、取消和路径越界检查，传输期间会话查询正常。
- Docker Chromium 通过 100 MiB 文件选择事件、上传进度、附件引用、Range 读取、真实任务和刷新历史。Windows 使用独立端口 18885 和专用目录，生产桥仍待更新。
- Web 16 项测试、TypeScript 检查和文件传输 2 项测试通过。验收脚本为 `web/test/large-file-acceptance.mjs`，报告位于 `web/test-results/large-files-docker.json` 和 `web/test-results/large-files-windows.json`。

## 桌面会话命名补充验收

2026-11-09 确认生产旧桥会拒绝 `thread/name/set`。新版桌面桥对普通标准 RPC 透传，状态声明 `methods: "*"`，继续保护已初始化的桌面连接和反向请求关联。

独立 Windows 测试使用 18885、Web 31022 和自建目录，验证 Web 创建命名会话、中文改名、app-server 原生读取相同名称、重新查询列表后名称保留，并验证透传标准只读 `config/read`。测试线程和目录已清理，报告为 `web/test-results/windows-thread-names.json`。Web 17 项测试与 TypeScript 检查通过，新增用例覆盖旧桥创建未命名会话、命名失败后保留已创建线程，以及改名前校验名称。

## 统一透传补充验收

Docker 与独立 Windows（从新版打包目录加载桥接模块）均通过 135 次连续查询、150 条并发查询、4 MiB 文件经标准 `fs/writeFile` 与 `fs/readFile` 往返，以及 129 MiB 中文名文件分块上传下载、SHA-256、续传与 Range 校验。两端分别验证两个 Web 账号共享会话、中文改名、不同会话并发执行、同一会话防重复、追加和停止任务。Docker 和 Windows 验收均使用临时端口；测试实例已停止，生产桌面未替换。Web 17 项测试、桥协议 4 项测试、文件传输 2 项测试、TypeScript 检查与前端构建通过。

更新包已构建到 `E:/git/github/CodexSeesionManager/build/mqtt-standard-0.3.46/`。隔离验收实际加载该包的 `lib/app/services/app_server_mqtt_service.pyc`，相同命名场景通过。打包环境补齐了项目已声明的 tzdata 依赖。生产管理器仍运行旧程序，需在空闲时更新完整程序目录并保留配置、账号和运行数据，重新附加 MQTT 服务后才能使用改名。本机 Web 已重启至最新代码，监听 3000。

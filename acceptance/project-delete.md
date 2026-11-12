# Web 项目删除验收

日期：2026-11-12。

## 行为

侧栏“删除项目”确认后，永久删除该 cwd 下全部会话，包括已归档会话、已加载的空会话及派生子会话。目录和文件保留；单个会话仍可归档。操作影响所有登录用户，历史不可恢复。

后端完整读取分页数据，检查每个会话的运行状态、临时会话和跨项目派生关系后再删除；删除与创建使用项目锁，会话状态操作使用原有会话锁。删除期间拒绝该项目的新写请求。中途失败显示已确认成功的数量，可重试，批量删除不提供事务回滚。其他客户端直接操作 app-server 不受 Web 的进程内锁约束。

## 隔离环境

- 从根目录及 Web Compose 生成独立项目 `codex-project-delete-acceptance`，MQTT 18886、Web 31026；使用独立 home、workspace、Broker 数据和 Web 登录数据。
- 使用本机已有镜像，Codex 为 0.167.0。镜像内旧桥缺少当前发现协议字段，验收实例只读挂载仓库当前桥源码，未替换正式服务。
- 浏览器直接使用镜像预装的 Playwright 1.65.0 与 Chromium headless shell，没有安装浏览器。
- 随机生成并记录验收目录、会话和账号；脚本仅清理自己创建的目录和会话，保留测试账号与报告。正式桌面、现有项目及用户数据未操作。

## 通过项

- `npm test`：38 项通过，其中项目删除新增 9 项，覆盖完整分页、归档与空会话、运行状态及预约状态、能力缺失、非法标识、派生会话、部分失败重试、执行端切换、并发写入拦截和 Windows 路径大小写。
- `npm run typecheck` 通过，`npm run build` 通过；构建仍有既有的较大分块提示。
- 真实 app-server：双账号共享线程、名称和历史，附件输入与真实模型任务、并发执行及停止任务通过；运行中删除项目返回 409，停止后删除普通与归档会话成功，另一账号列表无该分组，目录和中文文件内容保留，未登录删除返回 401。
- 浏览器：确认文案、取消无修改、一键删除、双账号即时同步、刷新不恢复、其他项目与文件保留、390px 手机侧栏均通过，无前端运行错误。确认弹窗截图已回看。
- 修改文件回读，通过严格 UTF-8 解码，无 BOM、无替换字符；根目录双语文档入口保留。运行配置、报告、截图和依赖由 Git 忽略。

## 原生接口核实与边界

Codex 0.167.0 导出的实验协议包含 `project/create`、`project/delete` 等原生项目接口。隔离实测：`project/delete` 可以删除非空项目，关联会话保留，读取会话的 `projectId` 变为 null。此前“app-server 没有项目删除接口”的判断不准确。

当前 Web 使用按 cwd 推导的目录分组，没有接入原生项目 ID。本次功能按现有数据模型调用 `thread/delete` 删除该分组的会话，没有迁移原生项目模型。原生接口与 Windows 正式桌面的生产部署不在本次变更范围；Windows 路径兼容通过接口回归测试，未在正式 Windows 桌面执行删除。

报告位于忽略 Git 的 `web/test-results/project-delete-acceptance.json`、`project-delete-ui.json` 和 `native-project-delete.json`，截图为 `project-delete-confirm.png` 与 `project-delete-mobile.png`。隔离 Compose 配置位于 `acceptance/.runtime/project-delete/compose.json`。本轮隔离服务验收后停止，未重启或更新正式 Web。

# 架构与功能边界

```text
Desktop UI ── Tauri commands/channels ──┐
                                      ├── exm-code-runtime ── exm-code-core
Web / Mobile UI ── HTTP/SSE ── server ──┘         │                  │
                                              SQLite          Workspace / Model
```

## 共享职责

`exm-code-core` 只处理工作流提示、受限模型工具循环和项目文件安全。`exm-code-runtime` 统一处理项目、模型配置、持久会话、人工审批、任务并发与取消。HTTP 和 Tauri 都不再各自实现业务逻辑。

每个项目拥有自己的 `.exm-code/sessions.sqlite3`。数据库兼容旧版结构，增量添加 `sessions.pinned`、`sessions.archived` 和 `messages.status`。归档不删除对话；删除会话会级联删除消息和其中的待审阅提案，不修改已应用的文件。

## 任务生命周期

1. 校验输入、模型设置、会话与工作流。
2. 按请求 ID 注册任务：同一会话只能运行一项任务，同一 Runtime 最多四项。
3. 保存用户消息；模型每轮与每次工具调用发送元数据进度。
4. 成功时先持久化最终回复和提案，再通知客户端完成。
5. 明确取消、超时和模型失败会释放任务占用。明确取消/失败状态随消息持久化，不作为助手历史注入后续模型上下文。

SSE 通过带 Authorization 的 POST Fetch 读取，不把令牌放在 URL。断流不等于成功，客户端必须收到 `done` 才接受完整结果。服务端发现 SSE 订阅断开时取消该请求。Tauri 使用专属 Channel 发送同一种进度对象。

进度事件是 `modelRequest`、`toolStarted`、`toolFinished`，不包含文件内容和密钥。当前不实现供应商逐 token 输出，也不承诺服务器崩溃后自动续跑任务；重启后已保存的消息和审批仍存在。

## 文件变更

模型只能 `propose_change`；编辑器也只生成 `pending` 提案。提案 ID 由 Runtime 生成。应用时只接受数据库中的待处理 ID，并核对文件是否仍等于审阅基线。新建文件不能覆盖已存在文件。改动使用临时文件持久化，原有权限尽量保留。

手动编辑只允许活跃的 Code 会话，归档、Plan、Spec、Goal 会话均不能借编辑器绕过只读约束。文件编辑对话框本身不写入磁盘。

## API 摘要

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 进程健康，不返回项目或密钥 |
| GET/PUT | `/api/settings` | 读取非敏感配置 / 保存或清除模型密钥 |
| GET | `/api/workspace` | 服务端固定工作区 |
| GET | `/api/files`、`/api/file` | 列目录 / 读取项目文本文件 |
| GET | `/api/files/search?query=...` | 递归文件名搜索 |
| GET | `/api/files/content-search?query=...` | 有数量与扫描预算的内容搜索 |
| GET/POST | `/api/sessions` | 列出 / 新建会话 |
| PUT/DELETE | `/api/sessions/:id` | 更新标题、模式、置顶、归档 / 删除会话 |
| GET | `/api/sessions/:id/messages`、`/export` | 消息 / JSON 包装的 Markdown 导出 |
| POST | `/api/chat/stream` | 带进度的任务请求，SSE 返回 `progress` / `done` / `error` |
| POST | `/api/chat` | 非流式兼容接口 |
| GET | `/api/tasks` | 当前 Runtime 的运行中任务 |
| POST | `/api/tasks/:requestId/cancel` | 取消任务（包括短窗口内提前到达的取消） |
| POST | `/api/proposals/manual` | 将编辑器草稿保存为审阅提案 |
| POST | `/api/files/apply`、`/api/proposals/dismiss` | 按 proposalId 应用 / 忽略 |

## 未开放的能力

- Shell 执行、自动运行测试、Git 写操作、MCP、多用户隔离。
- 跨进程同时修改同一个项目的协调；不要让桌面和服务器同时管理同一项目数据库。
- 提案文件变更与数据库状态之间的跨介质事务。异常断电后请检查项目实际内容，冲突检查会阻止盲目重复覆盖。
- 崩溃任务自动恢复、供应商逐 token 流、API Key 的系统钥匙串加密。
- 未经 Android/iOS SDK 与真机验证的原生安装包，不标为已交付。

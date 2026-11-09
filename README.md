# dsh-acp-remote

把 dsh 的 ACP 形态（`dsh --profile acp`，stdio 上的 NDJSON JSON-RPC）通过 **WebSocket** 暴露给远程客户端（如 nexus-agent 服务器经 IP 接入）。

dsh 官方 ACP 仅支持 stdio；本插件做 WS→子进程字节级桥接，不解析、不改动任何 ACP JSON-RPC 消息（免疫 dsh alpha 版 breaking changes）。dsh ACP 实现的全部方法（`session/new` / `session/prompt` / `session/update` / `session/list` / `session/resume` / `session/close` / `session/set_config_option` / 反向请求 `session/request_permission` 等）均透明通过。按 ACP 规范的「自定义传输」条款运作：保持 JSON-RPC 消息格式与生命周期不变。

## 工作方式

- 插件加载时在本机起一个 WebSocket 网关（默认 `0.0.0.0:9420`）
- 每个通过认证的 WS 连接 spawn 一个独立的 `dsh --profile acp` 子进程并双向桥接：
  - 客户端 WS text 帧 → 子进程 stdin（行缓冲重组，任意分帧安全；背压时待 child drain 后续写，不丢数据）
  - 子进程 stdout 行 → WS text 帧（每行一个 text 帧，带尾随 `\n`）
  - 任一侧断开即回收子进程（SIGTERM，2s 宽限后 SIGKILL）
- 多客户端并行：一连接一子进程，会话互不影响
- 心跳保活：周期性 ping，连续 2 个周期无 pong 判定半开连接并终止（连带回收子进程）

### 帧格式契约（客户端实现注意）

- 传输内容为 NDJSON：每个 WS **text** 帧payload可以是任意字节段，插件按 `\n` 重组完整行后转发；**binary 帧会被忽略**（记 warn 日志）
- 服务端每条 stdout 行作为一个独立 text 帧返回（帧内容 = 一行 JSON + `\n`）
- 单行长度上限继承 `ws` 默认 maxPayload（100 MiB）；超大图片 prompt 超限会被断连

## 配置（dsh Settings UI 可调，全部 volatile）

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；**关闭即停止服务**（HMR 卸载，杀掉全部桥接子进程），重新打开或改端口即**重启** |
| `port` | `9420` | 监听端口 |
| `host` | `0.0.0.0` | 绑定地址（不可信网络请收紧或加反代/TLS） |
| `token` | 空 | 认证令牌；客户端连接 URL 带 `?token=xxx` 或请求头 `Authorization: Bearer xxx`（推荐，避免被代理日志记录 query）；错误拒绝（close 4001）；空 = 不认证（仅限可信内网）；比较为常量时间 |
| `command` | `dsh` | 子进程命令；**必须在宿主进程 PATH 可解析，否则用绝对路径**（见下方常见坑） |
| `args` | `["--profile","acp"]` | 子进程参数 |
| `maxConnections` | `0` | 并发连接数上限；超限新连接 close 1013 且不 spawn 子进程；`0` = 不限制 |
| `heartbeatMs` | `30000` | 心跳 ping 间隔毫秒；连续 2 个周期无 pong 终止连接并回收子进程；`0` = 关闭心跳 |

### 常见坑：Desktop 宿主里 `dsh` 不在 PATH

DSH Desktop（Electron 宿主）内启动的插件，其 PATH 通常是 GUI 进程的环境，**不含**用户 shell 的 PATH，默认 `command: dsh` 可能 spawn 失败（连接立即以 1011 关闭，日志出现 `ENOENT`）。解决：把 `command` 改成绝对路径，例如 `/opt/homebrew/bin/dsh` 或 `which dsh` 的输出。

## 安装

```bash
# 在 dsh 侧（任选其一）：
# 1) plugin_manager 安装（link 本目录）
#    dsh 插件市场/管理器：install_bundle target=/绝对路径/dsh-acp-remote
# 2) 或手动挂载
dsh --profile <name> --patch /绝对路径/dsh-acp-remote/cordis.patch.yml
```

安装前在本目录执行 `pnpm install`（依赖 `ws`）。

## nexus 侧接入

nexus「AI 配置 → ACP 连接」新建端点：模式选**远程接入**，服务地址填 `ws://<dsh服务器IP>:9420`，认证令牌填插件配置的 `token`，设为默认端点后 engine=DSH 的智能体即经远程 ACP 执行。

## 与官方远程传输（RFD）的关系

ACP 官方正在制定标准远程传输（Streamable HTTP + WebSocket，`Acp-Connection-Id` 双头模型），目前仍为 RFD 草案、未并入 v1 规范。本插件不实现该草案（其一连接一子进程的模型与 nexus-agent 现有接入方式兼容优先）；若未来草案落定，可另行对齐。

## 安全提示

- WS 为明文；跨不可信网络请置于 TLS 反代之后（wss:// 由反代终止）
- 生产建议：`host` 绑定内网网卡 + 非空 token（优先 Bearer 头）+ `maxConnections` 上限 + 防火墙白名单

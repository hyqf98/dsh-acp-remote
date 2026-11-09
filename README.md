# dsh-acp-remote

把 dsh 的 ACP 形态（`dsh --profile acp`，stdio 上的 NDJSON JSON-RPC）通过 **WebSocket** 暴露给远程客户端（如 nexus-agent 服务器经 IP 接入）。

dsh 官方 ACP 仅支持 stdio；本插件做 WS→子进程桥接，不依赖 dsh 内部 API（免疫 alpha 版 breaking changes）。

## 工作方式

- 插件加载时在本机起一个 WebSocket 网关（默认 `0.0.0.0:9420`）
- 每个通过认证的 WS 连接 spawn 一个独立的 `dsh --profile acp` 子进程并双向桥接：
  - 客户端 WS text 帧（NDJSON 行）→ 子进程 stdin
  - 子进程 stdout 行 → WS text 帧
  - 任一侧断开即回收子进程（SIGTERM，2s 宽限后 SIGKILL）
- 多客户端并行：一连接一子进程，会话互不影响

## 配置（dsh Settings UI 可调，全部 volatile）

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；**关闭即停止服务**（HMR 卸载，杀掉全部桥接子进程），重新打开或改端口即**重启** |
| `port` | `9420` | 监听端口 |
| `host` | `0.0.0.0` | 绑定地址（不可信网络请收紧或加反代/TLS） |
| `token` | 空 | 认证令牌；客户端连接 URL 带 `?token=xxx`，错误拒绝（close 4001）；空 = 不认证（仅限可信内网） |
| `command` | `dsh` | 子进程命令 |
| `args` | `["--profile","acp"]` | 子进程参数 |

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

## 安全提示

- WS 为明文；跨不可信网络请置于 TLS 反代之后（wss:// 由反代终止）
- 生产建议：`host` 绑定内网网卡 + 非空 token + 防火墙白名单

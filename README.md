# dsh-oks

> DeepSeek Harness 插件：在 DSH Web UI 中连接本地 Open Knowledge Studio（OKS）知识库，提供召回、知识库浏览与可视化设置。

[Open Knowledge Studio (OKS)](https://github.com/open-agent-power/open-knowledge-studio) 是文件式知识库：原始材料保留在 `raw/`，审核后的可复用知识位于 `wiki/`，Agent 通过 `oks recall` 召回相关内容。`dsh-oks` 不复制或托管知识数据；它调用本机 `oks` CLI，并读取你已经配置的本地 OKS 目录。

## 功能

- 在每轮 Agent 对话开始前按配置进行 OKS 召回；可在面板中关闭自动召回。
- 提供 `oks_recall`、`oks_status`、`oks_wiki_use`、`oks_metrics`、`oks_inject_stats`、`oks_inject_feedback` 六个工具。
- 在 DSH Web 设置中提供中文 OKS 卡片，并将设置写回 OKS 配置。
- 浏览本地知识库中的 **Wiki、待审核 Draft 和 Raw Bundle**；支持筛选、搜索、详情查看与刷新。
- 对未安装 OKS、未配置知识库、目录结构不完整等情况提供明确诊断，不会静默创建或迁移你的知识库。

## 安装

### 前置条件

先安装并初始化 OKS。以下示例路径仅为占位符，请替换为自己的知识库目录：

```bash
pipx install open-knowledge-studio
oks init <knowledge-base-path>
oks config set knowledge_base_path <knowledge-base-path>
```

### 安装插件

兼容基线为 DSH `0.1.0-rc.8` 和 Node.js `22+`。OKS 核心功能不依赖
`dsh-better-sidebar`；安装它后才会额外出现可停靠的 OKS 侧边栏、Wiki 浏览器和
Raw 浏览器入口。缺少该插件时，设置页、知识库查询和 AI 工具仍应正常加载。

建议在生产环境显式固定 `dsh-better-sidebar` 的版本（rc.8 建议从 `0.14.0` 起，
当前部署可固定到经过验收的 `0.15.2`），不要直接跟随 `main`。

生产部署请固定 tag 或 commit，避免重新安装时获取到不同代码：

```bash
dsh plugin --profile web add github:open-agent-power/dsh-oks#<commit-or-tag>
```

开发分支才使用不带 pin 的地址。发布包只包含 host 与 browser 编译产物；
如果从源码 checkout 安装或升级，先执行 `pnpm run build`。安装或升级后重启
DSH Web，让它重新扫描插件的 browser bundle。

启动 DSH Web 后，打开 **系统设置 → OKS**。面板会检查：

- `oks` CLI 是否可用；
- `knowledge_base_path` 是否已配置；
- 目标目录是否含有 `wiki/`、`drafts/` 和 `raw/`。

## Web 面板与数据边界

DSH 只负责设置、工具和浏览器 UI；知识库发现、搜索、路径校验和内容读取均由
`oks fs ... --format json` 提供，插件不会把 CLI 或知识库搜索实现搬进 DSH。
面板显示的数量和内容直接来自已配置的本地 OKS 文件：

| 区域 | 读取内容 |
| --- | --- |
| Wiki | 已审核、可被长期召回的知识 |
| Draft | AI 生成、等待人工审核的候选知识 |
| Raw | 原始证据 Bundle，不等于知识条目 |

面板提供手动刷新，并在打开期间低频刷新。刷新不会上传、复制或改写知识条目；设置写回只影响 OKS 配置文件。

## 工具

| 工具 | 用途 |
| --- | --- |
| `oks_recall` | 召回与当前问题相关的 Wiki 知识 |
| `oks_status` | 查看知识库状态 |
| `oks_wiki_use` | 记录某个 Wiki 知识被实际使用 |
| `oks_metrics` | 查看 OKS 指标 |
| `oks_inject_stats` | 查看注入质量统计 |
| `oks_inject_feedback` | 提交注入质量反馈 |

## 验证建议

不要只以首页 HTTP 200 判断插件可用。至少确认：

1. DSH Settings API 能发现 `oks` 命名空间；
2. 系统设置中的 OKS 卡片可见并能显示字段；
3. `oks_status` 与 `oks_recall` 能获得非异常结果；
4. 修改设置后，OKS 配置写回并在刷新后仍然生效；
5. Wiki、Draft 和 Raw 页面展示的是当前本地知识库数据。

仓库 CI 的阻塞基线固定在 DSH `0.1.0-rc.8`，使用 `pnpm-lock.yaml` 保证复现；这
不是生产运行时的永久 pin。运行时 peer 仍保留兼容范围，另有手动/每周执行的
latest DSH 冒烟轨道，用于发现上游变化而不让上游更新破坏基线构建；latest 轨道
是 advisory，不作为 PR 合并阻塞门禁。rc.8 的真实插件安装冒烟在 Node 22 和 24
均执行，Node 22/24 的基础测试、构建和入口检查也都执行。

## 开发与发布边界

仓库仅保留可移植的 `cordis.patch.yml`。本机开发补丁、验收日志、个人知识库、案例运行记录与机器相关配置均不应提交或发布。

## License

MIT

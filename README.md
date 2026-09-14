# dsh-ai-employee

> 给每个项目配一个 AI 团队

**dsh-ai-employee** 是运行在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 上的插件：给每个项目配一支长期协作的 AI 员工团队。总顾问、程序员、审核员、情报员等不同职责的 AI 员工，在同一项目工作区里通过**任务交接、用户审批、结构化交接单（Handoff）**协同完成复杂工作，由用户自定义工作流、由总顾问负责调度并把复杂过程转化成用户可以判断的结果。

它不是单纯的多 Agent 聊天界面，而是一个**项目级的 AI 协作系统**。

---

## 目录

- [设计文档（V0.3）](#设计文档v03)
- [核心特性](#核心特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [8 阶段开发路线图](#8-阶段开发路线图)
- [目录结构](#目录结构)
- [许可证](#许可证)

---

## 设计文档（V0.3）

| 文档 | 版本 | 说明 |
|---|---|---|
| [产品设计文档](docs/AI员工插件_01_产品设计文档_V0.3.md) | V0.3 | 用户视角，决定产品长什么样 |
| [技术架构设计](docs/AI员工插件_02_技术架构设计_V0.2.md) | V0.2 | 实现视角，决定代码怎么写 |
| [产品技术对齐说明](docs/AI员工插件_03_产品技术对齐说明_V0.1.md) | V0.1 | 产品与技术是否对齐的核对 |

---

## 核心特性

- **项目优先、独立 AI 团队**：每个项目一个工作区，项目里的员工、任务、记忆、群聊都只属于该项目，项目之间默认零共享。
- **四种内置员工样板**：总顾问、程序员、审核员、情报员；名字、职责、边界都可改，也可以从零自建。
- **任务交接闭环**：每个任务有独立上下文（Session），干完生成结构化 Handoff 交给下一棒，审核不通过自动返工。
- **用户自定义工作流**：哪个员工干完交给谁，你说了算——可以对总顾问说大白话，也可以在界面上配置。
- **总顾问调度**：Room 里 `@员工` 定向路由，没 `@` 默认总顾问接管，把技术问题翻译成人话向你汇报。
- **用户拥有最终权限**：删除员工、删除项目**只有你能做**，任何 AI 员工都无权删除。
- **项目三态**：活跃 / 归档 / 删除（软删除 30 天内可从回收站恢复）。
- **异常主动通知**：Bot 崩溃、会话卡死、审核反复失败等，系统主动通知你，分紧急 / 重要 / 普通三级。
- **项目记忆可读可改**：记忆统一放在 `<项目文件夹>/docs/`，Markdown 格式，你用任意编辑器都能直接查看、编辑。

---

## 技术栈

- 语言：TypeScript（strict，ESM）
- 框架：DeepSeek Harness 插件系统（Cordis）
- 持久化：Harness 自带 storage（迁移 SQLite 留作未来路径）
- 执行引擎：Harness 原生 Agent（统一 Provider 接口，多 Provider 可插拔）
- 包管理：pnpm
- 运行环境：Node.js ^22.19 || >=24

---

## 快速开始

> 当前处于开发早期（Phase 0~1），以下为预期使用方式，正式可用后补充完整。

```bash
# 克隆仓库
git clone https://github.com/yhdhappy/dsh-ai-employee.git
cd dsh-ai-employee

# 安装依赖
pnpm install

# 构建
pnpm build
```

---

## 8 阶段开发路线图

| 阶段 | 内容 |
|---|---|
| **Phase 0** | Harness 可行性验证 + 接入首个外部 Provider（PI Agent） |
| **Phase 1** | Onboarding + Workspace + Bot + 4 个内置样板 + GitHub Actions CI |
| **Phase 2** | Workflow + Task + Session + Bot 写入 `docs/` 项目记忆 |
| **Phase 3** | Handoff + Review（交接审核闭环） |
| **Phase 4** | Room + 总顾问调度（`@` 路由 + 任务卡片） |
| **Phase 5** | Notification + 异常处理（主动通知用户） |
| **Phase 6** | 多 Provider（增加 Claude Code / Codex / OpenCode） |
| **Phase 7** | Remote Runtime（关机后继续运行） |
| **Phase 8** | 归档 / 删除 / 恢复 |

---

## 目录结构

```text
dsh-ai-employee/
├── docs/                       # 仓库设计文档（V0.3 / V0.2 / V0.1）
├── src/
│   ├── core/                   # 核心服务（调度、状态等）
│   ├── workspace/              # 项目工作区
│   ├── bots/                   # AI 员工（Bot）
│   ├── onboarding/             # 首次使用引导
│   ├── templates/              # 4 个内置样板
│   ├── workflows/              # 用户自定义工作流（Phase 2）
│   ├── providers/              # Provider 统一接口 + 各 Provider 适配器
│   │   ├── pi/                 # PI Agent（首个）
│   │   ├── claude-code/        # 预留
│   │   └── codex/              # 预留
│   ├── rooms/                  # 项目群聊（Phase 4）
│   ├── sessions/               # 独立执行上下文
│   ├── handoffs/               # 任务交接
│   ├── review/                 # 审核
│   ├── context/                # Context Package
│   ├── permissions/            # 权限墙
│   ├── storage/                # Harness storage 域
│   └── ui/                     # 界面扩展
├── scripts/                    # 脚本（含 AI 审 PR）
├── .github/workflows/          # GitHub Actions CI / AI 审 PR
└── package.json
```

> 目录结构按开发阶段逐步填充，未实现的部分会在对应 Phase 补齐。

---

## 许可证

[MIT](LICENSE) © 2026 yhdhappy
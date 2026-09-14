# Phase 0 探查报告

**项目：** dsh-ai-employee（AI 员工插件）
**阶段：** Phase 0 — Harness 可行性验证
**状态：** 探查完成，结论已与用户确认
**日期：** 2026-09-14

---

## 一句话总览

**主闭环（建项目 → 建员工 → 派任务 → 后台自动执行 → 干完写交接 → 交接流转 → 审核 → 汇报）在 DeepSeek Harness 上技术上能成立。** 所有底层机制均已逐环实证，核心结论是：用 Harness 原生 Agent 引擎作为统一执行后端 + Harness 自带 storage 做持久化，配合 `subagents.registerProvider` 统一 Provider 接口，即可支撑整个产品。

---

## 一、Harness 插件能力清单

> 均为实测（探针/命令行），不是推测。真实模型调用通过了 headless 一次性任务实证。

| 能力 | 状态 | 实测证据 / 说明 |
|---|---|---|
| 插件入口 API | ✅ 可用 | `cordis_define` / `cordis_run` 能定义加载 Host 插件；`dsh plugin add` 装正式插件到 profile |
| 界面扩展（UI Slot） | ✅ 可用 | 侧边栏按钮、页面主页（main 面板）、右侧 tab（任务状态）、shell 浮层（通知）、对话卡片都有扩展落点 |
| 员工会话（Session / 子代理） | ✅ 可用 | `subagents` 内置 `spawn`、`fork` 两个 provider；`registerProvider` 可注册自定义 Provider；支持注入 `persona`（角色）+ `outputSchema`（结构化输出）+ `agentOptions`（选模型） |
| 工具注册（Tool） | ✅ 可用 | `tools.register` / `harness.defineTool` 可给员工/总顾问注册内部工具 |
| 事件总线（Event） | ✅ 可用 | `agent/created`、`turn/end`、`agent/error`、`session/event` 等，可感知执行生命周期，支撑状态流转与通知 |
| 文件系统（fs） | ⚠️ 部分 | 能读写文件、能判定路径是否在本项目内（隔离判定实测正确）；**不能自动建目录**（靠 shell mkdir 兜底） |
| Shell / 子进程 | ✅ 可用 | 可执行 `mkdir` 等系统命令 |
| 持久化（storage） | ✅ 可用 | 域写入→关闭→重开→读回数据完整，磁盘 `<域>.json` 真实存在 |
| 真实模型 | ✅ 可用 | headless 实证：默认模型 `deepseek-v4-flash-0731`（provider `qwen-token-plan-cn`）能跑真实任务，无需手动配 key |

---

## 二、"无人值守自动跑"机制验证结论

**成立。**

- 探针实证：派活 → 后台异步执行 → 干完写回结果 → 读回"已完成"的闭环能跑通（storage + timer 模拟）。
- 补验：默认模型真实可跑（headless 一次性真实调模型成功输出）。
- 结论：**程序员收到任务 → 独立上下文自动处理 → 干完写交接 → 触发下一棒**，机制上完全可行，全程无需人工盯着。

---

## 三、Provider Adapter 设计（与 PI 接入方式澄清）

| 项 | 结论 |
|---|---|
| 统一 Provider 接口 | ✅ 可设计。`subagents.registerProvider({ name, capabilities, start(request) })` 正是现成统一接口。每个"员工执行 Provider"是一个注册项，可带 `persona`、`outputSchema`、`agentOptions` |
| `providers/pi/` 落点 | ✅ 作为 `name: 'pi'` 的 Provider 注册项，源码放 `src/providers/pi/` |
| "字面接 pi CLI" | ⚠️ 当前跑不了真模型。本机已装 `pi` v0.85.1，但其所有外部 provider（anthropic/openai/google 等）均 `not_ready`——需 pi 自己的模型凭据，当前未配 |
| **实际接入方式（已定）** | ✅ 统一接口下的 `pi` Provider，**执行引擎委托 Harness 原生 Agent**（用已配好的 `deepseek-v4-flash-0731`）。`pi` 作为这个"统一执行入口"的命名，满足 `providers/pi/` 真实实现 + 统一接口；其他 Provider 占位，Phase 6 再实现 |

**重要实现环境坑：** cordis 动态沙箱（`cordis_define`）不提供 `AbortController`/`AbortSignal`，承载不了真实模型调用；但 DSH 自身即使用 `new AbortController`，证明正式 Node ESM 环境完全支持。**结论：真实执行的插件必须走正式 ESM 编译（方式 A），不是 cordis 动态沙箱。** 与已定的"正式插件包"方案一致。

---

## 四、持久化方案（Harness storage）

**用 Harness 自带 storage，不搭 SQLite——已实证可行。**

- 运行时已挂载 `json` 存储后端。
- 探针实证：storage 域写入→close→重开→读回数据完整，磁盘 `<域>.json` 存在。
- 每个实体一张表，重启不丢；后期迁移 SQLite 只需换后端、业务代码不动。
- 注意：域名用合法小写格式（如 `ai_employee_v1`）；表 schema 提供 `.parse()` 契约对象（插件纯 JS 不能 import 真 zod，实测普通对象即可）。

---

## 五、最小演示主闭环结论

**成立。** 所有机制件逐环实证：

1. 建项目（shell 建目录 + storage 落记录）✅
2. 建员工（storage 持久化，三种样板可建）✅
3. 派任务 → 独立后台执行（子代理 + 默认模型真实可跑）✅
4. 干完写交接、状态流转（storage + 事件）✅
5. 审核、汇报、通知（事件 + UI Slot 有落点）✅

唯一"编程式跑通整条链"的正式验证落在 Phase 1 第一步（用正式 ESM 插件建员工、派真任务、拿回结构化结果）——但底层机制已全部就绪。

---

## 六、风险点与对策

| 风险 | 严重度 | 对策 |
|---|---|---|
| `pi` CLI 无独立模型凭据 | 中 | 执行走 Harness 原生 Agent（已配好模型）；`pi` Provider 的 `start()` 委托 Harness 引擎。真要 pi 独立跑需另配 pi 模型 key（由用户决定） |
| cordis 沙箱缺 AbortController | 低 | 正式插件走 ESM 编译（Node 环境有），不用 cordis 动态沙箱承载执行 |
| fs 不能自动建目录 | 低 | Phase 1 用 shell `mkdir` 建项目 `docs/`（已实证可用） |
| storage 域 schema 写法 | 低 | 用 `.parse()` 契约对象，不 import zod（已实证） |
| headless profile 有 AI_Company 早期 spike 残留 | 低 | 不影响本产品；如需后续清理 |

---

## 七、文档对齐建议（实施状态记录）

> 仓库 `docs/` 下的三份设计文档为初始原版拷贝，**本报告不改动它们**。以下对齐说明由用户在原版（KnowledgeBase）实施。

| 文档 / 章节 | 建议 | 状态 |
|---|---|---|
| V0.2 第 4 节（Provider 列表） | 补"PI 实际是委托 Harness 引擎执行"的澄清 | ✅ 用户已在原版实施；仓库副本保持原版 |
| V0.2 第 21 节（持久化） | 补"当前实现用 Harness 自带 storage，SQLite 留作未来迁移路径" | ✅ 用户已在原版实施；仓库副本保持原版 |
| V0.2 第 20 节（重启恢复） | 保持原状（Agent 已确认文档原意正确） | ✅ 不改 |

---

## 八、探查纪律

本阶段严格遵循：
- **先研究官方实现，再动手**（读 DSH 源码 / README / Inspect 运行时，而非猜测）。
- **不改 Harness 核心**，只走官方扩展点（subagent / storage / tool / event / slot）。
- **事件驱动**：状态流转用事件 + 持久化投影，不以聊天文本当状态。
- **状态持久化**：关键状态落 Harness storage，不只在内存。

---

*本文件为 Phase 0 探查记录，后续 Phase 完成后可在此基础上续写各阶段报告。*
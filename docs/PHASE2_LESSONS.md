# Phase 2 实战教训（Lessons Learned）

**项目：** dsh-ai-employee（AI 员工插件）
**阶段：** Phase 2 — 数据层 / 执行引擎 / 装配 Tool / UI 集成 / 收尾
**日期：** 2026-09-15
**状态：** Phase 2 已完整收尾（任务闭环 + UI 可用 + 测试遗留已清理）

---

## 一句话总览

Phase 2 的坑几乎**全都不在业务逻辑里，而在"插件代码是怎么被装进宿主、又是怎么被加载的"**：
依赖挂载时序、模块加载时机、子会话环境继承、注册路径分支。
业务代码一次写对，环境假设错了三次。

按发生顺序记 5 个坑。**第 5 个（build 与启动的竞态）是最贵的那个，单独展开。**

---

## 坑 1：Tool 名不能有点号

**现象**
按设计文档写的 `workspace.write_memory` 注册不上；模型侧根本看不到这几个工具。文档里整份"总顾问工具清单"都是 `a.b` 形式，全都不能用。

**根因**
模型侧 Tool 名有硬约束：必须匹配 `^[a-zA-Z0-9_-]+$`，**点号 `.` 非法**。
文档里的 `a.b` 只是**命名空间记法**（表达"哪个领域的哪个动作"），不是可直接注册的名字。这是个"文档 vs 落地"的语义鸿沟，不是实现 bug。

**修复**
- 落地名统一改下划线：`workspace.write_memory` → `workspace_write_memory`
  （`workspace_read_memory` / `workspace_list_memory` 同理）
- V0.2 §17 加"工具命名约束"说明块，整份清单由 `a.b` 改为 `a_b`
- 划清边界：**模型能看见的东西（Tool）用下划线；内部事件名（`task.created`）保持点号**——事件名没有这个约束，别一起改

**以后怎么防**
- 新增 Tool 前，先 grep 一遍名字是否满足 `^[a-zA-Z0-9_-]+$`
- 一句话规范：Tool 名 = 下划线；事件名 / 存储 action = 点号可保留

---

## 坑 2：webServer 注入晚于 apply()

**现象**
插件面板能正常渲染，但**所有 API 调用 405/404**。终端日志只有一行 `webServer(sync)=未就绪`。
这是最误导人的一种故障形态：UI 活着，后端"看着像"活着，实际整条 API 通道没注册。

**根因**
两层叠加：

1. `webServer` 由 web-app bundle 提供，**挂载时机晚于本插件的 `apply()`**。在 `apply()` 里同步 `ctx.get('webServer')` 只会拿到 `undefined`，于是"注册路由"那整段被跳过。
2. 客户端半边（`lib/client.js`）来自 loader roster，**不依赖 webServer**，所以照样加载 → 面板照常渲染。

也就是说：软依赖拿不到 ≠ 报错，而是**静默少注册一块能力**。

**诱因**：为兼容 headless/acp/sdk，之前把 `webServer` 从 `inject`（硬依赖）降成了软依赖。软依赖的代价就是——**时序得自己管**。

**修复**
```ts
// 等依赖就绪再注册，不赌挂载顺序，也不阻塞没有 webServer 的组合
ctx.inject(['webServer'], (scoped) => {
  const webServer = scoped.get('webServer')
  if (webServer === undefined) return
  webServer.register({ kind: 'exact', path: API_PATH, handler: makeAiEmployeeHandler({
    getApi: () => api,          // 延迟取 api
    userId: 'user-1',
  }) })
})
```
- handler 用 `getApi()` **延迟取** api：还没装配好就回 **503**（客户端重试自愈），而不是抛错
- 加三条诊断日志，让"这次进程到底注册了什么"一眼可见：
  - `[ai-employee] apply() 启动（storageDomain=就绪, webServer(sync)=未就绪）`
  - `[ai-employee] HTTP 路由已注册：/ai-employee/api（apply 后 2373ms）`
  - `[ai-employee] 后端装配完成：N 个 Tool 已注册（dispatch=可用，apply 后 Nms）`

**以后怎么防**
- 软依赖（`ctx.get`）**必须配一个"就绪后再做"的钩子**（`ctx.inject`），不能只在同步阶段取一次
- 诊断日志按"阶段"打，不要只打错误：**静默少注册**这类 bug 只有正向日志能抓
- 回归测试：`scripts/verify-plugin-apply.mjs` 用假 ctx 复刻 cordis 的**作用域 inject 语义**（依赖未就绪不调用回调，就绪后才调用），锁住这个时序

---

## 坑 3：subagent 强制继承父 cwd

**现象**
派一个"写个 hello 函数"的任务，员工干完了，但**产出文件落在项目目录外面**——落在父会话的工作目录里。审核员去项目里找，什么都没有。

**根因**
子 session 的 cwd **继承父会话**，而 `subagents` 的 spawn 请求**无法指定工作目录**（没有 cwd 参数）。
于是子员工把"父会话的工作目录"理所当然地当成了"项目根目录"。
这不是子员工犯错——**是我们没告诉它项目在哪**。

**修复**
`buildTaskPrompt()`（`src/orchestrator/dispatch-internals.ts`）把 `workspace.rootPath` **显式写进 prompt**：

```text
## 项目位置（重要）
- 本项目根目录：`/Users/.../dev-team`
- 你的工作目录继承自主会话，**不是**项目根目录。
  所有代码/产出文件都必须写入上面这个项目根目录内（其子目录可以按需创建）。
```

**以后怎么防**
- 凡是"换个上下文执行"的机制（子 agent / 子进程 / 远程执行），**默认环境一律不可信，必须显式传环境**
- 抽成纯函数 `buildTaskPrompt(task, rootPath)`，由 `test/dispatch-prompt.test.mjs` 直接断言 prompt 里含项目根路径 —— 不用起真 subagent 也能回归
- 同一个 commit 还顺手修了状态机死锁：`planned → developing` 非法，改用 BFS 求最短合法迁移路径（`transitionPath`），并给 `changes_req` 补上 `ready` 出边

---

## 坑 4：路由里的变量遮蔽

**现象**
`listAuditEvents` 按 `action` 过滤时行为不对——过滤条件跟"分发动作名"串了。

**根因**
handler 顶部有一个**分发动作名**：`const action = body.action`（`'state'` / `'createBot'` / ...）。
在 `case 'listAuditEvents'` 块里又写了 `const action = body.actionFilter` —— **同名遮蔽**。
一个 `action` 在同一函数作用域里承担了两个语义（"走哪个分支" vs "过滤哪类事件"），必然出事。
`switch` 的 case 块尤其容易犯：每个 case 看起来像独立小函数，其实共享外层作用域。

**修复**
```ts
// 注意：不要用 `action` 命名这个过滤字段 —— 会遮蔽外层的 action（分发动作名）
const actionFilter = typeof body.actionFilter === 'string'
  ? body.actionFilter
  : (typeof body.auditAction === 'string' ? body.auditAction : undefined)
```
并在代码里**留下这条注释**（注释写清"为什么不能这么命名"，比写"这里做了什么"更值钱）。

**以后怎么防**
- 路由 handler 里，`action` 这个名字**只留给分发动作名**，其它一律加前缀：`actionFilter` / `resourceId` / `bodyXxx`
- case 块里的局部变量宁可长一点，也别复用一个"看起来正好"的短名

---

## 坑 5（重点）：build 与启动的竞态 —— route 是新代码、Tool 是旧代码

**现象**
改完代码，`pnpm build` 还在跑，另一个动作已经重启了 `dsh web`。验收时出现**自相矛盾的结果**：

- HTTP route 走了新逻辑（新 action 能通）→ 看起来"新代码生效了"
- 模型侧 Tool 不存在 / 是旧行为 → 又看起来"新代码没生效"

同一份代码，**两条路径两个版本**。当时第一反应是"Tool 注册代码写错了"，去翻注册分支——方向完全错了。真正的问题是这个进程**根本没加载完整的新代码**。

**根因（两层）**

1. **插件模块只在进程启动时加载一次。** `lib/index.js` 在 apply 时被 `import` 一次，此后进程内就是那份模块对象。`pnpm build` 是**就地覆写** `lib/*.js`：build 与启动并行时，启动中的进程读到的可能是**编译中间态**（部分文件已新、部分还是旧，`lib/index.js` 甚至可能被截断/半写）。
2. **route 与 Tool 是两条注册路径，对"代码版本"的可见性不同：**
   - route：`ctx.inject(['webServer'], cb)` → 等 webServer 就绪后注册（异步、晚）
   - Tool：装配 promise `.then()` 里注册（异步、更晚，且依赖 `subagents` 是否可用）

   两条路径在不同的时刻、从（可能）不同的模块版本取东西，于是 50/50 地"半新半旧"。**这不是超自然现象，只是没锁住顺序。**

**为什么这个坑特别贵**
- 它伪装成"某个功能没实现/写错了"，把人往**代码**方向带，而根因在**流程**（编译产物 vs 进程生命周期）
- 它让"验证通过"失去意义：你验的是这个进程加载的那份代码，不是仓库里那份
- 它不可复现地时好时坏（取决于 build 和 start 谁先跑完），最容易得出"再试一次就好了"的错误结论

**避免（硬顺序，不要跳步）**

```bash
# 1. 改代码
# 2. build —— 并等它明确结束（命令返回；必要时看 lib 产物 mtime）
pnpm build
# 3. 再启动/重启 GUI（单独一步，绝不与 build 并行）
dsh web --port 3080
# 4. 再验收
```

- **永远不要 build 跟启动同时进行**：不要"一个终端 build、另一个终端同时起服务"
- 想省心就串起来，用 `&&` 把顺序焊死：`pnpm build && dsh web --port 3080`
- **验收前先读终端那三行诊断日志**（apply 启动 / 路由注册 / 装配完成），确认这个进程加载的是新产物
- 心里记住一句话：**改了代码 ≠ 生效。只有"build 完成 + 进程重启"之后才生效。**

**同类根因的第二例：Tool 注册位置错（`else` 分支）**

`task_close` 曾经被写在
`if (created.dispatch !== undefined) { 派发 Tool } else { task_close }`
的 `else` 里，结果：

| 组合 | 有 task_list/task_dispatch | 有 task_close |
|---|---|---|
| headless（无 subagents） | ✗ | ✓ |
| **web（有 subagents）** | ✓ | **✗** |

**真实使用环境反而拿不到这个工具**——而这个 commit 本来就是为了解决"任务收不了尾"。

这和前面是**同一类 bug**：只看了一部分代码路径（分支/版本）就下结论，另一条路径上能力缺失。
修复：`task_close` 只依赖 `tasks + audit`，**移到分支之外无条件注册**。

**测试为什么没抓住（这条最重要）**
`verify-plugin-apply` 的 mock 里 `subagents` **恒为 `undefined`**，永远只走 `else` 分支，而且只断言 **Tool 的数量**：7 → 8，照样通过。
→ 补场景 3b：mock **提供** `subagents`，断言 Tool 总数**且名单里含 `task_close`**。

**教训：断言"有哪些"，不要只断言"有几个"。** 数量断言对"拿错了一批"完全免疫。

---

## 其他实战经验

**A. 路由能力是 web profile 专属，验收必须分两条路径**
`/ai-employee/api` 只在有 `webServer` 的组合（web profile）里存在；headless / acp / sdk 里它压根不注册（这是设计，不是 bug）。
所以验收要**分身份**做：
- HTTP route → 走 UI / 用户身份（含"只有用户能做的事"）
- 模型 Tool → 走 agent 身份（含越权检查：被派发的员工不能建项目/员工/工作流，也不能收尾任务）

**B. 持久化：加表不用升 version**
Harness `storageDomain` 开域时，**缺的表以空表启动**，不需要 migration；多余的表被忽略、不阻塞启动。
只有**改变既有表字段语义**才需要升 `version`。域名必须匹配 `^[a-z][a-z0-9_]*$`（否则 `invalid unit name`），表 schema 必须是带 `.parse()` 契约的校验器（插件是纯 JS 环境，不能 import 真 zod）。

**C. 存储是"整文件重写"——离线改文件会被运行中的进程覆盖**
`~/.dsh/storages/<域>.json` 每次写入都是整文件重写。GUI 在跑时，进程内存里还留着旧数据，它下一次任何写操作都会把离线改动**覆盖掉（"复活"）**。
所以：**任何直接的存储改动（清理 / 迁移 / 手工修数据）都必须先停进程**。
本次清理测试项目的脚本 `scripts/cleanup-test-projects.mjs` 就把这条写成了硬闸门：检测到 `dsh web` 在跑 → 拒绝执行（要强删得显式 `--force`）。

**D. "删除"是用户专属操作（V0.3 §24.3）**
「删除必须由用户自己操作，任何 Bot 都不能删除项目」，删员工同理（§7.4 死规矩）。
Agent 不能代劳 → 只能给**用户自己跑的脚本**（本次的 `cleanup-test-projects.mjs`），而不是给它加个 Tool。
顺带一个事实：Workspace schema 里**没有** `isWorkspaceTest` 字段（文档提过这个概念，没落库），所以清理脚本只能按可观测特征判定（根目录在系统临时目录下 = 高置信遗留），并**强制交互确认**。

**E. 沙箱 ≠ 正式运行环境**
cordis 动态沙箱不提供 `AbortController`/`AbortSignal`，扛不住真实模型调用。
真实执行的插件必须走**正式 ESM 编译 + 安装为 profile bundle**（Phase 0 结论，Phase 2 继续成立）。

---

## 收尾清单（每次改完代码的固定动作）

1. `pnpm typecheck`
2. `pnpm build` —— **等它结束**
3. `pnpm test` + `node scripts/verify-*.mjs`（全部脚本）
4. **单独一步**重启 `dsh web`（不与 build 并行）
5. 读终端三行诊断日志：apply 启动 / 路由注册 / 装配完成
6. 验收走**两条身份**：HTTP route（UI）+ 模型 Tool（agent），含越权用例

---

## 证据索引

| 坑 | 关键 commit | 代码 / 测试落点 |
|---|---|---|
| 1 Tool 名点号 | `1ba4074` | `docs/AI员工插件_02_技术架构设计_V0.2.md` §17 命名约束块 |
| 2 webServer 时序 | `6aa1ed8`（Phase 1 同源：`b1e779c`） | `src/index.ts` 的 `ctx.inject(['webServer'])`；`scripts/verify-plugin-apply.mjs` |
| 3 子会话 cwd | `4b9aaac` | `src/orchestrator/dispatch-internals.ts`；`test/dispatch-prompt.test.mjs` |
| 4 路由变量遮蔽 | `5fa7868` | `src/api/route.ts` 的 `actionFilter` 注释 |
| 5 build/启动竞态 | `59636da`、`fc7dec8` | `src/index.ts` 的 Tool 无条件注册；`scripts/verify-plugin-apply.mjs` 场景 3b |

**回归测试现状：** 7 个 `verify-*.mjs` 脚本 + `test/` 单元测试（`pnpm test`），合计 297 项。
其中 `verify-plugin-apply.mjs` 专门锁"装配时序"这类坑——**环境类 bug 必须用环境类测试锁住，业务单测锁不住。**

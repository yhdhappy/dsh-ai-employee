/**
 * dsh-ai-employee — 插件入口（cordis 适配层 + HTTP 路由 + 工具注册）。
 *
 * 阶段进度：
 *   Phase 1 第一段：cordis 适配层 + 后端装配（apply）。
 *   Phase 1 第二段：加 HTTP 路由（/ai-employee/api）。路由注册延后到装配完成后。
 *   Phase 2 第一段：加 3 个 memory Tool（workspace.write/read/list_memory），
 *                  与路由同样在装配完成后注册。
 *
 * 修复说明（沿用 Phase 1 第二段的修复）：
 *   路由与 Tool 都在 api 就绪后才注册。apply→装配之间没有路由也没有 Tool；
 *   此时浏览器还没加载插件，不会感知。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createAiEmployee } from './core/plugin.js'
import type { AiEmployeeApi } from './core/plugin.js'
import { makeAiEmployeeHandler } from './api/route.js'
import { createMemoryToolDefinitions } from './memory/memory-tools.js'
import { createDispatchToolDefinitions, createCloseToolDefinitions } from './orchestrator/dispatch-tools.js'
import { createSetupToolDefinitions } from './core/setup-tools.js'
import type { SubagentsLike } from './sessions/session-service.js'

/** 插件名，对应 cordis.patch.yml 里的 row `id`。 */
export const name = 'ai-employee-plugin'

/**
 * 硬依赖只有 storageDomain。
 *
 * webServer 是**软依赖**：只有 Web profile 才有它。headless / acp / sdk 等
 * 没有 webserver 的组合里，插件核心（项目记忆 Tool、派发 Tool）仍然应该可用，
 * 只是不注册 HTTP 路由。所以用 ctx.get('webServer') 而不是 inject。
 */
export const inject: readonly string[] = ['storageDomain']

/** HTTP API 路由路径。客户端 fetch 用同一个路径。 */
const API_PATH = '/ai-employee/api'

interface ExecResult {
  ok: boolean
  stdout?: string
  error?: string
}

function makeExecCommand(ctx: Context) {
  return async (command: string): Promise<ExecResult> => {
    const shell = ctx.get('shell')
    if (shell === undefined) return { ok: false, error: 'shell 服务不可用' }
    const spec = shell.resolve({ command })
    const res = await shell.run(spec)
    const error = res.exitCode === 0 ? undefined : res.stderr.text
    return {
      ok: res.exitCode === 0,
      stdout: res.stdout.text,
      ...(error !== undefined ? { error } : {}),
    }
  }
}

export function apply(ctx: Context): void {
  const applyStartedAt = Date.now()
  const storageDomain = ctx.get('storageDomain')
  console.log(
    `[ai-employee] apply() 启动（storageDomain=${storageDomain === undefined ? '缺失' : '就绪'}, ` +
    `webServer(sync)=${ctx.get('webServer') === undefined ? '未就绪' : '就绪'}）`,
  )
  if (storageDomain === undefined) {
    console.error('[ai-employee] storageDomain 缺失 → 插件不装配')
    return
  }

  let api: AiEmployeeApi | undefined
  let disposeTools: (() => void) | undefined
  let stopped = false

  // effect 卸载：插件停掉时释放 tool 和 api
  // （路由的销毁由它自己的作用域 effect 负责，见下面 ctx.inject）
  ctx.effect(() => () => {
    stopped = true
    if (disposeTools !== undefined) {
      try { disposeTools() } catch { /* ignore */ }
      disposeTools = undefined
    }
    if (api !== undefined) {
      void api.dispose()
      api = undefined
    }
  })

  // ---------------------------------------------------------------
  // HTTP 路由：用**作用域 inject** 等 webServer 就绪，而不是赌挂载时序。
  //
  // 踩过的坑：webServer 由 web-app bundle 提供，挂载时机晚于本插件的 apply()。
  // 若在 apply() 里同步 `ctx.get('webServer')`，拿到 undefined，路由被整个跳过 →
  // 浏览器面板能渲染（客户端半边来自 loader roster），但所有 API 调用 405/404。
  //
  // ctx.inject(['webServer'], cb) 只在依赖就绪时调用 cb，且不阻塞 headless /
  // acp / sdk（那些组合没有 webServer，cb 永不执行，插件其余功能照常）。
  //
  // handler 用 getApi 延迟取 api；api 还没装配好时回 503，客户端重试即可。
  // ---------------------------------------------------------------
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer') as
      | { register(route: unknown): () => void }
      | undefined
    if (webServer === undefined) return
    const route = webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: makeAiEmployeeHandler({
        getApi: () => api,
        userId: 'user-1', // Phase 2 接鉴权后换成真实用户
      }),
    })
    console.log(`[ai-employee] HTTP 路由已注册：${API_PATH}（apply 后 ${Date.now() - applyStartedAt}ms）`)
    scoped.effect(() => () => {
      try { route() } catch { /* ignore */ }
    })
  })

  // 装配（异步）；完成后注册 Tool
  void createAiEmployee({
    storageDomain,
    execCommand: makeExecCommand(ctx),
    // subagents 也由别的 bundle 提供，同步阶段可能还没挂载；装配时再取
    getSubagents: () => ctx.get('subagents') as SubagentsLike | undefined,
  })
    .then((created) => {
      if (stopped) {
        void created.dispose()
        return
      }
      api = created

      // 注册内存 Tool（模型可见）
      const tools = createMemoryToolDefinitions({ memory: created.memory })

      // 注册装配 Tool：建项目 / 建员工 / 建工作流 / 建任务
      // （V0.3 §13.3「方式 A：跟总顾问说」的基础设施）
      tools.push(...createSetupToolDefinitions({
        workspaces: created.workspaces,
        bots: created.bots,
        workflows: created.workflows,
        tasks: created.tasks,
        ...(created.audit !== undefined ? { audit: created.audit } : {}),
        // 被派发的员工不能建项目/员工/工作流/任务；无 sessions 时视为没有员工在跑
        isDispatchedEmployee: (id) => created.sessions?.isDispatchedEmployee(id) ?? false,
        userId: 'user-1',
      }))

      // 注册派发相关 Tool。
      //   task_list / task_dispatch 依赖 subagents（派活能力）；不可用时跳过。
      //   task_close 只依赖 tasks + audit，**不依赖 subagents**，所以单独注册，
      //   否则 headless 等没有 subagents 的组合里连收尾任务都做不到。
      const dispatchDeps = {
        tasks: created.tasks,
        ...(created.audit !== undefined ? { audit: created.audit } : {}),
        // 被派发的员工不能关闭/推进任务
        isDispatchedEmployee: (id: string | undefined) =>
          created.sessions?.isDispatchedEmployee(id) ?? false,
        userId: 'user-1',
      }
      if (created.dispatch !== undefined) {
        tools.push(...createDispatchToolDefinitions({ ...dispatchDeps, dispatch: created.dispatch }))
      } else {
        console.warn('[ai-employee] subagents 不可用 → 跳过 task_list / task_dispatch 注册')
        tools.push(...createCloseToolDefinitions(dispatchDeps))
      }

      // 正式插件注册 Tool 用 ctx.tools.register(definition)。
      // （`harness.defineTool/registerTool` 是**动态 Cordis 插件**的 builtin，正式包里没有。）
      const toolRuntime = ctx.get('tools') as
        | { register(def: unknown): () => void }
        | undefined
      const toolDisposers: (() => void)[] = []
      if (toolRuntime === undefined) {
        console.error('[ai-employee] tools 服务不可用 → 跳过 Tool 注册')
      } else {
        for (const tool of tools) {
          try {
            toolDisposers.push(toolRuntime.register(tool))
          } catch (e) {
            console.error(
              `[ai-employee] 注册 Tool "${tool.name}" 失败：`,
              e instanceof Error ? e.message : String(e),
            )
          }
        }
      }

      if (stopped) {
        // 极端 race：装配完成后立刻被卸载——撤销所有注册的 Tool 并释放 api
        for (const d of toolDisposers) {
          try { d() } catch { /* ignore */ }
        }
        void created.dispose()
        api = undefined
        return
      }
      console.log(
        `[ai-employee] 后端装配完成：${toolDisposers.length} 个 Tool 已注册` +
        `（dispatch=${created.dispatch === undefined ? '不可用' : '可用'}，` +
        `apply 后 ${Date.now() - applyStartedAt}ms）`,
      )
      disposeTools = () => {
        for (const d of toolDisposers) {
          try { d() } catch { /* ignore */ }
        }
      }
    })
    .catch((err: unknown) => {
      // 装配失败只记录，不阻断宿主启动
      console.error('[ai-employee] 后端装配失败：', err)
    })
}
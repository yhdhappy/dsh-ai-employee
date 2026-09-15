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
import { createDispatchToolDefinitions } from './orchestrator/dispatch-tools.js'
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
  const storageDomain = ctx.get('storageDomain')
  const webServer = ctx.get('webServer')
  if (storageDomain === undefined) return

  let api: AiEmployeeApi | undefined
  let disposeRoute: (() => void) | undefined
  let disposeTools: (() => void) | undefined
  let stopped = false

  // effect 卸载：插件停掉时释放 route、tool、api
  ctx.effect(() => () => {
    stopped = true
    if (disposeRoute !== undefined) {
      try { disposeRoute() } catch { /* ignore */ }
      disposeRoute = undefined
    }
    if (disposeTools !== undefined) {
      try { disposeTools() } catch { /* ignore */ }
      disposeTools = undefined
    }
    if (api !== undefined) {
      void api.dispose()
      api = undefined
    }
  })

  // 装配是异步的；装配完成后再注册路由 + Tool
  void createAiEmployee({
    storageDomain,
    execCommand: makeExecCommand(ctx),
    // subagents 在 apply() 同步阶段可能还没挂载；装配是异步的，那时再取更稳。
    getSubagents: () => ctx.get('subagents') as SubagentsLike | undefined,
  })
    .then((created) => {
      if (stopped) {
        void created.dispose()
        return
      }
      api = created

      // 注册 HTTP 路由
      if (webServer !== undefined) {
        const userId = 'user-1' // Phase 2 接鉴权后换成真实用户
        const route = webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: makeAiEmployeeHandler({ api, userId }),
        })
        if (stopped) {
          try { route() } catch { /* ignore */ }
          void created.dispose()
          api = undefined
          return
        }
        disposeRoute = route
      }

      // 注册内存 Tool（模型可见）
      const tools = createMemoryToolDefinitions({ memory: created.memory })

      // 注册装配 Tool：建项目 / 建员工 / 建工作流
      // （V0.3 §13.3「方式 A：跟总顾问说」的基础设施）
      tools.push(...createSetupToolDefinitions({
        workspaces: created.workspaces,
        bots: created.bots,
        workflows: created.workflows,
        ...(created.audit !== undefined ? { audit: created.audit } : {}),
        // 被派发的员工不能建项目/员工/工作流；无 sessions（无 subagents）时视为没有员工在跑
        isDispatchedEmployee: (id) => created.sessions?.isDispatchedEmployee(id) ?? false,
        userId: 'user-1',
      }))

      // 注册派发 Tool（仅当 subagents 可用、dispatch 已装配）
      if (created.dispatch !== undefined && created.tasks !== undefined) {
        tools.push(...createDispatchToolDefinitions({
          tasks: created.tasks,
          dispatch: created.dispatch,
        }))
      } else {
        console.warn('[ai-employee] subagents 不可用 → 跳过 task_list / task_dispatch 注册')
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
        if (disposeRoute !== undefined) {
          try { disposeRoute() } catch { /* ignore */ }
          disposeRoute = undefined
        }
        void created.dispose()
        api = undefined
        return
      }
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
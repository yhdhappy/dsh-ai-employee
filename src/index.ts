/**
 * dsh-ai-employee — 插件入口（cordis 适配层 + HTTP 路由）。
 *
 * Phase 1 第二段：在 Phase 1 第一段基础上加 HTTP 路由（宿主↔客户端通道）。
 *  仍只做后端装配 + 提供一个 JSON API，不注册任何 UI（UI 在 lib/client.js 里）。
 *
 * 修复说明：路由注册延后到 api 装配完成后。之前的设计是"路由先注册 + getter 延迟取 api"，
 * 优点是首屏路由立即可用；缺点是浏览器刷新瞬间的请求（甚至 reload）可能命中"尚未装配完成"抛错。
 * 新方案：api ready 之后才 webServer.register()，浏览器 POST 时 api 一定可用，
 * 代价是路由在 apply→装配之间的几十毫秒不可用（浏览器还没加载，不会感知）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createAiEmployee } from './core/plugin.js'
import type { AiEmployeeApi } from './core/plugin.js'
import { makeAiEmployeeHandler } from './api/route.js'

/** 插件名，对应 cordis.patch.yml 里的 row `id`。 */
export const name = 'ai-employee-plugin'

/** 硬依赖。 */
export const inject: readonly string[] = ['storageDomain', 'webServer']

/** HTTP API 路由路径。客户端 fetch 用同一个路径。 */
const API_PATH = '/ai-employee/api'

function makeExecCommand(ctx: Context) {
  return async (command: string): Promise<{ ok: boolean; error?: string }> => {
    const shell = ctx.get('shell')
    if (shell === undefined) return { ok: false, error: 'shell 服务不可用' }
    const spec = shell.resolve({ command })
    const res = await shell.run(spec)
    const error = res.exitCode === 0 ? undefined : res.stderr.text
    return { ok: res.exitCode === 0, ...(error !== undefined ? { error } : {}) }
  }
}

export function apply(ctx: Context): void {
  const storageDomain = ctx.get('storageDomain')
  const webServer = ctx.get('webServer')
  if (storageDomain === undefined) return

  let api: AiEmployeeApi | undefined
  let disposeRoute: (() => void) | undefined
  let stopped = false

  // effect 卸载：插件停掉时释放 route 和 api
  ctx.effect(() => () => {
    stopped = true
    if (disposeRoute !== undefined) {
      try { disposeRoute() } catch { /* ignore */ }
      disposeRoute = undefined
    }
    if (api !== undefined) {
      void api.dispose()
      api = undefined
    }
  })

  // 装配是异步的；装配完成后再注册路由。
  // apply 到装配完成之间路由不在 —— 此时浏览器大概率还没加载插件，不会感知。
  void createAiEmployee({ storageDomain, execCommand: makeExecCommand(ctx) })
    .then((created) => {
      if (stopped) {
        void created.dispose()
        return
      }
      api = created

      if (webServer !== undefined) {
        const userId = 'user-1' // Phase 2 接鉴权后换成真实用户
        const route = webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: makeAiEmployeeHandler({ api, userId }),
        })
        // 卸载期间已经被 effect 标记 stopped 的极端情况：立刻撤销
        if (stopped) {
          try { route() } catch { /* ignore */ }
          void created.dispose()
          api = undefined
          return
        }
        disposeRoute = route
      }
    })
    .catch((err: unknown) => {
      // 装配失败只记录，不阻断宿主启动
      console.error('[ai-employee] 后端装配失败：', err)
    })
}
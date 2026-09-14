/**
 * dsh-ai-employee — 插件入口（cordis 适配层）。
 *
 * Phase 1 第一段：只做后端装配，不注册任何 UI、不碰 web profile。
 * 具体流程：拿到 storageDomain（+ 可选 shell）→ 装配后端 API →
 * 插件卸载时释放存储域。
 *
 * 工具与 UI 的注册在后续阶段（第二段起）基于这里产出的 API 完成。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createAiEmployee } from './core/plugin.js'
import type { AiEmployeeApi } from './core/plugin.js'

/** 插件名，对应 cordis.patch.yml 里的 row `id`。 */
export const name = 'ai-employee-plugin'

/** 硬依赖：没有 storageDomain 时插件应进入等待，而不是假装可用。 */
export const inject: readonly string[] = ['storageDomain']

/** 由 shell 服务构造一个"执行命令"函数；shell 缺失时返回失败而不是抛错。 */
function makeExecCommand(ctx: Context) {
  return async (command: string): Promise<{ ok: boolean; error?: string }> => {
    const shell = ctx.get('shell')
    if (shell === undefined) {
      return { ok: false, error: 'shell 服务不可用' }
    }
    const spec = shell.resolve({ command })
    const res = await shell.run(spec)
    const error = res.exitCode === 0 ? undefined : res.stderr.text
    return { ok: res.exitCode === 0, ...(error !== undefined ? { error } : {}) }
  }
}

export function apply(ctx: Context): void {
  const storageDomain = ctx.get('storageDomain')
  if (storageDomain === undefined) return

  let api: AiEmployeeApi | undefined
  let stopped = false

  // 装配是异步的；同步注册一个 effect 以保证卸载时能释放（含"装配尚未完成就卸载"的情况）。
  ctx.effect(() => () => {
    stopped = true
    if (api !== undefined) {
      void api.dispose()
      api = undefined
    }
  })

  void createAiEmployee({ storageDomain, execCommand: makeExecCommand(ctx) })
    .then((created) => {
      if (stopped) {
        // 装配完成前已被卸载：立刻释放，避免域名被占住
        void created.dispose()
        return
      }
      api = created
    })
    .catch((err: unknown) => {
      // Phase 1 只做后端装配，失败时只记录，不阻断宿主启动
      console.error('[ai-employee] 后端装配失败：', err)
    })
}
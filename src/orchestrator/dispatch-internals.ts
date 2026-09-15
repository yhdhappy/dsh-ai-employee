/**
 * 派发层的两个纯函数，从 dispatch-service 抽出来单独放，
 * 目的是可被 test/ 直接 import 做回归测试（不依赖 subagents/storage）。
 *
 * 两者都对应真实踩过的坑：
 *   - transitionPath：状态机有 ready 这类中转态，任务不能一步跳到 developing。
 *   - buildTaskPrompt：子 session 的 cwd 继承父会话（spawn 无法指定工作目录），
 *     必须把项目根路径显式写进 prompt，否则产出落到项目外面。
 */

import type { TaskStatus } from '../storage/schemas.js'
import { canTransition, nextStates } from '../core/status-machine.js'

/**
 * 求从 from 到 to 的最短合法迁移路径（BFS，不含起点，含终点）。
 * 无路可走时返回空数组，让调用方的 transitionStatus 抛出原始错误。
 */
export function transitionPath(from: TaskStatus, to: TaskStatus): TaskStatus[] {
  if (from === to) return []
  const queue: TaskStatus[] = [from]
  const prev = new Map<TaskStatus, TaskStatus>()
  const seen = new Set<TaskStatus>([from])
  while (queue.length > 0) {
    const cur = queue.shift() as TaskStatus
    const neighbors: readonly TaskStatus[] = nextStates(cur)
    for (const next of neighbors) {
      if (next === cur || seen.has(next)) continue
      if (!canTransition(cur, next)) continue
      seen.add(next)
      prev.set(next, cur)
      if (next === to) {
        const path: TaskStatus[] = [next]
        let node = next
        while (node !== from) {
          const p = prev.get(node)
          if (p === undefined) break
          path.unshift(p)
          node = p
        }
        return path
      }
      queue.push(next)
    }
  }
  return []
}

/** buildTaskPrompt 需要的最小任务形状（避免依赖完整 Task 类型）。 */
export interface PromptTask {
  title: string
  description?: string
}

/** 组装派给子员工的 prompt：任务本身 + 项目根路径 + 收尾要求。 */
export function buildTaskPrompt(task: PromptTask, rootPath: string | undefined): string {
  const lines: string[] = []
  lines.push(`# 你的任务：${task.title}`)
  if (task.description !== undefined && task.description.trim() !== '') {
    lines.push('')
    lines.push('## 任务说明')
    lines.push(task.description)
  }
  lines.push('')
  lines.push('## 项目位置（重要）')
  if (rootPath !== undefined) {
    lines.push(`- 本项目根目录：\`${rootPath}\``)
    lines.push(
      '- 你的工作目录继承自主会话，**不是**项目根目录。所有代码/产出文件都必须写入上面这个项目根目录内（其子目录可以按需创建）。',
    )
  } else {
    lines.push('- 未能解析出项目根目录，请先确认任务所属项目的路径再写文件。')
  }
  lines.push('')
  lines.push('## 要求')
  lines.push('- 完成后，用一段话总结：你做了什么、验证了什么、有什么已知风险。')
  lines.push('- 不要重复本任务说明，直接干活。')
  return lines.join('\n')
}

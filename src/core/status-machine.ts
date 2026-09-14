/**
 * Task 状态机（V0.3 §18 + 段 1 业务约定）。
 *
 * 文档原文：
 *   "界面显示中文即可" —— 用 TASK_STATUS_LABELS 映射。
 *   文档没有规定合法迁移图，只列了 11 个状态名。
 *
 * 段 1 的选择（明确写在报告里，等用户确认）：
 *   - 状态名是约束（schema 校验过）
 *   - 迁移图是一个"建议性"约束（canTransition），不是硬锁
 *   - 流程可以是任意子集（V0.3 §13 说"开发→审核→汇报"只是众多流程之一）
 *   - 任何状态都可以被 'blocked' / 'done' 兜底
 *
 * 状态机命名规则：合法的下一步状态按段 1 的合理流程定义。
 * 流程脚本化（如"开发项目=程序员→审核员→总顾问"）由调用方决定目标状态。
 */

import type { TaskStatus } from '../storage/schemas.js'

/** 状态机迁移图：从某个状态出发，可以迁到哪些状态（含自身）。 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planned: ['planned', 'ready', 'blocked'],
  ready: ['ready', 'developing', 'planned', 'blocked'],
  developing: ['developing', 'dev_done', 'blocked', 'ready'],
  dev_done: ['dev_done', 'reviewing', 'developing', 'blocked'],
  reviewing: ['reviewing', 'pass', 'changes_req', 'blocked'],
  changes_req: ['changes_req', 'developing', 'blocked'],
  re_reviewing: ['re_reviewing', 'pass', 'changes_req', 'blocked'],
  pass: ['pass', 'done', 'wait_owner', 'blocked'],
  wait_owner: ['wait_owner', 'done', 'developing', 'blocked'],
  blocked: ['blocked', 'ready', 'developing', 'planned'],
  done: ['done'], // 终态
}

/** 判断两个状态之间的迁移是否合法。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 列出某个状态下允许迁到的所有状态（含自身）。 */
export function nextStates(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from]
}

/** 终态判定。 */
export function isTerminal(status: TaskStatus): boolean {
  return TRANSITIONS[status].length === 1 && TRANSITIONS[status][0] === status
}
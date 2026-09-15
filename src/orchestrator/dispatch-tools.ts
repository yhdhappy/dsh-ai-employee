/**
 * 派发相关的 Model Tool 定义（Phase 2 第二段）。
 *
 *   task.list     —— 列出某项目下的任务（模型找活干）
 *   task.dispatch —— 派发一个任务给它的负责员工，并沿工作流自动推进下一棒
 *
 * parent / signal 来自 Tool 的 exec（exec.agent / exec.signal）——
 * 段 2 的探针已验证 exec.agent 在 Tool 上下文中可用，且 persona 生效。
 *
 * 注意：本 Tool 会**阻塞直到子 agent 跑完**（含工作流后续棒次）。
 * 对 v1 是可接受的：模型调用后能直接拿到最终产出向用户汇报。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TaskService } from '../tasks/task-service.js'
import type { DispatchService } from './dispatch-service.js'
import type { TaskStatus } from '../storage/schemas.js'
import type { AuditService } from '../audit/audit-service.js'
import { TASK_STATUS_LABELS } from '../storage/schemas.js'

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function statusZh(s: TaskStatus): string {
  return TASK_STATUS_LABELS[s] ?? s
}

export interface DispatchToolsDeps {
  tasks: TaskService
  dispatch: DispatchService
  /** 审计（task_close 用）；缺失时跳过写审计。 */
  audit?: AuditService
  /** 判断某个 agent/session 是否是"被派发的员工"（越权检查用）。 */
  isDispatchedEmployee?: (agentId: string | undefined) => boolean
  /** 主会话里的调用方 id（v1 固定 'user-1'；接鉴权后换成真实用户）。 */
  userId?: string
}

export function createDispatchToolDefinitions(deps: DispatchToolsDeps): ToolDefinition[] {
  const { tasks, dispatch } = deps

  const listTool = defineTool({
    name: 'task_list',
    description:
      '列出指定项目下的所有任务，含状态（中文）、负责员工、是否绑定工作流步骤。' +
      '派发任务前先用它找到 taskId。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 ID' },
      ownerBotId: { type: 'string', description: '只看某个员工的任务（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                statusZh: { type: 'string' },
                ownerBotId: { type: 'string' },
                workflowId: { type: 'string' },
                workflowStepId: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const rows = value.tasks ?? []
        if (rows.length === 0) return textBlock('（该项目下暂无任务）')
        const text = rows
          .map((t) => `- [${t.statusZh}] ${t.title}  (id=${t.id}, owner=${t.ownerBotId})`)
          .join('\n')
        return textBlock(text)
      },
    },
    async execute(args: { workspaceId: string; ownerBotId?: string }) {
      const all = args.ownerBotId !== undefined
        ? tasks.listByOwnerBot(args.workspaceId, args.ownerBotId)
        : tasks.listByWorkspace(args.workspaceId)
      return {
        tasks: all.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          statusZh: statusZh(t.status),
          ownerBotId: t.ownerBotId,
          workflowId: t.workflowId ?? '',
          workflowStepId: t.workflowStepId ?? '',
        })),
      }
    },
  })

  const dispatchTool = defineTool({
    name: 'task_dispatch',
    description:
      '把一个任务派给它的负责员工：起一个独立 session（子 agent），把任务说明作为指令、' +
      '把该员工的系统提示词作为人设，跑完后自动沿工作流把下一棒派给下一个员工。' +
      '会阻塞直到整条链跑完，然后返回每一步的产出摘要。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要派发的任务 ID' },
      maxChainDepth: {
        type: 'integer',
        description: '最多往后推进几棒（默认 5，防止工作流成环无限跑）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string' },
                taskTitle: { type: 'string' },
                botName: { type: 'string' },
                stopReason: { type: 'string' },
                finalStatus: { type: 'string' },
                outputText: { type: 'string' },
                elapsedMs: { type: 'number' },
              },
            },
          },
          stoppedBy: { type: 'string' },
          waitingFor: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const steps = value.steps ?? []
        const lines: string[] = []
        steps.forEach((s, i) => {
          lines.push(`### 第 ${i + 1} 棒 · ${s.taskTitle}`)
          lines.push(`- 执行员工：${s.botName}`)
          lines.push(`- 结束原因：${s.stopReason}（最终状态：${s.finalStatus}）`)
          lines.push(`- 耗时：${s.elapsedMs}ms`)
          lines.push('')
          lines.push(s.outputText || '（无文本产出）')
          lines.push('')
        })
        lines.push(`链终止原因：${value.stoppedBy}`)
        if (typeof value.waitingFor === 'string' && value.waitingFor !== '') {
          lines.push(`等待用户决策：${value.waitingFor}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args: { taskId: string; maxChainDepth?: number }, exec) {
      const outcome = await dispatch.dispatchTask({
        taskId: args.taskId,
        parent: exec.agent,
        signal: exec.signal,
        ...(args.maxChainDepth !== undefined ? { maxChainDepth: args.maxChainDepth } : {}),
      })
      const steps = [outcome.step, ...outcome.chain]
      return {
        steps: steps.map((s) => ({
          taskId: s.taskId,
          taskTitle: s.taskTitle,
          botName: s.botName,
          stopReason: s.stopReason,
          finalStatus: statusZh(s.finalStatus),
          outputText: s.outputText,
          elapsedMs: s.elapsedMs,
        })),
        stoppedBy: outcome.stoppedBy,
        waitingFor: outcome.waitingFor ?? '',
      }
    },
  })

  return [listTool, dispatchTool]
}

/** 收尾类 Tool 的依赖（task_close 不依赖 subagents，故与派发 Tool 分开注册）。 */
export interface CloseToolsDeps {
  tasks: TaskService
  /** 审计（task.close 用）；缺失时跳过写审计。 */
  audit?: AuditService
  /** 判断某个 agent/session 是否是"被派发的员工"（越权检查用）。 */
  isDispatchedEmployee?: (agentId: string | undefined) => boolean
  /** 主会话里的调用方 id（v1 固定 'user-1'；接鉴权后换成真实用户）。 */
  userId?: string
}

/** 收尾类 Tool：task_close（强制关闭/推进停在中间态的任务）。 */
export function createCloseToolDefinitions(deps: CloseToolsDeps): ToolDefinition[] {
  const { tasks, audit, isDispatchedEmployee, userId } = deps

  // ---------------------------------------------------------------
  // task_close —— 强制收尾停在中间态的任务
  // ---------------------------------------------------------------
  const closeTool = defineTool({
    name: 'task_close',
    description:
      '强制关闭或推进一个停在中间态的任务（如 dev_done 开发完成 / wait_owner 等用户 / changes_req 需修改）：' +
      '不校验状态迁移图，直接设到指定状态。用于工作流跑完后收尾，避免任务一直悬着。' +
      '目标状态可选 done（关闭）/ pass（通过）/ changes_req（打回重做）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要关闭/推进的任务 ID' },
      forceTo: {
        type: 'string',
        required: true,
        enum: ['done', 'pass', 'changes_req'],
        description: '强制设到哪个状态：done=关闭，pass=通过，changes_req=打回重做',
      },
      reason: { type: 'string', description: '关闭原因（可选，写入审计）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
              statusZh: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const t = value.task
        if (t === undefined) return textBlock('（无返回）')
        return textBlock(
          `任务已更新：[${t.statusZh}] ${t.title}\n- id=${t.id}\n- 状态：${t.status}（${t.statusZh}）`,
        )
      },
    },
    async execute(
      args: { taskId: string; forceTo: 'done' | 'pass' | 'changes_req'; reason?: string },
      exec,
    ) {
      // 越权检查：被派发的员工不能关闭/推进任务（只有总顾问 / 用户可执行）
      const agentId = exec.agent?.id
      if (isDispatchedEmployee?.(agentId) === true) {
        throw new Error(
          `越权：被派发的员工 session（${agentId}）不能关闭/推进任务。` +
          '只有总顾问 / 用户可以在主会话里执行该操作。',
        )
      }

      const before = tasks.getTask(args.taskId)
      if (before === undefined) throw new Error(`任务不存在：${args.taskId}`)

      const after = await tasks.setStatus(args.taskId, args.forceTo)

      if (audit !== undefined) {
        await audit.record({
          workspaceId: after.workspaceId,
          actorType: 'user',
          actorId: userId ?? 'user-1',
          action: 'task.close',
          resourceType: 'task',
          resourceId: after.id,
          metadata: {
            forceTo: args.forceTo,
            reason: args.reason ?? '',
            fromStatus: before.status,
            toStatus: after.status,
            via: 'tool',
          },
        })
      }

      return {
        ok: true,
        task: {
          id: after.id,
          title: after.title,
          status: after.status,
          statusZh: statusZh(after.status),
          updatedAt: after.updatedAt,
        },
      }
    },
  })

  return [closeTool]
}

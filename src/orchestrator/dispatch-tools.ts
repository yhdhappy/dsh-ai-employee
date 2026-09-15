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

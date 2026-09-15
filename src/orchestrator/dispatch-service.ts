/**
 * 派发编排服务（DispatchService）。
 *
 * 把三样东西串起来：
 *   Task（工作单）→ Session（子 agent 上下文）→ Workflow（下一棒）
 *
 * 文档对齐：
 *   - V0.3 §13.4「员工完成任务会自动触发下一步」
 *   - V0.3 §16「Task 是工作单；Session 是独立上下文容器」
 *   - V0.2 §22「Task 分派 / 状态变更 / 文件写入 必须审计」
 *   - V0.2 B.9「Session 结束后成果应自动写入 docs/」
 *
 * 链式派发的终止条件（三者任一）：
 *   1. 当前步骤没有 nextStepId（流程结束）
 *   2. 下一步没有 workerBotId（"等用户决策"步骤 → 任务置 wait_owner，不派活）
 *   3. 达到 maxChainDepth（防无限循环）
 */

import type { Task, TaskStatus } from '../storage/schemas.js'
import type { TaskService } from '../tasks/task-service.js'
import type { WorkflowService } from '../workflows/workflow-service.js'
import type { MemoryService } from '../memory/memory-service.js'
import type { SessionService } from '../sessions/session-service.js'
import type { AuditService } from '../audit/audit-service.js'

/** 派发一个 task 时，任务在跑之前要进入的状态。 */
const RUNNING_STATUS: TaskStatus = 'developing'
/** 跑完之后任务进入的状态（V0.3 §18：开发完成）。 */
const RUN_DONE_STATUS: TaskStatus = 'dev_done'

export interface DispatchTaskInput {
  taskId: string
  /** 父 agent（Tool 的 exec.agent）。 */
  parent: unknown
  /** 取消信号（Tool 的 exec.signal）。 */
  signal: unknown
  /** 链式派发深度上限；默认 5。达到就停，不再往后派。 */
  maxChainDepth?: number
}

export interface DispatchStep {
  taskId: string
  taskTitle: string
  botId: string
  botName: string
  runId: string
  stopReason: string
  elapsedMs: number
  outputText: string
  /** 跑完后任务落到的状态。 */
  finalStatus: TaskStatus
}

export interface DispatchOutcome {
  /** 本步执行结果。 */
  step: DispatchStep
  /** 链上后续步骤（可能多层）。 */
  chain: DispatchStep[]
  /** 链为什么停下来。 */
  stoppedBy: 'no-next-step' | 'wait-owner' | 'max-depth' | 'no-workflow'
  /** "等用户决策" 时，下一步的描述。 */
  waitingFor?: string
}

export interface DispatchServiceDeps {
  tasks: TaskService
  workflows: WorkflowService
  memory: MemoryService
  sessions: SessionService
  audit?: AuditService
}

export interface DispatchService {
  /** 派发一个 task，并沿工作流链自动往下一棒推进。 */
  dispatchTask(input: DispatchTaskInput): Promise<DispatchOutcome>
  /** 只派发当前 task，不做工作流推进（供只需要"跑一次"的场景）。 */
  dispatchOne(input: DispatchTaskInput): Promise<DispatchStep>
}

function buildPrompt(task: Task): string {
  const lines: string[] = []
  lines.push(`# 你的任务：${task.title}`)
  if (task.description !== undefined && task.description.trim() !== '') {
    lines.push('')
    lines.push('## 任务说明')
    lines.push(task.description)
  }
  lines.push('')
  lines.push('## 要求')
  lines.push('- 完成后，用一段话总结：你做了什么、验证了什么、有什么已知风险。')
  lines.push('- 不要重复本任务说明，直接干活。')
  return lines.join('\n')
}

export function createDispatchService(deps: DispatchServiceDeps): DispatchService {
  const { tasks, workflows, memory, sessions, audit } = deps

  /** 把任务推进到 running 状态（容忍已经是该状态）。 */
  async function toRunning(task: Task): Promise<Task> {
    if (task.status === RUNNING_STATUS) return task
    // planned / ready / changes_req 都可以进 developing
    return await tasks.transitionStatus(task.id, RUNNING_STATUS)
  }

  /** 跑来一个 task 的 owner bot；返回本步结果（不改任务状态）。 */
  async function runOne(task: Task, input: DispatchTaskInput): Promise<DispatchStep> {
    const running = await toRunning(task)
    const result = await sessions.dispatchToBot({
      workspaceId: running.workspaceId,
      botId: running.ownerBotId,
      prompt: buildPrompt(running),
      parent: input.parent,
      signal: input.signal,
      taskId: running.id,
      label: `task:${running.id}`,
    })

    // 跑完 → 开发完成（V0.3 §18）
    let after = await tasks.transitionStatus(running.id, RUN_DONE_STATUS)

    // V0.2 B.9：Session 成果落项目记忆（best-effort，失败不阻断）
    try {
      await memory.writeMemory({
        workspaceId: after.workspaceId,
        fileName: `tasks/${after.id}.md`,
        content: [
          `# ${after.title}`,
          '',
          `- 执行员工：${result.botName}（${result.botId}）`,
          `- 子 session：${result.runId}`,
          `- 结束原因：${result.stopReason}`,
          `- 耗时：${result.elapsedMs}ms`,
          `- 时间：${new Date().toISOString()}`,
          '',
          '## 产出',
          '',
          result.outputText || '（无文本产出）',
          '',
        ].join('\n'),
        actor: 'bot',
        botId: result.botId,
      })
    } catch (e) {
      console.warn('[dispatch] 写项目记忆失败（不阻断）：', e instanceof Error ? e.message : String(e))
    }

    if (audit !== undefined) {
      await audit.record({
        workspaceId: after.workspaceId,
        actorType: 'bot',
        actorId: result.botId,
        action: 'task.dispatch',
        resourceType: 'task',
        resourceId: after.id,
        metadata: {
          botName: result.botName,
          runId: result.runId,
          stopReason: result.stopReason,
          finalStatus: after.status,
        },
      })
    }

    return {
      taskId: after.id,
      taskTitle: after.title,
      botId: result.botId,
      botName: result.botName,
      runId: result.runId,
      stopReason: result.stopReason,
      elapsedMs: result.elapsedMs,
      outputText: result.outputText,
      finalStatus: after.status,
    }
  }

  /** 把 DispatchStep 还原成 Task 形状，供链式推进时读 workflow 绑定与状态。 */
  function step2ToTask(task: Task, step: DispatchStep): Task {
    return { ...task, status: step.finalStatus }
  }

  async function dispatchTask(input: DispatchTaskInput): Promise<DispatchOutcome> {
    const maxDepth = input.maxChainDepth ?? 5
    const task = tasks.getTask(input.taskId)
    if (task === undefined) throw new Error(`任务不存在：${input.taskId}`)
    if (task.status === 'done') throw new Error('已完成的任务不能再派发')

    const step = await runOne(task, input)

    // 沿工作流往后走（用迭代而非递归，便于收集 chain）
    const chain: DispatchStep[] = []
    let stoppedBy: DispatchOutcome['stoppedBy'] = 'no-workflow'
    let waitingFor: string | undefined
    let cursor: Task = step2ToTask(task, step)
    let depth = 0

    while (depth < maxDepth) {
      if (cursor.workflowId === undefined || cursor.workflowStepId === undefined) {
        stoppedBy = 'no-workflow'
        break
      }
      const wf = workflows.getWorkflow(cursor.workflowId)
      if (wf === undefined) { stoppedBy = 'no-workflow'; break }

      const nextStep = workflows.getNextStep(cursor.workflowId, cursor.workflowStepId)
      if (nextStep === undefined) {
        // 流程结束：最后一棒收尾为 done（V0.3 §18 终态）。
        // 中间棒次停在 dev_done（开发完成，等下一棒/审核裁决）。
        await tasks.transitionStatus(cursor.id, 'done')
        stoppedBy = 'no-next-step'
        break
      }
      if (nextStep.workerBotId === undefined) {
        await tasks.transitionStatus(cursor.id, 'wait_owner').catch(() => undefined)
        stoppedBy = 'wait-owner'
        waitingFor = nextStep.description ?? '等待用户决策'
        break
      }

      const nextTask = await tasks.createTask({
        workspaceId: cursor.workspaceId,
        title: nextStep.description ?? `${wf.name} · 步骤 ${nextStep.order}`,
        ownerBotId: nextStep.workerBotId,
        createdBy: 'bot',
        workflowId: wf.id,
        workflowStepId: nextStep.id,
        initialStatus: 'ready',
        description: `来自工作流「${wf.name}」的步骤 ${nextStep.order}`,
      })

      if (audit !== undefined) {
        await audit.record({
          workspaceId: cursor.workspaceId,
          actorType: 'system',
          actorId: 'workflow',
          action: 'workflow.trigger',
          resourceType: 'task',
          resourceId: nextTask.id,
          metadata: {
            workflowId: wf.id,
            workflowName: wf.name,
            fromStepId: cursor.workflowStepId ?? null,
            toStepId: nextStep.id,
            depth: depth + 1,
          },
        })
      }

      const nextStepResult = await runOne(nextTask, input)
      chain.push(nextStepResult)
      cursor = step2ToTask(nextTask, nextStepResult)
      depth += 1
    }

    if (depth >= maxDepth) stoppedBy = 'max-depth'

    return {
      step,
      chain,
      stoppedBy,
      ...(waitingFor !== undefined ? { waitingFor } : {}),
    }
  }

  async function dispatchOne(input: DispatchTaskInput): Promise<DispatchStep> {
    const task = tasks.getTask(input.taskId)
    if (task === undefined) throw new Error(`任务不存在：${input.taskId}`)
    if (task.status === 'done') throw new Error('已完成的任务不能再派发')
    return await runOne(task, input)
  }

  return { dispatchTask, dispatchOne }
}

/**
 * 装配类 Model Tool（Phase 2 第三段）。
 *
 *   workspace_create —— 建项目（建文件夹 + 落 storage）
 *   bot_create       —— 建员工（从样板继承 + 落 storage）
 *   workflow_create  —— 建工作流（steps + 落 storage）
 *
 * 这三个是 V0.3 §13.3「方式 A：跟总顾问说」的基础设施：
 * 用户用大白话告诉总顾问要什么流程，总顾问调这些 Tool 真的把项目/员工/工作流建出来。
 * 在此之前，这些能力只有 HTTP 路由（UI 驱动），模型侧无法触达。
 *
 * 越权检查（第三段新增）：
 *   被派发出去的员工 session（程序员/审核员/…）**不能**建项目、建员工、建工作流。
 *   只有总顾问所在的主会话（= 用户侧）可以。
 *   判定依据：SessionService 记录了本进程派发出去的 run id。
 *
 * 全部复用既有 service 层，不绕过业务校验。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { BotService } from '../bots/bot-service.js'
import type { WorkflowService } from '../workflows/workflow-service.js'
import type { TaskService } from '../tasks/task-service.js'
import type { WorkflowStep } from '../storage/schemas.js'
import type { AuditService } from '../audit/audit-service.js'
import { TASK_STATUS_LABELS } from '../storage/schemas.js'
import { allTemplates } from './template-service.js'

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

export interface SetupToolsDeps {
  workspaces: WorkspaceService
  bots: BotService
  workflows: WorkflowService
  /** 任务服务（task_create 用）；缺失时 task_create 不注册。 */
  tasks?: TaskService
  audit?: AuditService
  /** 判断某个 agent/session 是否是"被派发的员工"。 */
  isDispatchedEmployee: (agentId: string | undefined) => boolean
  /** 主会话里的调用方 id（v1 固定 'user-1'；接鉴权后换成真实用户）。 */
  userId: string
}

/** 越权检查：被派发的员工不能执行装配类操作。 */
function assertNotEmployee(deps: SetupToolsDeps, agentId: string | undefined, what: string): void {
  if (deps.isDispatchedEmployee(agentId)) {
    throw new Error(
      `越权：被派发的员工 session（${agentId}）不能${what}。` +
      '只有总顾问 / 用户可以在主会话里执行该操作。',
    )
  }
}

export function createSetupToolDefinitions(deps: SetupToolsDeps): ToolDefinition[] {
  const { workspaces, bots, workflows, audit } = deps
  // ---------------------------------------------------------------
  // workspace_create
  // ---------------------------------------------------------------
  const workspaceCreate = defineTool({
    name: 'workspace_create',
    description:
      '创建一个新项目：在指定绝对路径建文件夹（含默认空 docs/），并落库。' +
      '同名路径已存在时不报错（幂等建目录）。返回项目 id、名称、根路径与记忆路径。',
    parameters: {
      name: { type: 'string', required: true, description: '项目名（用户可见，可中文）' },
      rootPath: {
        type: 'string',
        required: true,
        description: '项目的绝对路径，例如 /Users/me/projects/myproj',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          rootPath: { type: 'string' },
          memoryPath: { type: 'string' },
        },
      },
      render: (_args, value) =>
        textBlock(`已创建项目「${value.name}」\n- id: ${value.id}\n- 根路径: ${value.rootPath}\n- 记忆路径: ${value.memoryPath}`),
    },
    async execute(args: { name: string; rootPath: string }, exec) {
      assertNotEmployee(deps, exec.agent?.id, '创建项目')
      const ws = await workspaces.createWorkspace({
        name: args.name,
        rootPath: args.rootPath,
        ownerUserId: deps.userId,
      })
      if (audit !== undefined) {
        await audit.record({
          workspaceId: ws.id,
          actorType: 'user',
          actorId: deps.userId,
          action: 'workspace.create',
          resourceType: 'workspace',
          resourceId: ws.id,
          metadata: { name: ws.name, rootPath: ws.rootPath, via: 'tool' },
        })
      }
      return { id: ws.id, name: ws.name, rootPath: ws.rootPath, memoryPath: ws.memoryPath }
    },
  })

  // ---------------------------------------------------------------
  // bot_create
  // ---------------------------------------------------------------
  const botCreate = defineTool({
    name: 'bot_create',
    description:
      '在指定项目下创建一个 AI 员工。templateId 决定从哪个样板继承职责/系统提示词/' +
      '工作规则（advisor=总顾问, programmer=程序员, reviewer=审核员, researcher=情报员）。' +
      '不传 name 时用样板的默认名。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 id' },
      templateId: {
        type: 'string',
        required: true,
        description: '样板 id：advisor / programmer / reviewer / researcher',
      },
      name: { type: 'string', description: '员工名（默认用样板名）' },
      role: { type: 'string', description: '职位标签（默认用样板 role）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string' },
          templateId: { type: 'string' },
        },
      },
      render: (_args, value) =>
        textBlock(`已创建员工「${value.name}」（${value.role}）\n- id: ${value.id}\n- 样板: ${value.templateId}`),
    },
    async execute(args: { workspaceId: string; templateId: string; name?: string; role?: string }, exec) {
      assertNotEmployee(deps, exec.agent?.id, '创建员工')
      const tmpl = allTemplates().find((t) => t.id === args.templateId)
      if (tmpl === undefined) {
        throw new Error(
          `未知样板 id：${args.templateId}。可用：${allTemplates().map((t) => t.id).join(', ')}`,
        )
      }
      const bot = await bots.createBot({
        workspaceId: args.workspaceId,
        templateId: args.templateId,
        name: args.name?.trim() || tmpl.name,
        role: args.role?.trim() || tmpl.role,
        actor: { kind: 'user', userId: deps.userId },
      })
      if (audit !== undefined) {
        await audit.record({
          workspaceId: args.workspaceId,
          actorType: 'user',
          actorId: deps.userId,
          action: 'bot.create',
          resourceType: 'bot',
          resourceId: bot.id,
          metadata: { name: bot.name, role: bot.role, templateId: args.templateId, via: 'tool' },
        })
      }
      return { id: bot.id, name: bot.name, role: bot.role, templateId: args.templateId }
    },
  })

  // ---------------------------------------------------------------
  // workflow_create
  // ---------------------------------------------------------------
  const workflowCreate = defineTool({
    name: 'workflow_create',
    description:
      '在指定项目下创建一个工作流。steps 是步骤数组，每步指定谁来做（workerBotId）' +
      '以及做完后交给谁（nextStepId，留空表示流程结束）。' +
      'workerBotId 留空的步骤表示"等用户决策"。nextStepId 必须指向同一工作流里的某一步。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 id' },
      name: { type: 'string', required: true, description: '工作流名，例如「开发→审核→汇报」' },
      steps: {
        type: 'array',
        required: true,
        description: '步骤数组，按 order 升序',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            order: { type: 'integer' },
            workerBotId: { type: 'string' },
            nextStepId: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          stepCount: { type: 'number' },
          steps: { type: 'string' },
        },
      },
      render: (_args, value) =>
        textBlock(`已创建工作流「${value.name}」（${value.stepCount} 步）\n- id: ${value.id}\n- 步骤: ${value.steps}`),
    },
    async execute(
      args: { workspaceId: string; name: string; steps: WorkflowStep[] },
      exec,
    ) {
      assertNotEmployee(deps, exec.agent?.id, '创建工作流')

      // 容错：模型可能不传 id / order，补齐后再交给 service 校验
      const rawSteps = Array.isArray(args.steps) ? args.steps : []
      if (rawSteps.length === 0) throw new Error('工作流至少要有一个步骤')
      const steps: WorkflowStep[] = rawSteps.map((s, i) => {
        const step: WorkflowStep = {
          id: s.id?.trim() || `step_${i + 1}`,
          order: typeof s.order === 'number' ? s.order : i + 1,
        }
        if (s.workerBotId !== undefined && s.workerBotId !== '') step.workerBotId = s.workerBotId
        if (s.nextStepId !== undefined && s.nextStepId !== '') step.nextStepId = s.nextStepId
        if (s.description !== undefined && s.description !== '') step.description = s.description
        return step
      })

      const wf = await workflows.createWorkflow({
        workspaceId: args.workspaceId,
        name: args.name,
        steps,
      })
      if (audit !== undefined) {
        await audit.record({
          workspaceId: args.workspaceId,
          actorType: 'user',
          actorId: deps.userId,
          action: 'workflow.create',
          resourceType: 'workflow',
          resourceId: wf.id,
          metadata: {
            name: wf.name,
            stepCount: wf.steps.length,
            stepIds: wf.steps.map((s) => s.id),
            via: 'tool',
          },
        })
      }
      return {
        id: wf.id,
        name: wf.name,
        stepCount: wf.steps.length,
        steps: wf.steps
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((s) => `${s.id}(order=${s.order}, worker=${s.workerBotId ?? '等用户'}, next=${s.nextStepId ?? '结束'})`)
          .join(' → '),
      }
    },
  })

  // ---------------------------------------------------------------
  // task_create
  // 让"对话式"闭环打通：建项目 → 建员工 → 建工作流 → **建任务**。
  // 没有它，AI 助手搭完团队就没法让团队真正开始干活。
  // ---------------------------------------------------------------
  const taskCreate = defineTool({
    name: 'task_create',
    description:
      '在指定项目下创建一个任务（工作单）。任务默认状态是「已规划」，之后可以用 task_dispatch 派给负责员工执行。' +
      '如果传了 workflowId，任务会挂到该工作流的某个步骤上（不传 workflowStepId 就挂到第一步），' +
      '负责人从该步骤的 workerBotId 取。不传 workflowId 时任务独立，需要自己指定 ownerBotId。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 id' },
      title: { type: 'string', required: true, description: '任务名（人话，例如「想一个记账 App 的方案」）' },
      description: { type: 'string', description: '任务说明 / 规格（可选）' },
      workflowId: { type: 'string', description: '关联的工作流 id（可选）' },
      workflowStepId: {
        type: 'string',
        description: '关联到工作流的哪一步（可选；只给 workflowId 时默认第一步）',
      },
      ownerBotId: {
        type: 'string',
        description: '负责员工 id（可选）。挂工作流时自动取该步骤的 workerBotId；独立任务必须给。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          statusZh: { type: 'string' },
          ownerBotId: { type: 'string' },
          ownerBotName: { type: 'string' },
          workflowId: { type: 'string' },
          workflowStepId: { type: 'string' },
        },
      },
      render: (_args, value) =>
        textBlock(
          `已创建任务「${value.title}」\n` +
          `- id: ${value.id}\n` +
          `- 状态: ${value.statusZh}\n` +
          `- 负责员工: ${value.ownerBotName || value.ownerBotId}\n` +
          (value.workflowId
            ? `- 工作流: ${value.workflowId}${value.workflowStepId ? `（步骤 ${value.workflowStepId}）` : ''}\n`
            : '') +
          `\n下一步：调用 task_dispatch（taskId=${value.id}）即可让该员工开始干活；` +
          '若任务挂了工作流，会自动沿流程把后续棒次派下去。',
        ),
    },
    async execute(
      args: {
        workspaceId: string
        title: string
        description?: string
        workflowId?: string
        workflowStepId?: string
        ownerBotId?: string
      },
      exec,
    ) {
      if (deps.tasks === undefined) {
        throw new Error('任务服务不可用，无法创建任务')
      }
      const taskSvc = deps.tasks
      assertNotEmployee(deps, exec.agent?.id, '创建任务')

      const workspaceId = String(args.workspaceId ?? '').trim()
      if (!workspaceId) throw new Error('workspaceId 不能为空')
      const title = String(args.title ?? '').trim()
      if (!title) throw new Error('title 不能为空')

      const workflowId = typeof args.workflowId === 'string' ? args.workflowId.trim() : ''
      let workflowStepId = typeof args.workflowStepId === 'string' ? args.workflowStepId.trim() : ''
      let ownerBotId = typeof args.ownerBotId === 'string' ? args.ownerBotId.trim() : ''

      // 挂工作流：解析出要绑的步骤，并从步骤取负责人
      if (workflowId !== '') {
        const wf = workflows.getWorkflow(workflowId)
        if (wf === undefined) throw new Error(`工作流不存在：${workflowId}`)
        if (wf.workspaceId !== workspaceId) {
          throw new Error(`工作流 ${workflowId} 不属于项目 ${workspaceId}`)
        }
        const ordered = workflows.listSteps(workflowId) // 已按 order 升序
        if (ordered.length === 0) throw new Error(`工作流 ${workflowId} 没有步骤`)

        let step: WorkflowStep | undefined
        if (workflowStepId !== '') {
          step = workflows.getStep(workflowId, workflowStepId)
          if (step === undefined) {
            throw new Error(`工作流 ${workflowId} 里没有步骤 ${workflowStepId}`)
          }
        } else {
          step = ordered[0] // 只给 workflowId → 挂第一步
          if (step === undefined) throw new Error(`工作流 ${workflowId} 没有可用步骤`)
          workflowStepId = step.id
        }
        // 负责人：优先显式传入，否则取步骤的 workerBotId
        if (ownerBotId === '') ownerBotId = step.workerBotId ?? ''
        if (ownerBotId === '') {
          throw new Error(
            `工作流步骤 ${workflowStepId} 没有指定执行员工（等用户决策步骤），` +
            '请显式传 ownerBotId，或改挂到别的步骤。',
          )
        }
      }

      if (ownerBotId === '') {
        throw new Error('独立任务必须指定 ownerBotId（负责员工）')
      }
      const bot = bots.getBot(ownerBotId)
      if (bot === undefined) throw new Error(`员工不存在：${ownerBotId}`)

      const task = await taskSvc.createTask({
        workspaceId,
        title,
        ownerBotId,
        createdBy: 'bot',
        initialStatus: 'planned',
        ...(args.description !== undefined && args.description.trim() !== ''
          ? { description: args.description.trim() }
          : {}),
        ...(workflowId !== '' ? { workflowId } : {}),
        ...(workflowStepId !== '' ? { workflowStepId } : {}),
      })

      if (audit !== undefined) {
        await audit.record({
          workspaceId,
          actorType: 'bot',
          actorId: exec.agent?.id ?? deps.userId,
          action: 'task.create',
          resourceType: 'task',
          resourceId: task.id,
          metadata: {
            title: task.title,
            status: task.status,
            ownerBotId: task.ownerBotId,
            workflowId: task.workflowId ?? null,
            workflowStepId: task.workflowStepId ?? null,
            via: 'tool',
          },
        })
      }

      return {
        id: task.id,
        title: task.title,
        status: task.status,
        statusZh: TASK_STATUS_LABELS[task.status],
        ownerBotId: task.ownerBotId,
        ownerBotName: bot.name,
        workflowId: task.workflowId ?? '',
        workflowStepId: task.workflowStepId ?? '',
      }
    },
  })

  const all: ToolDefinition[] = [workspaceCreate, botCreate, workflowCreate]
  // 任务服务可用时才注册 task_create（纯 UI/无 storage 场景可缺）
  if (deps.tasks !== undefined) all.push(taskCreate)
  return all
}
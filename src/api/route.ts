/**
 * AI 员工 HTTP API 路由。
 *
 * 宿主半边通过 ctx.webServer.register 注册到 `/ai-employee/api`，
 * 客户端（lib/client.js）通过 fetch POST 调用本路由读写后端。
 *
 * 这个路由是"无类型"的：只做动作分发 + JSON 解析/序列化 + 错误兜底。
 * 业务校验与权限全部交给已有的 services。
 *
 * v1 支持的动作：
 *   - state             → 当前是否有项目 + 项目信息 + 员工列表
 *   - createWorkspace   → 建项目（{name, rootPath}）
 *   - createBot         → 建员工（{workspaceId, templateId, name}）
 *
 * 私聊（chat）v1 暂不提供：subagents.start 需要 parent: Agent，路由上下文里没有；
 * v1 点员工只显示详情，私聊走主对话（@员工）或在后续版本用 LLM 服务直接调模型。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { BotService } from '../bots/bot-service.js'
import type { WorkflowService } from '../workflows/workflow-service.js'
import type { Bot, Workflow, WorkflowStep, TaskStatus } from '../storage/schemas.js'
import { TASK_STATUS_LABELS } from '../storage/schemas.js'
import type { AuditService } from '../audit/audit-service.js'
import type { TaskService } from '../tasks/task-service.js'
import { allTemplates } from '../core/template-service.js'

export interface AiEmployeeApi {
  workspaces: WorkspaceService
  bots: BotService
  /** 工作流服务（Phase 2 第三段 UI 集成加入）。 */
  workflows?: WorkflowService
  /** 审计服务（Phase 2 第一段加入）；缺失时不写审计、listAuditEvents 返回空。 */
  audit?: AuditService
  /** 任务服务（task_close 用）；缺失时该 action 回 503。 */
  tasks?: TaskService
  /** 创建者身份（审计用）；默认 'user-1'。 */
  userId?: string
}

export interface AiEmployeeHandlerDeps {
  /** 直接传入装配好的 api（单元测试与简单场景用）。 */
  api?: AiEmployeeApi
  /**
   * 延迟取 api。路由可能在装配完成前就注册好了（webServer 与 storageDomain
   * 的挂载顺序不保证），此时 getApi() 返回 undefined，路由回 503 而不是抛错——
   * 客户端稍后重试即可，不需要重启。
   */
  getApi?: () => AiEmployeeApi | undefined
  /** 当前调用方的稳定 id（v1 固定 'user-1'；Phase 2 接鉴权后换成真实用户）。 */
  userId: string
}

interface JsonBody {
  action: string
  [key: string]: unknown
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        reject(new Error(`body 超过 ${maxBytes} 字节上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function toBotDto(b: Bot) {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    name: b.name,
    role: b.role,
    description: b.description,
    providerId: b.providerId,
    modelId: b.modelId,
    systemPrompt: b.systemPrompt,
    workingRules: b.workingRules,
    status: b.status,
    templateId: b.templateId,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  }
}

/** 工作流 DTO：只暴露前端需要展示的字段（v1 不做工作流编辑，先只读 + 新建）。 */
function toWorkflowDto(w: Workflow) {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    name: w.name,
    steps: w.steps.map((s) => ({
      id: s.id,
      order: s.order,
      workerBotId: s.workerBotId ?? null,
      nextStepId: s.nextStepId ?? null,
      description: s.description ?? null,
    })),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
}

/** 构造路由 handler。 */
export function makeAiEmployeeHandler(deps: AiEmployeeHandlerDeps) {
  const { userId } = deps
  /** 解析当前可用的 api；未就绪返回 undefined（调用方回 503）。 */
  const resolveApi = (): AiEmployeeApi | undefined =>
    deps.getApi !== undefined ? deps.getApi() : deps.api

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 装配可能还没完成（webServer 与 storageDomain 挂载顺序不保证）。
    // 回 503 而不是 500/抛错：客户端稍后重试即可。
    const api = resolveApi()
    if (api === undefined) {
      sendJson(res, 503, { ok: false, error: 'AI 员工后端尚未装配完成，请稍后重试' })
      return
    }
    // 仅接受 POST
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
      return
    }

    let body: JsonBody
    try {
      body = (await readJsonBody(req)) as JsonBody
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }

    const action = body.action
    if (typeof action !== 'string') {
      sendJson(res, 400, { ok: false, error: '缺少 action' })
      return
    }

    const actor = { kind: 'user' as const, userId }
    try {
      switch (action) {
        case 'state': {
          const workspaces = api.workspaces.listWorkspaces()
          const workspace = workspaces[0]
          const bots = workspace ? api.bots.listBotsByWorkspace(workspace.id) : []
          const workflows = workspace && api.workflows !== undefined
            ? api.workflows.listByWorkspace(workspace.id)
            : []
          sendJson(res, 200, {
            ok: true,
            state: {
              hasWorkspace: workspaces.length > 0,
              workspace: workspace ?? null,
              bots: bots.map(toBotDto),
              workflows: workflows.map(toWorkflowDto),
            },
          })
          return
        }

        case 'listBots': {
          const workspaceId = String(body.workspaceId ?? '').trim()
          if (!workspaceId) {
            sendJson(res, 400, { ok: false, error: 'workspaceId 不能为空' })
            return
          }
          const list = api.bots.listBotsByWorkspace(workspaceId)
          sendJson(res, 200, { ok: true, bots: list.map(toBotDto) })
          return
        }

        case 'listWorkflows': {
          if (api.workflows === undefined) {
            sendJson(res, 200, { ok: true, workflows: [] })
            return
          }
          const workspaceId = String(body.workspaceId ?? '').trim()
          if (!workspaceId) {
            sendJson(res, 400, { ok: false, error: 'workspaceId 不能为空' })
            return
          }
          const list = api.workflows.listByWorkspace(workspaceId)
          sendJson(res, 200, { ok: true, workflows: list.map(toWorkflowDto) })
          return
        }

        case 'createWorkflow': {
          if (api.workflows === undefined) {
            sendJson(res, 400, { ok: false, error: '工作流服务不可用' })
            return
          }
          const workspaceId = String(body.workspaceId ?? '').trim()
          const name = String(body.name ?? '').trim()
          if (!workspaceId) {
            sendJson(res, 400, { ok: false, error: 'workspaceId 不能为空' })
            return
          }
          if (!name) {
            sendJson(res, 400, { ok: false, error: '工作流名不能为空' })
            return
          }
          const rawSteps = Array.isArray(body.steps) ? body.steps : []
          if (rawSteps.length === 0) {
            sendJson(res, 400, { ok: false, error: '工作流至少要有一个步骤' })
            return
          }
          // 归一化：缺 id/order 自动补；workerBotId / nextStepId 空串视为未设置
          const steps: WorkflowStep[] = rawSteps.map((raw, i) => {
            const s = (raw ?? {}) as Record<string, unknown>
            const step: WorkflowStep = {
              id: typeof s.id === 'string' && s.id.trim() !== '' ? s.id.trim() : `s${i + 1}`,
              order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : i + 1,
            }
            if (typeof s.workerBotId === 'string' && s.workerBotId.trim() !== '') {
              step.workerBotId = s.workerBotId.trim()
            }
            if (typeof s.nextStepId === 'string' && s.nextStepId.trim() !== '') {
              step.nextStepId = s.nextStepId.trim()
            }
            if (typeof s.description === 'string' && s.description.trim() !== '') {
              step.description = s.description.trim()
            }
            return step
          })
          // 交给 service 做一致性校验（nextStepId 越界等由它拒绝）
          const wf = await api.workflows.createWorkflow({ workspaceId, name, steps })
          if (api.audit !== undefined) {
            await api.audit.record({
              workspaceId,
              actorType: 'user',
              actorId: api.userId ?? userId,
              action: 'workflow.create',
              resourceType: 'workflow',
              resourceId: wf.id,
              metadata: {
                name: wf.name,
                stepCount: wf.steps.length,
                stepIds: wf.steps.map((x) => x.id),
                via: 'ui',
              },
            })
          }
          sendJson(res, 200, { ok: true, workflow: toWorkflowDto(wf) })
          return
        }

        case 'createWorkspace': {
          const name = String(body.name ?? '').trim()
          const rootPath = String(body.rootPath ?? '').trim()
          if (!name || !rootPath) {
            sendJson(res, 400, { ok: false, error: 'name 和 rootPath 不能为空' })
            return
          }
          const ws = await api.workspaces.createWorkspace({ name, rootPath, ownerUserId: userId })
          if (api.audit !== undefined) {
            await api.audit.record({
              workspaceId: ws.id,
              actorType: 'user',
              actorId: userId,
              action: 'workspace.create',
              resourceType: 'workspace',
              resourceId: ws.id,
              metadata: { name: ws.name, rootPath: ws.rootPath, via: 'ui' },
            })
          }
          sendJson(res, 200, { ok: true, workspace: ws })
          return
        }

        case 'createBot': {
          const workspaceId = String(body.workspaceId ?? '').trim()
          if (!workspaceId) {
            sendJson(res, 400, { ok: false, error: 'workspaceId 不能为空' })
            return
          }
          const templateId = typeof body.templateId === 'string' ? body.templateId : undefined
          // 优先用请求里的 name / role；不传就用样板的 name / role（样板默认）
          // 兼容老前端：如果传了 name 就按传的来（不破坏）
          const requestedName = typeof body.name === 'string' ? body.name.trim() : ''
          const requestedRole = typeof body.role === 'string' ? body.role.trim() : ''
          let name: string
          let role: string
          if (requestedName || requestedRole) {
            name = requestedName || requestedRole
            role = requestedRole || requestedName
          } else {
            // 用样板默认：模板名 → 总顾问/程序员/审核员/情报员
            const tmpl = templateId !== undefined ? allTemplates().find((t) => t.id === templateId) : undefined
            if (tmpl === undefined) {
              sendJson(res, 400, { ok: false, error: '没传 name / role，且样板 id 无效' })
              return
            }
            name = tmpl.name
            role = tmpl.role
          }
          const bot = await api.bots.createBot({
            workspaceId,
            ...(templateId !== undefined ? { templateId } : {}),
            name,
            role,
            actor,
          })
          if (api.audit !== undefined) {
            await api.audit.record({
              workspaceId,
              actorType: 'user',
              actorId: userId,
              action: 'bot.create',
              resourceType: 'bot',
              resourceId: bot.id,
              metadata: {
                name: bot.name,
                role: bot.role,
                templateId: templateId ?? null,
                via: 'ui',
              },
            })
          }
          sendJson(res, 200, { ok: true, bot: toBotDto(bot) })
          return
        }

        case 'listAuditEvents': {
          if (api.audit === undefined) {
            sendJson(res, 200, { ok: true, events: [] })
            return
          }
          const workspaceId = String(body.workspaceId ?? '').trim()
          if (!workspaceId) {
            sendJson(res, 400, { ok: false, error: 'workspaceId 不能为空' })
            return
          }
          const since = typeof body.since === 'string' ? body.since : undefined
          // 注意：不要用 `action` 命名这个过滤字段 —— 会遮蔽外层的 action（分发动作名）
          const actionFilter = typeof body.actionFilter === 'string'
            ? body.actionFilter
            : (typeof body.auditAction === 'string' ? body.auditAction : undefined)
          const rawLimit = body.limit
          const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
            ? rawLimit
            : undefined
          const events = await api.audit.listEvents({
            workspaceId,
            ...(since !== undefined ? { since } : {}),
            ...(actionFilter !== undefined ? { action: actionFilter } : {}),
            ...(limit !== undefined ? { limit } : {}),
          })
          sendJson(res, 200, { ok: true, events })
          return
        }

        case 'task_close': {
          // 强制收尾停在中间态的任务：不校验迁移图（管理员逃生口）。
          const taskId = String(body.taskId ?? '').trim()
          if (!taskId) {
            sendJson(res, 400, { ok: false, error: 'taskId 不能为空' })
            return
          }
          const forceTo = String(body.forceTo ?? '').trim() as TaskStatus
          const ALLOWED_FORCE_TO: readonly TaskStatus[] = ['done', 'pass', 'changes_req']
          if (!ALLOWED_FORCE_TO.includes(forceTo)) {
            sendJson(res, 400, {
              ok: false,
              error: `forceTo 非法：${forceTo || '(空)'}；可选 ${ALLOWED_FORCE_TO.join(' / ')}`,
            })
            return
          }
          const tasks = api.tasks
          if (tasks === undefined) {
            sendJson(res, 503, { ok: false, error: 'AI 员工任务服务尚未就绪，请稍后重试' })
            return
          }
          const before = tasks.getTask(taskId)
          if (before === undefined) {
            sendJson(res, 404, { ok: false, error: `任务不存在：${taskId}` })
            return
          }
          const after = await tasks.setStatus(taskId, forceTo)
          if (api.audit !== undefined) {
            await api.audit.record({
              workspaceId: after.workspaceId,
              actorType: 'user',
              actorId: userId,
              action: 'task.close',
              resourceType: 'task',
              resourceId: after.id,
              metadata: {
                forceTo,
                reason: typeof body.reason === 'string' ? body.reason : '',
                fromStatus: before.status,
                toStatus: after.status,
                via: 'route',
              },
            })
          }
          sendJson(res, 200, {
            ok: true,
            task: {
              id: after.id,
              title: after.title,
              status: after.status,
              statusZh: TASK_STATUS_LABELS[after.status] ?? after.status,
              updatedAt: after.updatedAt,
            },
          })
          return
        }

        default:
          sendJson(res, 400, { ok: false, error: `未知 action: ${action}` })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: string }).code
      sendJson(res, 500, {
        ok: false,
        error: message,
        ...(typeof code === 'string' ? { code } : {}),
      })
    }
  }
}
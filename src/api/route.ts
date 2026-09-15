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
import type { Bot } from '../storage/schemas.js'
import type { AuditService } from '../audit/audit-service.js'
import { allTemplates } from '../core/template-service.js'

export interface AiEmployeeApi {
  workspaces: WorkspaceService
  bots: BotService
  /** 审计服务（Phase 2 第一段加入）；缺失时 listAuditEvents 返回空。 */
  audit?: AuditService
}

export interface AiEmployeeHandlerDeps {
  api: AiEmployeeApi
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

/** 构造路由 handler。 */
export function makeAiEmployeeHandler(deps: AiEmployeeHandlerDeps) {
  const { api, userId } = deps

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
          sendJson(res, 200, {
            ok: true,
            state: {
              hasWorkspace: workspaces.length > 0,
              workspace: workspace ?? null,
              bots: bots.map(toBotDto),
            },
          })
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
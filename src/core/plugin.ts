/**
 * AI 员工插件后端装配。
 *
 * 把 storage 域 + 服务装配成一个可用的后端 API。
 * 保持"纯工厂"形态：依赖从外部传入（storageDomain / execCommand），
 * 因此不依赖 cordis 运行时，可直接用 mock 测试。
 * 真正的 cordis 适配在 src/index.ts。
 *
 * Phase 2 第一段：装配 workflow + task + memory 服务。
 */

import { openAiEmployeeStore } from '../storage/domain.js'
import type { AiEmployeeStore } from '../storage/domain.js'
import { createWorkspaceService } from '../workspace/workspace-service.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import { createBotService } from '../bots/bot-service.js'
import type { BotService } from '../bots/bot-service.js'
import { createWorkflowService } from '../workflows/workflow-service.js'
import type { WorkflowService } from '../workflows/workflow-service.js'
import { createTaskService } from '../tasks/task-service.js'
import type { TaskService } from '../tasks/task-service.js'
import { createMemoryService } from '../memory/memory-service.js'
import type { MemoryService } from '../memory/memory-service.js'
import { createAuditService } from '../audit/audit-service.js'
import type { AuditService } from '../audit/audit-service.js'

/** 装配所需的外部依赖。 */
export interface AiEmployeeDeps {
  /** Harness storageDomain 服务（ctx.get('storageDomain')）。 */
  storageDomain: { open(spec: unknown): Promise<unknown> }
  /** 执行 shell 命令的方式（用于建项目目录、读写项目记忆）；返回 ok=false 表示失败。
   *  需要支持 stdout（listMemory / readMemory 用）。 */
  execCommand: (command: string) => Promise<{ ok: boolean; stdout?: string; error?: string }>
}

/** 装配完成的后端 API。 */
export interface AiEmployeeApi {
  store: AiEmployeeStore
  workspaces: WorkspaceService
  bots: BotService
  workflows: WorkflowService
  tasks: TaskService
  memory: MemoryService
  audit: AuditService
  /** 释放：关闭 storage 域。 */
  dispose(): Promise<void>
}

/**
 * 打开存储域并装配服务。
 * 失败时向上抛错（由调用方决定如何汇报），不留半开状态。
 */
export async function createAiEmployee(deps: AiEmployeeDeps): Promise<AiEmployeeApi> {
  const store = await openAiEmployeeStore(deps.storageDomain)
  try {
    const workspaces = createWorkspaceService(store, deps.execCommand)
    const bots = createBotService(store)
    const workflows = createWorkflowService(store)
    const tasks = createTaskService(store)
    const audit = createAuditService(store)
    const memory = createMemoryService({
      getMemoryPath: (workspaceId) => workspaces.getWorkspace(workspaceId)?.memoryPath,
      execCommand: deps.execCommand,
      workspaceExists: (workspaceId) => workspaces.getWorkspace(workspaceId) !== undefined,
      audit,
    })
    return {
      store,
      workspaces,
      bots,
      workflows,
      tasks,
      memory,
      audit,
      dispose: () => store.close(),
    }
  } catch (err) {
    // 装配中途失败：把已打开的域关掉，避免域名被占住
    await store.close()
    throw err
  }
}
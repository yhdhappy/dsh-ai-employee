/**
 * 项目工作区（Workspace）服务。
 *
 * Phase 1 后端核心之一：
 * - hasAnyWorkspace()：判断是否已建项目（Onboarding 入口逻辑）
 * - createWorkspace()：建项目 → 用 shell 建目录（含空 docs/）→ 落 storage
 * - getWorkspace / listWorkspaces / getByRootPath：查询
 *
 * 持久化用 Harness storage（AiEmployeeStore.workspace 表），不自搭 SQLite。
 * 建目录用 shell（fs 不能自动建目录）。
 */

import type { Workspace, WorkspaceStatus } from '../storage/schemas.js'
import type { AiEmployeeStore } from '../storage/domain.js'

/** 项目三态的常量。 */
export const WORKSPACE_STATUS: Record<'ACTIVE' | 'ARCHIVED' | 'DELETED', WorkspaceStatus> = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
}

/** 内存域的记忆子目录名（产品固定：项目记忆放 <rootPath>/docs/）。 */
const MEMORY_DIR = 'docs'

function nowIso(): string {
  return new Date().toISOString()
}

/** 生成一个不依赖外部库的简单 id（时间戳 + 随机）。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export interface CreateWorkspaceInput {
  name: string
  rootPath: string
  ownerUserId: string
}

export interface WorkspaceService {
  hasAnyWorkspace(): boolean
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>
  getWorkspace(id: string): Workspace | undefined
  getByRootPath(rootPath: string): Workspace | undefined
  listWorkspaces(): Workspace[]
}

/**
 * 创建 WorkspaceService。
 * @param store    已打开的 AI 员工存储域
 * @param mkdirCmd 建目录的执行器，缺省用 shell；返回 Promise<boolean> 表示目录是否建成功
 */
export function createWorkspaceService(
  store: AiEmployeeStore,
  execCommand: (command: string) => Promise<{ ok: boolean; error?: string }>,
): WorkspaceService {
  const table = store.workspace

  function hasAnyWorkspace(): boolean {
    for (const _ of table.entries()) return true
    return false
  }

  function getWorkspace(id: string): Workspace | undefined {
    return table.get(id)
  }

  function getByRootPath(rootPath: string): Workspace | undefined {
    for (const [, ws] of table.entries()) {
      if (ws.rootPath === rootPath) return ws
    }
    return undefined
  }

  function listWorkspaces(): Workspace[] {
    return [...table.entries()].map(([, ws]) => ws)
  }

  async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const name = input.name.trim()
    if (!name) throw new Error('项目名不能为空')
    if (!input.rootPath) throw new Error('必须指定项目文件夹')

    // 1. 用 shell 建目录（含项目根 + 默认空 docs/）
    const mkdirCmd = `mkdir -p "${input.rootPath}/${MEMORY_DIR}" && test -d "${input.rootPath}/${MEMORY_DIR}"`
    const mk = await execCommand(mkdirCmd)
    if (!mk.ok) {
      throw new Error(`创建项目目录失败：${mk.error ?? '未知错误'}`)
    }

    // 2. 落 storage 记录
    const now = nowIso()
    const workspace: Workspace = {
      id: genId('ws'),
      name,
      rootPath: input.rootPath,
      memoryPath: `${input.rootPath}/${MEMORY_DIR}`,
      status: WORKSPACE_STATUS.ACTIVE,
      ownerUserId: input.ownerUserId,
      createdAt: now,
      updatedAt: now,
    }
    await table.put(workspace.id, workspace)
    return workspace
  }

  return { hasAnyWorkspace, createWorkspace, getWorkspace, getByRootPath, listWorkspaces }
}
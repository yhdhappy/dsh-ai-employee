/**
 * 项目记忆服务（MemoryService）。
 *
 * 文档对齐：
 *   - V0.3 §21 + V0.2 B：项目记忆统一放 `<rootPath>/docs/` 下，Markdown 格式。
 *   - V0.2 B.8 安全边界：Bot 只能写 docs/ 下，不能越界。
 *   - V0.2 B.4 写入机制；B.5 读取机制（read by name / list all）。
 *
 * 安全要点：
 *   - fileName 解析后必须落在 docs/ 内（防 ../ 越界）
 *   - fileName 必须是 Markdown（.md 后缀；不强制但建议）
 *   - 写入 / 读取需要 shell 来操作真实文件系统
 *   - 审计日志：本期先在内存里 append-only 记，**不持久化**（持久化审计属 Phase 5 Notification + 异常处理）
 *
 * 调用者：
 *   - segment 1 的三个 Tool（write_memory / read_memory / list_memory）
 *   - segment 3 的 UI 集成（可能直接调 service）
 */

import { promises as nodeFs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { AuditService, RecordAuditInput } from '../audit/audit-service.js'

export interface MemoryServiceDeps {
  /** 拿到 workspace 的内存路径（一般是 <rootPath>/docs）。 */
  getMemoryPath: (workspaceId: string) => string | undefined
  /** 真正干活的 shell.run 包装（用 shell 服务避免越界）。 */
  execCommand: (command: string) => Promise<{ ok: boolean; stdout?: string; error?: string }>
  /** 检查一个 workspace 是否存在（避免给不存在的项目建目录）。 */
  workspaceExists: (workspaceId: string) => boolean
  /** 审计服务：每次 write/read/list 写一条；可选（不传 = 不审计）。 */
  audit?: AuditService
}

export interface WriteMemoryInput {
  workspaceId: string
  fileName: string
  content: string
  actor: 'user' | 'bot'
  botId?: string
}

export interface ReadMemoryInput {
  workspaceId: string
  fileName: string
  actor: 'user' | 'bot'
  botId?: string
}

export interface ListMemoryInput {
  workspaceId: string
  actor: 'user' | 'bot'
  botId?: string
}

export interface MemoryWriteResult {
  fileName: string
  path: string // 绝对路径
  bytes: number
}

export interface MemoryReadResult {
  fileName: string
  path: string
  content: string
}

export interface MemoryListResult {
  files: { fileName: string; path: string; bytes: number }[]
}

export class MemoryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

export interface MemoryService {
  writeMemory(input: WriteMemoryInput): Promise<MemoryWriteResult>
  readMemory(input: ReadMemoryInput): Promise<MemoryReadResult>
  listMemory(input: ListMemoryInput): Promise<MemoryListResult>
}

/**
 * 把 fileName 规范化，强制：
 *   - 不允许绝对路径
 *   - 不允许 .. 段（越界）
 *   - 不允许空名
 *   - 仅允许字母数字、点、下划线、连字符、中文（粗略：用 [\w.\-] + 中文）
 * 返回解析后的安全 fileName（已去除前缀斜杠）。
 */
function sanitizeFileName(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) throw new MemoryError('文件名不能为空', 'INVALID_FILE_NAME')
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) {
    throw new MemoryError('文件名不允许绝对路径', 'ABSOLUTE_PATH')
  }
  // 拆段，确保没有 .. 段
  const parts = s.split('/').filter(Boolean)
  if (parts.length === 0) throw new MemoryError('文件名不能为空', 'INVALID_FILE_NAME')
  for (const p of parts) {
    if (p === '..' || p === '.') {
      throw new MemoryError('文件名不允许 . 或 .. 段（越界）', 'PATH_TRAVERSAL')
    }
  }
  // 单段名 或 子路径；建议 .md 后缀
  if (!/\.(md|markdown)$/i.test(parts[parts.length - 1] ?? '')) {
    throw new MemoryError(
      `项目记忆必须是 Markdown 文件（建议后缀 .md）：${s}`,
      'NOT_MARKDOWN',
    )
  }
  return parts.join('/')
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  /** 把 memory 操作翻译成 V0.2 §22 的审计事件；调用 auditService.record（best-effort）。 */
  function buildAudit(
    input: { workspaceId: string; actor: 'user' | 'bot'; botId?: string },
    action: 'memory.write' | 'memory.read' | 'memory.list',
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): RecordAuditInput {
    return {
      workspaceId: input.workspaceId,
      actorType: input.actor,
      actorId: input.botId ?? 'user',
      action,
      resourceType: 'memory_file',
      resourceId,
      metadata,
    }
  }

  async function writeMemory(input: WriteMemoryInput): Promise<MemoryWriteResult> {
    if (!deps.workspaceExists(input.workspaceId)) {
      throw new MemoryError(`项目不存在：${input.workspaceId}`, 'WORKSPACE_NOT_FOUND')
    }
    const memPathOpt = deps.getMemoryPath(input.workspaceId)
    if (!memPathOpt) throw new MemoryError(`项目没有内存路径：${input.workspaceId}`, 'NO_MEMORY_PATH')
    const memPath: string = memPathOpt
    const safeName = sanitizeFileName(input.fileName)
    const fullPath = `${memPath}/${safeName}`
    // 用 Node fs 写：避免 heredoc 自动追加换行 + 跨平台；支持子目录自动建
    const parentDir = fullPath.replace(/\/[^/]*$/, '')
    try {
      await nodeFs.mkdir(parentDir, { recursive: true })
      await nodeFs.writeFile(fullPath, input.content, 'utf8')
    } catch (e) {
      throw new MemoryError(`写入失败：${e instanceof Error ? e.message : String(e)}`, 'WRITE_FAILED')
    }
    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (deps.audit !== undefined) {
      await deps.audit.record(
        buildAudit(
          { workspaceId: input.workspaceId, actor: input.actor, ...(input.botId !== undefined ? { botId: input.botId } : {}) },
          'memory.write',
          safeName,
          { bytes, absolutePath: fullPath },
        ),
      )
    }
    return { fileName: safeName, path: fullPath, bytes }
  }

  async function readMemory(input: ReadMemoryInput): Promise<MemoryReadResult> {
    if (!deps.workspaceExists(input.workspaceId)) {
      throw new MemoryError(`项目不存在：${input.workspaceId}`, 'WORKSPACE_NOT_FOUND')
    }
    const memPathOpt = deps.getMemoryPath(input.workspaceId)
    if (!memPathOpt) throw new MemoryError(`项目没有内存路径：${input.workspaceId}`, 'NO_MEMORY_PATH')
    const memPath: string = memPathOpt
    const safeName = sanitizeFileName(input.fileName)
    const fullPath = `${memPath}/${safeName}`
    let content: string
    try {
      content = await nodeFs.readFile(fullPath, 'utf8')
    } catch (e) {
      const code = (e as { code?: string }).code
      throw new MemoryError(
        `读取失败：${code === 'ENOENT' ? '文件不存在' : (e instanceof Error ? e.message : String(e))}`,
        'READ_FAILED',
      )
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (deps.audit !== undefined) {
      await deps.audit.record(
        buildAudit(
          { workspaceId: input.workspaceId, actor: input.actor, ...(input.botId !== undefined ? { botId: input.botId } : {}) },
          'memory.read',
          safeName,
          { bytes, absolutePath: fullPath },
        ),
      )
    }
    return { fileName: safeName, path: fullPath, content }
  }

  async function listMemory(input: ListMemoryInput): Promise<MemoryListResult> {
    if (!deps.workspaceExists(input.workspaceId)) {
      throw new MemoryError(`项目不存在：${input.workspaceId}`, 'WORKSPACE_NOT_FOUND')
    }
    const memPathOpt = deps.getMemoryPath(input.workspaceId)
    if (!memPathOpt) throw new MemoryError(`项目没有内存路径：${input.workspaceId}`, 'NO_MEMORY_PATH')
    const memPath: string = memPathOpt // 收窄到非 undefined 给内部闭包用
    // 用 Node fs 递归扫描（跨平台；不依赖 GNU find）
    const files: MemoryListResult['files'] = []
    async function walk(dir: string): Promise<void> {
      let entries: string[]
      try {
        entries = await nodeFs.readdir(dir)
      } catch (e) {
        const code = (e as { code?: string }).code
        // 目录不存在（项目刚建，docs/ 还没被任何人写过）→ 视为空
        if (code === 'ENOENT') return
        throw new MemoryError(`扫描记忆目录失败：${String(e)}`, 'LIST_FAILED')
      }
      for (const name of entries) {
        const abs = join(dir, name)
        const stat = await nodeFs.stat(abs)
        if (stat.isDirectory()) {
          await walk(abs)
        } else if (stat.isFile()) {
          if (/\.(md|markdown)$/i.test(name)) {
            const rel = relative(memPath, abs).split(sep).join('/')
            files.push({ fileName: rel, path: abs, bytes: stat.size })
          }
        }
      }
    }
    await walk(memPath)
    files.sort((a, b) => a.fileName.localeCompare(b.fileName))
    if (deps.audit !== undefined) {
      await deps.audit.record(
        buildAudit(
          { workspaceId: input.workspaceId, actor: input.actor, ...(input.botId !== undefined ? { botId: input.botId } : {}) },
          'memory.list',
          memPath,
          { fileCount: files.length },
        ),
      )
    }
    return { files }
  }

  return {
    writeMemory,
    readMemory,
    listMemory,
  }
}

// Re-export for tooling that might want to reuse sanitizer
export { sanitizeFileName }
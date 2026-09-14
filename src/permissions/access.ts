/**
 * 项目隔离 / 权限服务。
 *
 * Phase 1 P1.6：强制"项目之间默认零共享"。
 * 任何文件访问判定都基于"目标路径是否落在项目 rootPath 内"。
 * 跨项目（其他 workspace 的 rootPath）默认禁止。
 *
 * 纯函数层面用路径规范化为判据（第一道防线，可测）；
 * 运行时可对接 fs.contains 做强隔离（正式插件注入 fs 服务）。
 */

import { normalize, join, isAbsolute } from 'node:path'

/**
 * 纯净的路径归属判定：target 是否在 root 之内（含 root 本身）。
 * 返回 true 表示允许访问，false 表示越界。
 */
export function isWithinRoot(root: string, target: string): boolean {
  const r = normalize(root)
  const t = normalize(target)
  if (t === r) return true
  // 确保边界不用前缀误判（如 /a/b 不包含 /a/bc）
  return t.startsWith(r.endsWith('/') ? r : r + '/')
}

/**
 * 判定一次读取/写入是否被允许。
 * @param workspaceRoot 项目根目录
 * @param targetPath    要访问的绝对路径
 * @param memoryPath    项目记忆路径（默认 root/docs，允许 Bot 读写）
 * @param kind          read 或 write
 * @returns { allowed: boolean; reason?: string }
 */
export interface AccessInput {
  workspaceRoot: string
  targetPath: string
  memoryPath?: string
  kind: 'read' | 'write'
}

export interface AccessDecision {
  allowed: boolean
  reason?: string
}

/**
 * 项目内文件访问判定。
 * 规则（对齐 V0.2 §7）：
 * - 项目根目录内：默认允许读；写权限由调用方进一步收窄（此处给"默认"）。
 * - 项目记忆区（memoryPath，默认 root/docs）：读 + 写默认允许（员工写记忆用）。
 * - 项目根目录外（其他项目）：一律禁止。
 */
export function decideAccess(input: AccessInput): AccessDecision {
  const root = normalize(input.workspaceRoot)
  const mem = normalize(input.memoryPath ?? join(root, 'docs'))
  const t = normalize(input.targetPath)

  // 1) 项目根之外的路径：无论读写一律拒绝（跨项目零共享）
  if (!isWithinRoot(root, t)) {
    return { allowed: false, reason: `越界访问：目标不在项目根 ${root} 内` }
  }

  // 2) 项目记忆区：读 + 写默认允许
  if (isWithinRoot(mem, t)) {
    return { allowed: true }
  }

  // 3) 项目根内、记忆区外：
  //    - 读：允许（Bot 可读项目文件）
  //    - 写：由权限（canWriteWorkspaceFiles）决定，此处默认允许，Phase 中按 Bot 权限收窄
  return { allowed: true }
}

export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p)
}
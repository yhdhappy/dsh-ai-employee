/**
 * dsh-ai-employee — 占位入口
 *
 * 当前为仓库初始化阶段的最小可编译出口，仅为让构建/加载闭环可用。
 * 后续 Phase 1 起在此挂载真正的插件逻辑：storage 域、工具、
 * Onboarding / Workspace / Bot 服务与 UI 扩展。
 *
 * 按 Phase 0 探查确认的执行引擎（方式 A：Harness 原生 Agent）与
 * 存储方案（Harness 自带 storageDomain）逐步填充。
 */

/** 插件名，作为 cordis.patch.yml 里的 row `id`。 */
export const name = 'ai-employee-plugin'

/** 插件依赖注入声明；Phase 1 起随实际服务扩展。 */
export const inject: readonly string[] = []

/**
 * Cordis 插件对象。当前只带占位 apply，不注册任何能力，
 * 仅验证包可被 cordis 正确加载。Phase 1 起替换为真实注册逻辑。
 */
export function apply(_ctx: unknown): void {
  // 占位：无副作用
}
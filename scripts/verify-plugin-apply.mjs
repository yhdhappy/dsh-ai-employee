#!/usr/bin/env node
/**
 * 插件 apply() 的装配时序回归测试。
 *
 * 锁住一个真踩过的 bug：
 *   webServer 服务由 web-app bundle 提供，挂载时机**晚于**本插件的 apply()。
 *   如果在 apply() 里同步 `ctx.get('webServer')`，会拿到 undefined，
 *   于是 HTTP 路由被整个跳过 —— 浏览器面板能渲染（客户端半边来自 loader roster），
 *   但所有 API 调用都返回 405/404。
 *
 * 正确行为：用 `ctx.inject(['webServer'], cb)` 等依赖就绪后再注册路由；
 * 且不被没有 webServer 的组合（headless/acp/sdk）阻塞。
 *
 * 假 ctx 模拟了 cordis 的作用域 inject 语义：依赖未就绪时不调用 callback，
 * 就绪后才调用，并传入一个 scoped ctx。
 *
 * 运行：node scripts/verify-plugin-apply.mjs
 */

import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

function memTable() {
  const m = new Map()
  return {
    get(k) { return m.get(k) },
    put(k, v) { m.set(k, v); return Promise.resolve() },
    update(k, fn) { const n = fn(m.get(k)); m.set(k, n); return Promise.resolve(n) },
    delete(k) { return Promise.resolve(m.delete(k)) },
    entries() { return m.entries() },
  }
}

/**
 * 造一个假 cordis ctx。
 * @param opts.mountDelayMs webServer 多久后"挂载"好（模拟 bundle 加载顺序）
 * @param opts.hasWebServer  false = 整个组合没有 webServer（headless 场景）
 */
function makeCtx(opts = {}) {
  const mountDelayMs = opts.mountDelayMs ?? 20
  const hasWebServer = opts.hasWebServer ?? true

  const registered = []
  const warnings = []
  const errors = []
  let toolsRegistered = 0
  let webServerReady = !hasWebServer ? false : mountDelayMs <= 0

  if (hasWebServer && mountDelayMs > 0) {
    setTimeout(() => { webServerReady = true }, mountDelayMs)
  }

  const webServer = {
    register(route) {
      registered.push(route)
      return () => { /* disposer */ }
    },
  }

  const storageDomain = {
    async open(spec) {
      const tables = {}
      for (const k of Object.keys(spec.tables)) tables[k] = memTable()
      return { name: spec.name, table: (n) => tables[n], async close() {} }
    },
  }
  const shell = {
    resolve: (req) => ({ ...req, workdir: '/', timeoutMs: 1000, stdoutMaxBytes: 1024 }),
    run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }),
  }
  const tools = { register() { toolsRegistered += 1; return () => {} } }

  const makeScoped = () => ({
    get(name) { return name === 'webServer' ? webServer : base.get(name) },
    effect(fn) { return () => { void fn } },
    on() { return () => {} },
  })

  const base = {
    get(name) {
      if (name === 'webServer') return webServerReady ? webServer : undefined
      if (name === 'storageDomain') return storageDomain
      if (name === 'shell') return shell
      if (name === 'tools') return tools
      if (name === 'subagents') return undefined
      return undefined
    },
    effect(fn) { void fn; return () => {} },
    on() { return () => {} },
    /**
     * 模拟 cordis 的作用域 inject：依赖就绪才调用 callback（未就绪则轮询等待）。
     * 不阻塞调用方。
     */
    inject(_deps, callback) {
      if (!hasWebServer) return // 依赖永不就绪 → callback 永不执行（headless 场景）
      const tick = () => {
        if (webServerReady) { callback(makeScoped()); return }
        setTimeout(tick, 2)
      }
      tick()
    },
  }

  return {
    ctx: base,
    registered,
    warnings,
    errors,
    counts: () => ({ toolsRegistered }),
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 场景 1：webServer 晚挂载（web profile 真实时序）----------
console.log('=== 场景 1：webServer 晚于 apply 挂载（web profile 真实时序）===\n')

const h1 = makeCtx({ mountDelayMs: 20, hasWebServer: true })
apply(h1.ctx)

// apply 刚返回时，webServer 还没挂载
check('A1 apply 返回瞬间 webServer 尚未就绪（路由还没注册）', h1.registered.length === 0)

await wait(80) // 等 webServer 挂载 + inject 回调触发

check('A2 webServer 就绪后**路由被注册**（回归点）', h1.registered.length === 1,
  `注册数=${h1.registered.length}`)
if (h1.registered.length === 1) {
  const r = h1.registered[0]
  check('A3 路由 path 正确', r.path === '/ai-employee/api')
  check('A4 路由 kind=exact', r.kind === 'exact')
  check('A5 路由带 handler', typeof r.handler === 'function')

  // 装配已完成 → 请求应正常返回
  async function call(handler, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
    req.method = 'POST'
    const res = {
      statusCode: 0, body: null, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(p) { if (p != null) this.body = p; return this },
    }
    await handler(req, res)
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
  }
  const r2 = await call(r.handler, { action: 'state' })
  check('A6 装配完成后请求返回 200', r2.status === 200 && r2.body.ok === true,
    `status=${r2.status}`)
  check('A7 state 含 workspace/bots/workflows',
    r2.body.state !== undefined &&
    'workspace' in r2.body.state && 'bots' in r2.body.state && 'workflows' in r2.body.state)
}

// memory×3 + setup×4 + task_close×1 = 8
// （本场景无 subagents → task_list/task_dispatch 不注册，但 task_close 不受影响）
check('A8 注册了 Tool（memory×3 + setup×4 + task_close×1）', h1.counts().toolsRegistered === 8,
  `实际 ${h1.counts().toolsRegistered}`)

// ---------- 场景 2：组合里没有 webServer（headless/acp/sdk）----------
console.log('\n=== 场景 2：组合里没有 webServer（headless/acp/sdk）===\n')

const h2 = makeCtx({ hasWebServer: false })
apply(h2.ctx)
await wait(60)

check('B1 没有 webServer → 不注册路由、也不报错', h2.registered.length === 0)
// 回归点：没有 subagents 也不能连坐 task_close（否则 headless 下任务收不了尾）
check('B2 Tool 仍然注册（含 task_close，插件核心可用）', h2.counts().toolsRegistered === 8,
  `实际 ${h2.counts().toolsRegistered}`)

// ---------- 场景 3：webServer 一开始就绪 ----------
console.log('\n=== 场景 3：webServer 一开始就绪 ===\n')

const h3 = makeCtx({ mountDelayMs: 0, hasWebServer: true })
apply(h3.ctx)
await wait(60)

check('C1 路由注册成功', h3.registered.length === 1 && h3.registered[0].path === '/ai-employee/api')
check('C2 Tool 仍 8 个', h3.counts().toolsRegistered === 8)

// ---------- 场景 4：api 未就绪时路由回 503（不抛错）----------
console.log('\n=== 场景 4：api 未就绪时回 503（不是 500/抛错）===\n')

{
  // 直接构造一个 getApi 永远返回 undefined 的 handler
  const { makeAiEmployeeHandler } = await import('../lib/api/route.js')
  const handler = makeAiEmployeeHandler({ getApi: () => undefined, userId: 'user-1' })
  const req = Readable.from([Buffer.from(JSON.stringify({ action: 'state' }), 'utf8')])
  req.method = 'POST'
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(p) { if (p != null) this.body = p; return this },
  }
  await handler(req, res)
  const body = res.body ? JSON.parse(res.body) : null
  check('D1 api 未就绪 → 503', res.statusCode === 503, `status=${res.statusCode}`)
  check('D2 错误信息可读', body !== null && body.ok === false && /尚未装配完成/.test(body.error))
}

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)

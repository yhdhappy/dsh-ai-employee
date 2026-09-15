#!/usr/bin/env node
/**
 * 清理测试遗留项目（离线脚本，**只有用户自己跑**）。
 *
 * 为什么是脚本、不是 Tool / 路由动作：
 *   V0.3 §24.3「删除必须由用户自己操作，任何 Bot 都不能删除项目」。
 *   插件当前也**没有**任何 delete 路由动作（`/ai-employee/api` 只有
 *   state / create* / list* / task_close），所以 Agent 无法代劳删除 ——
 *   这个脚本就是那个"用户手动执行"的入口。
 *
 * 它做什么：
 *   1. 读插件持久化文件 `~/.dsh/storages/ai_employee.json`，列出**所有**项目，
 *      给每个打上"疑似测试遗留"的判定和理由；
 *   2. 默认只列不删（dry-run）。要真删必须显式给 `--all` 或 `--id`，
 *      并且逐个项目交互确认（`--yes` 才跳过）；
 *   3. 真删前先备份整个存储文件（`<file>.bak.<时间戳>`），
 *      再用"写临时文件 + rename"原子替换，避免写坏；
 *   4. 级联删除该项目名下的 bot / workflow / task / audit_event
 *      （所有带 `workspaceId` 字段的表），不留孤儿记录。
 *
 * 用法：
 *   node scripts/cleanup-test-projects.mjs                 # 只列清单（dry-run，安全）
 *   node scripts/cleanup-test-projects.mjs --json          # 机器可读的清单
 *   node scripts/cleanup-test-projects.mjs --id ws_xxx     # 指定项目（仍会确认）
 *   node scripts/cleanup-test-projects.mjs --all           # 所有"明确遗留"候选，逐个确认
 *   node scripts/cleanup-test-projects.mjs --all --yes     # 不交互（谨慎）
 *   node scripts/cleanup-test-projects.mjs --id ws_xxx --rmdir   # 连磁盘目录一起删
 *   node scripts/cleanup-test-projects.mjs --storage /path/x.json  # 换存储文件（自测用）
 *
 * 安全闸门：
 *   - 目标集合为空 → 直接退出，不做任何写入；
 *   - 只要是对**线上**存储文件动手，且检测到 `dsh web` 进程在跑 → 拒绝执行。
 *     原因：存储是整文件重写，运行中的进程内存里还留着旧数据，
 *     下一次任何写操作都会把删掉的项目"复活"。确实要强删加 `--force`。
 *     正确姿势：先停掉 GUI → 跑本脚本 → 再启动 GUI。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

// ---------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    ids: [],
    all: false,
    yes: false,
    force: false,
    rmdir: false,
    json: false,
    help: false,
    storage: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--id') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) fatal('--id 后面要跟项目 id')
      opts.ids.push(v)
    } else if (a === '--all') opts.all = true
    else if (a === '--yes' || a === '-y') opts.yes = true
    else if (a === '--force') opts.force = true
    else if (a === '--rmdir') opts.rmdir = true
    else if (a === '--json') opts.json = true
    else if (a === '--storage') {
      const v = argv[++i]
      if (v === undefined) fatal('--storage 后面要跟文件路径')
      opts.storage = v
    } else if (a === '--help' || a === '-h') opts.help = true
    else fatal(`未知参数：${a}（--help 看用法）`)
  }
  return opts
}

function fatal(msg) {
  console.error(`✗ ${msg}`)
  process.exit(2)
}

const HELP = `清理测试遗留项目（离线，用户自己跑）

  node scripts/cleanup-test-projects.mjs [选项]

  （不给 --all / --id 时只列清单，不删任何东西）

选项
  --id <wsId>        指定要删的项目 id，可重复
  --all              把"明确测试遗留"的候选都作为目标（仍逐个确认）
  --yes, -y          跳过交互确认
  --rmdir            同时删掉项目磁盘目录（默认只删记录）
  --force            检测到 dsh web 在跑时也强行执行（危险）
  --storage <path>   指定存储文件（默认 ~/.dsh/storages/ai_employee.json）
  --json             以 JSON 输出
  --help, -h         显示本帮助

建议顺序：停掉 GUI → 跑本脚本 → 再启动 GUI。`

// ---------------------------------------------------------------
// 存储文件定位与读取
// ---------------------------------------------------------------
const DOMAIN_FILE = 'ai_employee.json'

function defaultStoragePath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', DOMAIN_FILE)
}

function readStorage(file) {
  if (!existsSync(file)) fatal(`存储文件不存在：${file}`)
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    fatal(`存储文件不是合法 JSON：${file} — ${e instanceof Error ? e.message : String(e)}`)
  }
  if (raw === null || typeof raw !== 'object' || raw.tables === undefined) {
    fatal(`存储文件结构不认识（缺 tables）：${file}`)
  }
  return raw
}

function tableEntries(tables, name) {
  const t = tables[name]
  if (t === null || typeof t !== 'object') return []
  return Object.entries(t)
}

// ---------------------------------------------------------------
// 候选判定
//
// 注意：Workspace schema 里**没有** isWorkspaceTest 字段（V0.3 文档提过这个
// 概念，但落库的 Workspace 没有它），所以只能按可观测特征判：
//   高置信（会进 --all 目标集）：项目根目录在系统临时目录下 —— 重启就没，
//                                不可能是用户的真实项目；
//   中置信（只提示，不自动选）：名字或路径含 test / 测试 / 验收 / demo 等字样。
// ---------------------------------------------------------------
const TEMP_ROOTS = [tmpdir(), '/tmp', '/var/folders', '/private/tmp', '/private/var/folders']
const NAME_HINT = /(测试|验收|联调|临时|demo|sample|verify|test|tmp|scratch|playground)/i

/** 把 `~/x` 展开成绝对路径（记录里可能是 ~ 开头）。 */
function expandPath(p) {
  return resolve(p.replace(/^~(?=\/|$)/, homedir()))
}

function isUnderTemp(rootPath) {
  const p = expandPath(rootPath)
  return TEMP_ROOTS.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`))
}

/** 目录是否真的在磁盘上（展开 ~ 再判断）。 */
function dirOnDisk(rootPath) {
  if (typeof rootPath !== 'string' || rootPath === '') return false
  return existsSync(expandPath(rootPath))
}

function classify(ws) {
  const reasons = []
  let level = 'none'
  if (typeof ws.rootPath === 'string' && isUnderTemp(ws.rootPath)) {
    level = 'high'
    reasons.push(`根目录在系统临时目录下（${ws.rootPath}）`)
  }
  const name = typeof ws.name === 'string' ? ws.name : ''
  const path = typeof ws.rootPath === 'string' ? ws.rootPath : ''
  if (NAME_HINT.test(name) || NAME_HINT.test(path)) {
    if (level !== 'high') level = 'medium'
    reasons.push('名字或路径含测试/验收/demo 等字样')
  }
  if (ws.status === 'deleted') {
    reasons.push('状态已是 deleted')
  }
  return { level, reasons }
}

function cascadeCounts(tables, wsId) {
  const counts = {}
  for (const name of Object.keys(tables)) {
    if (name === 'workspace') continue
    counts[name] = tableEntries(tables, name)
      .filter(([, v]) => v !== null && typeof v === 'object' && v.workspaceId === wsId)
      .length
  }
  return counts
}

// ---------------------------------------------------------------
// 运行中的 dsh web 检测
// ---------------------------------------------------------------
function findLiveDshWeb() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\bdsh\b/.test(l) && /\bweb\b/.test(l) && !/cleanup-test-projects/.test(l))
  } catch {
    return [] // 查不到就当没在跑（不因此阻断）
  }
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------
const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(HELP)
  process.exit(0)
}

const storageFile = resolve(opts.storage ?? defaultStoragePath())
const isLiveStorage = storageFile === resolve(defaultStoragePath())
const raw = readStorage(storageFile)
const tables = raw.tables

const workspaces = tableEntries(tables, 'workspace').map(([id, ws]) => {
  const c = classify(ws ?? {})
  return { id, ws: ws ?? {}, level: c.level, reasons: c.reasons }
})

if (workspaces.length === 0) {
  console.log('没有找到任何项目记录，无需清理。')
  process.exit(0)
}

// ---- 组装目标集 ----
const targets = []
const notFoundIds = []
for (const id of opts.ids) {
  const hit = workspaces.find((w) => w.id === id)
  if (hit === undefined) notFoundIds.push(id)
  else targets.push(hit)
}
if (opts.all) {
  for (const w of workspaces) {
    if (w.level === 'high' && !targets.some((t) => t.id === w.id)) targets.push(w)
  }
}

const plan = targets.map((t) => ({
  id: t.id,
  name: t.ws.name ?? '(无名)',
  rootPath: t.ws.rootPath ?? '(无路径)',
  status: t.ws.status ?? '?',
  reasons: t.reasons,
  cascade: cascadeCounts(tables, t.id),
  dirExists: dirOnDisk(t.ws.rootPath),
}))

// --json 是给「脚本串脚本」用的，不接受交互确认 —— 要求显式 --yes，
// 免得有人以为 --json 只是换个输出格式，结果把项目删了。
if (opts.json && plan.length > 0 && !opts.yes) {
  fatal('--json 必须配合 --yes 使用（避免无人值守误删）；只想看清单就别给 --all / --id')
}

// ---- 只列清单（默认行为） ----
if (plan.length === 0) {
  if (opts.json) {
    console.log(JSON.stringify({
      storage: storageFile,
      dryRun: true,
      deleted: [],
      notFoundIds,
      inventory: workspaces.map((w) => ({
        id: w.id,
        name: w.ws.name ?? null,
        rootPath: w.ws.rootPath ?? null,
        status: w.ws.status ?? null,
        testLevel: w.level,
        reasons: w.reasons,
      })),
    }, null, 2))
    process.exit(0)
  }
  console.log(`存储文件：${storageFile}`)
  console.log(`共 ${workspaces.length} 个项目，清单如下：\n`)
  printInventory(workspaces)
  if (notFoundIds.length > 0) {
    console.log(`\n⚠ 指定的 id 在存储里找不到：${notFoundIds.join(', ')}`)
  }
  const high = workspaces.filter((w) => w.level === 'high')
  console.log(`\n(dry-run，什么都没删)`)
  if (high.length > 0) {
    console.log(`疑似测试遗留（高置信）${high.length} 个：${high.map((w) => w.id).join(', ')}`)
    console.log(`确认无误后执行：node scripts/cleanup-test-projects.mjs --all`)
  } else {
    console.log('没有高置信的测试遗留。要删某个项目请用 --id <wsId>（中置信项见上面清单）')
  }
  process.exit(0)
}

function printInventory(list) {
  for (const w of list) {
    const tag = w.level === 'high' ? '[高置信测试遗留]' : w.level === 'medium' ? '[可疑]' : '[保留]'
    console.log(`${tag} ${w.id}`)
    console.log(`    名字：${w.ws.name ?? '(无名)'}`)
    console.log(`    路径：${w.ws.rootPath ?? '(无路径)'}  （磁盘上${dirOnDisk(w.ws.rootPath) ? '存在' : '不存在'}）`)
    console.log(`    状态：${w.ws.status ?? '?'}`)
    if (w.reasons.length > 0) console.log(`    理由：${w.reasons.join('；')}`)
    console.log('')
  }
}

// ---- 检查运行中的 GUI（只对线上存储文件设闸） ----
const live = findLiveDshWeb()
if (isLiveStorage && live.length > 0 && !opts.force) {
  console.error('✗ 检测到 dsh web 进程正在运行，拒绝直接改存储文件。\n')
  for (const l of live) console.error(`    ${l}`)
  console.error(
    '\n原因：存储是整文件重写，运行中的进程内存里仍有旧数据；\n' +
    '      它下一次任何写操作都会把删掉的项目复活。\n\n' +
    '正确做法：\n' +
    '  1) 停掉 GUI（Ctrl-C / 关掉那个终端）\n' +
    `  2) node scripts/cleanup-test-projects.mjs ${opts.all ? '--all ' : ''}${opts.ids.map((i) => `--id ${i} `).join('')}\n` +
    '  3) 再启动 GUI\n\n' +
    '（确实要在运行中强删：加 --force，并接受可能被复活。）',
  )
  process.exit(3)
}

// ---- 确认 ----
if (!opts.json) {
  console.log(`存储文件：${storageFile}`)
  console.log(`将删除 ${plan.length} 个项目（级联删掉各自名下的 bot/workflow/task/审计记录）：\n`)
  for (const p of plan) {
    console.log(`  ● ${p.id}  ${p.name}`)
    console.log(`      路径：${p.rootPath}  （磁盘上${p.dirExists ? '存在' : '不存在'}）`)
    console.log(`      理由：${p.reasons.join('；') || '手动指定'}`)
    console.log(`      级联：${formatCounts(p.cascade)}`)
  }
  if (opts.rmdir) {
    console.log('\n⚠ --rmdir 已开启：上面"磁盘上存在"的目录会被递归删除。')
  } else {
    console.log('\n（只删数据库记录；磁盘目录不动。要一起删用 --rmdir）')
  }
  console.log('')
}

let confirmed = plan.map((p) => p.id)
if (!opts.yes && !opts.json) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  confirmed = []
  for (const p of plan) {
    const ans = (await rl.question(`删除「${p.name}」(${p.id})？[y/N] `)).trim().toLowerCase()
    if (ans === 'y' || ans === 'yes') confirmed.push(p.id)
    else console.log(`  跳过 ${p.id}`)
  }
  await rl.close()
}

if (confirmed.length === 0) {
  console.log('\n没有任何项目被确认删除，未做写入。')
  process.exit(0)
}

// ---- 备份 ----
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupFile = `${storageFile}.bak.${stamp}`
writeFileSync(backupFile, readFileSync(storageFile))

// ---- 执行删除 ----
const removed = {}
for (const [name, rows] of Object.entries(tables)) {
  if (rows === null || typeof rows !== 'object') continue
  let n = 0
  for (const [key, value] of Object.entries(rows)) {
    const hitWorkspace = name === 'workspace'
      ? confirmed.includes(key)
      : (value !== null && typeof value === 'object' && confirmed.includes(value.workspaceId))
    if (hitWorkspace) {
      delete rows[key]
      n++
    }
  }
  if (n > 0) removed[name] = n
}

// ---- 原子写回 ----
const tmpFile = join(dirname(storageFile), `.${DOMAIN_FILE}.cleanup.${process.pid}.tmp`)
writeFileSync(tmpFile, `${JSON.stringify(raw, null, 2)}\n`)
renameSync(tmpFile, storageFile)

// ---- 可选删目录 ----
const dirRemoved = []
if (opts.rmdir) {
  for (const p of plan) {
    if (!confirmed.includes(p.id)) continue
    if (typeof p.rootPath !== 'string' || p.rootPath === '') continue
    const abs = expandPath(p.rootPath)
    // 双保险：绝不动家目录 / 根目录 / 系统目录
    if (abs === homedir() || abs === '/' || abs.split('/').filter(Boolean).length < 2) {
      console.log(`  跳过删目录（路径太短，保护）：${abs}`)
      continue
    }
    if (!existsSync(abs)) continue
    rmSync(abs, { recursive: true, force: true })
    dirRemoved.push(abs)
  }
}

// ---- 结果 ----
const result = {
  storage: storageFile,
  backup: backupFile,
  deleted: confirmed,
  rowsRemoved: removed,
  dirsRemoved: dirRemoved,
}

if (opts.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`\n✓ 已删除 ${confirmed.length} 个项目：${confirmed.join(', ')}`)
  console.log(`  级联删除记录：${formatCounts(removed)}`)
  if (dirRemoved.length > 0) console.log(`  删除目录：${dirRemoved.join(', ')}`)
  console.log(`  备份：${backupFile}（${statSync(backupFile).size} 字节）`)
  console.log('\n重启 GUI 后应该就看不到这些项目了。')
}

function formatCounts(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`)
  return parts.length > 0 ? parts.join('，') : '无'
}

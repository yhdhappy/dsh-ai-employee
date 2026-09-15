#!/usr/bin/env node
/**
 * 模型 API 直连探针（Phase 2 第二段）。
 *
 * 目的：在装 web profile 之前，独立验证「凭据可用 + 模型能输出」。
 * 用 Harness 已配的 provider（默认 deepseek-official；也可指定 qwen-token-plan-cn
 * 的 deepseek-v4-flash-0731）。凭据从 ~/.dsh/.credentials.yaml 的 refs.* 读取。
 *
 * 用法：
 *   node scripts/probe-model.mjs                       # 默认 deepseek-official
 *   node scripts/probe-model.mjs qwen-token-plan-cn    # 用 qwen 的 deepseek-v4-flash-0731
 *   node scripts/probe-model.mjs qwen-token-plan-cn deepseek-v4-pro-0813
 *
 * 注意：本脚本不打印任何密钥。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROVIDERS = {
  'deepseek-official': {
    baseURL: 'https://api.deepseek.com',
    keyRef: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
  },
  'qwen-token-plan-cn': {
    baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    keyRef: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    defaultModel: 'deepseek-v4-flash-0731',
  },
}

/** 从 ~/.dsh/.credentials.yaml 的 refs: 段读一个 key（简易解析，不引 yaml 依赖）。 */
function readCredRef(refName) {
  // 先看环境变量
  if (process.env[refName]) return process.env[refName]
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let inRefs = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) { inRefs = false; continue } // 离开 refs 段
    if (!inRefs) continue
    const m = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (m === null) continue
    const [, key, rawValue] = m
    if (key !== refName) continue
    let v = rawValue.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    return v || undefined
  }
  return undefined
}

/** 打一个 OpenAI 兼容的 chat/completions。 */
async function callChat(baseURL, apiKey, model, prompt, maxTokens) {
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`
  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const elapsed = Date.now() - started
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { _raw: text.slice(0, 500) } }
  return { status: res.status, elapsedMs: elapsed, body }
}

async function main() {
  const providerId = process.argv[2] ?? 'deepseek-official'
  const provider = PROVIDERS[providerId]
  if (provider === undefined) {
    console.error(`未知 provider：${providerId}`)
    console.error(`可用：${Object.keys(PROVIDERS).join(', ')}`)
    process.exit(2)
  }
  const model = process.argv[3] ?? provider.defaultModel
  const maxTokens = Number.parseInt(process.argv[4] ?? '1024', 10)
  const apiKey = readCredRef(provider.keyRef)

  console.log('=== 模型 API 直连探针 ===')
  console.log(`provider   : ${providerId}`)
  console.log(`model      : ${model}`)
  console.log(`max_tokens : ${maxTokens}`)
  console.log(`endpoint   : ${provider.baseURL}/chat/completions`)
  console.log(`key ref    : ${provider.keyRef} → ${apiKey === undefined ? '缺失 ✗' : `已读到（${apiKey.length} 字符，值不打印）✓`}`)
  if (apiKey === undefined) {
    console.error('\n结果：FAIL — 凭据缺失，无法调用')
    process.exit(1)
  }

  console.log('\n发起请求（prompt: 只回复两个字：模型OK）…')
  let r
  try {
    r = await callChat(provider.baseURL, apiKey, model, '只回复两个字：模型OK', maxTokens)
  } catch (e) {
    console.error(`\n结果：FAIL — 请求异常：${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  console.log(`HTTP status: ${r.status}   耗时: ${r.elapsedMs}ms`)
  if (r.status !== 200) {
    console.error('\n结果：FAIL — 非 200')
    console.error('响应片段：', JSON.stringify(r.body).slice(0, 800))
    process.exit(1)
  }

  const choice = r.body?.choices?.[0]
  const message = choice?.message
  const content = message?.content
  const reasoning = message?.reasoning_content ?? message?.reasoning
  const usage = r.body?.usage
  console.log(`返回模型   : ${r.body?.model ?? '(未标注)'}`)
  console.log(`finish     : ${choice?.finish_reason ?? '(未标注)'}`)
  console.log(`模型输出   : ${JSON.stringify(content)}`)
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    console.log(`推理内容   : ${JSON.stringify(reasoning.slice(0, 120))}${reasoning.length > 120 ? '…' : ''}`)
  }
  if (usage !== undefined) {
    console.log(`token 用量 : prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`)
    if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
      console.log(`  其中推理 : ${usage.completion_tokens_details.reasoning_tokens}`)
    }
  }

  const hasContent = typeof content === 'string' && content.trim().length > 0
  const hasReasoning = typeof reasoning === 'string' && reasoning.trim().length > 0
  if (hasContent) {
    console.log('\n结果：PASS — 凭据可用，模型有正式输出')
    process.exit(0)
  }
  if (hasReasoning) {
    console.log('\n结果：PARTIAL — 凭据可用，但 max_tokens 被推理耗尽，没产出正式内容')
    console.log('        建议：调大 max_tokens（本脚本第 4 个参数）')
    process.exit(1)
  }
  console.log('\n结果：FAIL — 有响应但既无内容也无推理')
  process.exit(1)
}

main().catch((e) => {
  console.error('探针异常：', e)
  process.exit(1)
})
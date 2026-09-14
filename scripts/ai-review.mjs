#!/usr/bin/env node
/**
 * AI 审 PR —— dsh-ai-employee
 *
 * 读取一个 PR 的代码变更（diff），调用 DeepSeek API 做代码审核，
 * 输出结构化审核意见（通过 / 需修改 + 问题清单 + 建议）。
 *
 * 用途：由 GitHub Actions（.github/workflows/ai-review.yml）在 PR 时触发，
 * 把 diff 交给我们自己的 AI 团队当"审核员"审阅。
 *
 * 用法：
 *   node scripts/ai-review.mjs < diff.patch           # 从 stdin 读 diff
 *   DEEPSEEK_API_KEY=... DEEPSEEK_DIFF_FILE=pr.diff bash scripts/ai-review.mjs
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY  （必填）DeepSeek API Key
 *   DEEPSEEK_BASE_URL （可选）默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL    （可选）默认 deepseek-chat
 *   DEEPSEEK_DIFF_FILE（可选）改成从文件读 diff（缺省走 stdin）
 *   PR_TITLE / PR_BODY（可选）带上 PR 标题和描述，帮助审核理解意图
 */

import { readFileSync } from 'node:fs'

const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY')
  process.exit(2)
}

const baseURL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const prTitle = process.env.PR_TITLE ?? ''
const prBody = process.env.PR_BODY ?? ''

let diff = ''
if (process.env.DEEPSEEK_DIFF_FILE) {
  diff = readFileSync(process.env.DEEPSEEK_DIFF_FILE, 'utf8')
} else {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  diff = Buffer.concat(chunks).toString('utf8')
}

if (!diff.trim()) {
  console.log('没有可审核的 diff。')
  process.exit(0)
}

// 截断超大 diff，避免超出上下文
const MAX_DIFF_CHARS = 60_000
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS) + '\n... [diff 过长，已截断]'
}

const systemPrompt = `你是一位严格的代码审核员。请审核下面这个 PR 的代码变更，并从三方面给出意见：
1. 正确性：有没有明显 bug、边界问题、逻辑错误。
2. 质量：可读性、一致性、是否有明显坏味道。
3. 安全与健壮性：有没有安全风险、异常处理缺失。
此外给出一条总的结论文案（VERDICT）：pass（通过）或 changes_requested（需要修改）。

请用中文回答，输出为以下结构（Markdown）：
## 审核结论
**VERDICT**: pass | changes_requested

**总体评价**: 一两句话。

## 问题清单
- [严重/中等/轻微] 问题描述（如适用，给出文件/行号）

## 建议
- 一条或多条改进建议`

const userPrompt = [
  `PR 标题：${prTitle}`,
  prBody ? `PR 描述：${prBody}` : '',
  '',
  '以下是代码变更（diff）：',
  '```diff',
  diff,
  '```',
].join('\n')

const res = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  }),
})

if (!res.ok) {
  const body = await res.text().catch(() => '')
  console.error(`DeepSeek API 请求失败：${res.status} ${res.statusText}`)
  if (body) console.error(body)
  process.exit(1)
}

const data = await res.json()
const content = data?.choices?.[0]?.message?.content ?? '（无输出）'

// 把 VERDICT 同时写到退出码，方便 workflow 判定
const verdict = /VERDICT\s*:\s*\*\*(pass)\*\*/.test(content) ? 'pass' : 'changes_requested'

process.stdout.write(content + '\n')
// 供 workflow 读取的机器可读结论
process.stderr.write(`\n[ai-review] verdict=${verdict}\n`)
process.exit(verdict === 'pass' ? 0 : 3)
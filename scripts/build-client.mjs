#!/usr/bin/env node
/**
 * 把 src/client/index.js 包成 dsh-client-modules 期望的
 * `window.__ModuleLoader__.load(...)` 格式，输出到 lib/client.js。
 *
 * 不需要 tsdown / 任何 bundler：客户端源码本身就是 plain JS（无 import、
 * 无 JSX），factory 由宿主注入 module/exports/require，我们在外面再套一层
 * 加载器包装即可。
 *
 * 写完产物后会用 brace matching 把 factory body 抽出来过一遍 `new Function`
 * 语法检查（不执行），抓换行/缺括号/缺分号这类手写错误。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const PKG_NAME = '@yhdhappy/dsh-ai-employee'
const SRC = 'src/client/index.js'
const OUT = 'lib/client.js'

function extractFactoryBody(src) {
  const marker = 'factory: (require) => {'
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('build-client: 找不到 factory 起点')
  let depth = 0
  let i = start + marker.length - 1 // 指向 '{'
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        // i 是与 factory 的 '{' 配对的 '}'
        return src.slice(start + marker.length, i)
      }
    }
  }
  throw new Error('build-client: factory body 未闭合')
}

async function build() {
  const body = await readFile(SRC, 'utf8')
  const factoryInner = [
    'var module = { exports: {} };',
    'var exports = module.exports;',
    body,
    'return module.exports;',
  ].join('\n')
  const wrapped =
    `window.__ModuleLoader__.load({\n` +
    `  id: ${JSON.stringify(PKG_NAME)},\n` +
    `  factory: (require) => {\n` +
    `${factoryInner}\n` +
    `  }\n` +
    `});\n`

  // 语法校验（不执行）
  const factoryBody = extractFactoryBody(wrapped)
  try {
    // eslint-disable-next-line no-new-func
    new Function('require', factoryBody)
  } catch (e) {
    throw new Error(`build-client: factory body 语法错误：${e.message}`)
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, wrapped)
  console.log(`[build-client] ${SRC} -> ${OUT}  (factory body 语法 OK)`)
}

build().catch((e) => {
  console.error(e)
  process.exit(1)
})
/**
 * 回归测试：派给子员工的 prompt 必须带项目根路径。
 *
 * 覆盖的 bug：子 session 的 cwd 继承父会话（spawn 请求无法指定工作目录），
 * prompt 里不带 rootPath 时，员工会把父会话 cwd 当成"项目根目录"，
 * 产出落到项目外面。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTaskPrompt } from '../lib/orchestrator/dispatch-internals.js'

test('带 rootPath 时，prompt 里出现项目根目录与警告', () => {
  const prompt = buildTaskPrompt(
    { title: '写个 hello 函数', description: '实现 hello()' },
    '/tmp/proj/dev-team',
  )
  assert.match(prompt, /# 你的任务：写个 hello 函数/)
  assert.match(prompt, /## 任务说明\n实现 hello\(\)/)
  assert.match(prompt, /\/tmp\/proj\/dev-team/)
  assert.match(prompt, /不是\*\*项目根目录/)
})

test('不给 rootPath 时，明确要求先确认项目路径', () => {
  const prompt = buildTaskPrompt({ title: '无项目任务' }, undefined)
  assert.match(prompt, /未能解析出项目根目录/)
  assert.doesNotMatch(prompt, /本项目根目录：/)
})

test('空 description 不产生空的「任务说明」小节', () => {
  const prompt = buildTaskPrompt({ title: 't', description: '   ' }, '/tmp/p')
  assert.doesNotMatch(prompt, /## 任务说明/)
})

test('收尾要求始终存在', () => {
  const prompt = buildTaskPrompt({ title: 't' }, '/tmp/p')
  assert.match(prompt, /## 要求/)
  assert.match(prompt, /用一段话总结/)
})

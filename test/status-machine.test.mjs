/**
 * 回归测试：状态机与派发路径。
 *
 * 覆盖的 bug：task_dispatch 从 planned 期起跑时报
 * 「非法状态迁移：planned → developing」，根因是状态机只允许 planned → ready，
 * 而派发层想一步跳到 developing。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { canTransition, isTerminal, nextStates } from '../lib/core/status-machine.js'
import { transitionPath } from '../lib/orchestrator/dispatch-internals.js'

const ALL_STATUSES = [
  'planned', 'ready', 'developing', 'dev_done', 'reviewing',
  'changes_req', 're_reviewing', 'pass', 'wait_owner', 'blocked', 'done',
]

test('planned 只能先到 ready，不能直接到 developing', () => {
  assert.equal(canTransition('planned', 'developing'), false)
  assert.equal(canTransition('planned', 'ready'), true)
})

test('changes_req 可以回 ready，也可以直接重新开发', () => {
  assert.equal(canTransition('changes_req', 'ready'), true)
  assert.equal(canTransition('changes_req', 'developing'), true)
})

test('每个非终态都能求出到 developing 的合法路径', () => {
  const nonTerminal = ALL_STATUSES.filter((s) => !isTerminal(s) && s !== 'developing')
  for (const from of nonTerminal) {
    const path = transitionPath(from, 'developing')
    assert.ok(path.length > 0, `${from} 应该能到达 developing`)
    // 路径必须逐跳合法
    let cursor = from
    for (const step of path) {
      assert.ok(canTransition(cursor, step), `${cursor} → ${step} 应当合法`)
      cursor = step
    }
    assert.equal(cursor, 'developing')
  }
})

test('planned 起跑的路径是 planned → ready → developing', () => {
  assert.deepEqual(transitionPath('planned', 'developing'), ['planned', 'ready', 'developing'])
})

test('同状态迁移返回空路径（幂等）', () => {
  assert.deepEqual(transitionPath('developing', 'developing'), [])
})

test('done 是终态，出不去', () => {
  assert.deepEqual([...nextStates('done')], ['done'])
  assert.equal(isTerminal('done'), true)
})

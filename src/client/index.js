// dsh-ai-employee — 浏览器半边（v1）
//
// 这个文件会被 scripts/build-client.mjs 包成 window.__ModuleLoader__.load(...)
// 的格式，输出到 lib/client.js。这里不写 ESM import、不写 JSX、不写顶层 await。
//
// 它做的事情（最小可用）：
//   1. 注册一个 shell.overlay 条目（id: 'ai-employee'）：右下角浮动面板。
//   2. 面板在没有项目时显示"建项目"表单（有项目名 + 路径两个输入框）；
//      有项目时显示项目信息 + 员工芯片列表 + "新建员工"表单（4 个样板）。
//   3. 点击员工芯片展开详情（职责/边界/系统提示词摘要）。
//   4. 所有读写都 POST 到 /ai-employee/api（由宿主半边 src/api/route.ts 提供）。
//   5. 私聊（点员工进对话）v1 不开放：详情里明确写"请用主对话 @员工名"。
//
// 用到的全局：
//   - window.__ModuleLoader__.load(...) 由宿主注入（dsh-client-modules）。
//   - require('react') 在 factory 内由 ModuleLoader 提供。

var React = require('react')
var useState = React.useState
var useEffect = React.useEffect
var createElement = React.createElement

// -------------------- 样式（内联，保持零依赖） --------------------
var panelStyle = {
  position: 'fixed',
  right: '20px',
  bottom: '20px',
  width: '340px',
  // 面板装了「建项目 / 员工列表 / 工作流表单」后会长过视口高度，
  // 必须可滚动，否则下面的内容看不到也够不着。
  maxHeight: '80vh',
  background: '#ffffff',
  color: '#1a1a1a',
  border: '1px solid #d0d0d6',
  borderRadius: '10px',
  boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
  padding: '14px 16px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: '13px',
  lineHeight: '1.5',
  zIndex: 2147483600,
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
  display: 'flex',
  flexDirection: 'column',
}
var headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '10px',
  paddingBottom: '8px',
  borderBottom: '1px solid #ececef',
}
var titleStyle = { fontWeight: 600, fontSize: '14px' }
var sectionTitleStyle = {
  fontWeight: 600,
  fontSize: '12px',
  color: '#666',
  marginTop: '10px',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}
var inputStyle = {
  width: '100%',
  padding: '6px 8px',
  fontSize: '13px',
  border: '1px solid #d0d0d6',
  borderRadius: '6px',
  boxSizing: 'border-box',
  marginBottom: '6px',
  outline: 'none',
}
var selectStyle = Object.assign({}, inputStyle, { marginBottom: '6px' })
var buttonStyle = {
  padding: '6px 12px',
  fontSize: '13px',
  background: '#2b6cff',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
}
var buttonDisabledStyle = Object.assign({}, buttonStyle, { background: '#9bb6ff', cursor: 'not-allowed' })
var ghostButtonStyle = {
  padding: '4px 8px',
  fontSize: '12px',
  background: 'transparent',
  color: '#2b6cff',
  border: '1px solid #2b6cff',
  borderRadius: '6px',
  cursor: 'pointer',
}
var chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  margin: '3px 4px 3px 0',
  background: '#f3f4f7',
  border: '1px solid #e3e4e9',
  borderRadius: '999px',
  fontSize: '12px',
  cursor: 'pointer',
  userSelect: 'none',
}
var errorStyle = { color: '#c0392b', fontSize: '12px', marginTop: '6px' }
var hintStyle = { color: '#888', fontSize: '12px', marginTop: '4px' }
/** 对话式入口提示块：常驻在面板里，告诉用户怎么用主对话驱动 AI 团队。 */
var chatHintStyle = {
  marginTop: '8px',
  padding: '7px 9px',
  background: '#eef4ff',
  border: '1px solid #d6e2ff',
  borderRadius: '6px',
  fontSize: '11.5px',
  lineHeight: '1.55',
  color: '#33507a',
}
var detailBoxStyle = {
  marginTop: '6px',
  padding: '8px 10px',
  background: '#f8f9fb',
  border: '1px solid #ececef',
  borderRadius: '6px',
  fontSize: '12px',
  lineHeight: '1.55',
}
var codeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '11.5px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#f1f2f5',
  padding: '6px 8px',
  borderRadius: '4px',
  marginTop: '4px',
}

// -------------------- API 客户端 --------------------
function callApi(action, payload) {
  return fetch('/ai-employee/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, payload || {})),
  }).then(function (res) {
    return res.json().catch(function () {
      return { ok: false, error: 'HTTP ' + res.status }
    }).then(function (body) {
      if (!res.ok && body && body.ok === false) return body
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
      return body
    })
  })
}

function loadState() {
  return callApi('state').then(function (r) {
    if (!r.ok) throw new Error(r.error || '加载失败')
    return r.state
  })
}

// -------------------- 组件 --------------------
function AiEmployeePanel() {
  var s = useState({ hasWorkspace: false, workspace: null, bots: [], workflows: [] })
  var state = s[0]; var setState = s[1]
  var errS = useState(null); var error = errS[0]; var setError = errS[1]
  var busyS = useState(false); var busy = busyS[0]; var setBusy = busyS[1]

  var projectNameS = useState(''); var projectName = projectNameS[0]; var setProjectName = projectNameS[1]
  var projectPathS = useState(''); var projectPath = projectPathS[0]; var setProjectPath = projectPathS[1]

  var botTemplateS = useState('advisor'); var botTemplate = botTemplateS[0]; var setBotTemplate = botTemplateS[1]

  var selectedBotS = useState(null); var selectedBot = selectedBotS[0]; var setSelectedBot = selectedBotS[1]

  // ---- 工作流表单状态 ----
  // wfName: 工作流名；wfSteps: [{ botId }] 按顺序的步骤（每步选一个员工）；
  // wfOpen: 表单是否展开
  var wfNameS = useState(''); var wfName = wfNameS[0]; var setWfName = wfNameS[1]
  var wfStepsS = useState(['', '']); var wfSteps = wfStepsS[0]; var setWfSteps = wfStepsS[1]
  var wfOpenS = useState(false); var wfOpen = wfOpenS[0]; var setWfOpen = wfOpenS[1]
  var wfDetailS = useState(null); var wfDetail = wfDetailS[0]; var setWfDetail = wfDetailS[1]

  function reload() {
    setBusy(true); setError(null)
    loadState().then(function (st) { setState(st); setBusy(false) })
      .catch(function (e) { setError(e.message || String(e)); setBusy(false) })
  }
  useEffect(function () { reload() }, [])

  function submitCreateProject(e) {
    e.preventDefault()
    if (busy) return
    if (!projectName.trim() || !projectPath.trim()) {
      setError('项目名和路径都不能为空'); return
    }
    setBusy(true); setError(null)
    callApi('createWorkspace', { name: projectName, rootPath: projectPath })
      .then(function (r) {
        if (!r.ok) throw new Error(r.error || '创建失败')
        setProjectName(''); setProjectPath('')
        reload()
      })
      .catch(function (e) { setError(e.message || String(e)); setBusy(false) })
  }

  function submitCreateBot(e) {
    e.preventDefault()
    if (busy) return
    if (!state.workspace) return
    setBusy(true); setError(null)
    callApi('createBot', {
      workspaceId: state.workspace.id,
      templateId: botTemplate,
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || '创建失败')
      reload()
    }).catch(function (e) { setError(e.message || String(e)); setBusy(false) })
  }

  // ---- 工作流：步骤行操作 ----
  function setStepBot(idx, botId) {
    setWfSteps(function (prev) {
      var next = prev.slice()
      next[idx] = botId
      return next
    })
  }
  function addStep() {
    setWfSteps(function (prev) { return prev.concat(['']) })
  }
  function removeStep(idx) {
    setWfSteps(function (prev) {
      if (prev.length <= 1) return prev
      var next = prev.slice()
      next.splice(idx, 1)
      return next
    })
  }

  // ---- 工作流：提交 ----
  // 把「步骤 1 选谁、步骤 2 选谁…」串成线性链：s1 → s2 → … → sN（最后一棒结束）。
  // 每步的 nextStepId 由前端按顺序算好，交给后端 service 再做一致性校验。
  function submitCreateWorkflow(e) {
    e.preventDefault()
    if (busy) return
    if (!state.workspace) return
    var name = wfName.trim()
    if (!name) { setError('工作流名不能为空'); return }
    var picked = wfSteps.filter(function (x) { return x && x !== '' })
    if (picked.length === 0) { setError('至少要选一个员工作为步骤'); return }

    var steps = picked.map(function (botId, i) {
      var step = {
        id: 's' + (i + 1),
        order: i + 1,
        workerBotId: botId,
      }
      if (i < picked.length - 1) step.nextStepId = 's' + (i + 2)
      return step
    })

    setBusy(true); setError(null)
    callApi('createWorkflow', {
      workspaceId: state.workspace.id,
      name: name,
      steps: steps,
    }).then(function (r) {
      if (!r.ok) throw new Error(r.error || '创建失败')
      setWfName('')
      setWfSteps(['', ''])
      setWfOpen(false)
      reload()
    }).catch(function (e2) { setError(e2.message || String(e2)); setBusy(false) })
  }

  /** 把 workflow 的步骤渲染成人话，例如「程序员 → 审核员」。 */
  function describeWorkflow(wf) {
    var botsById = {}
    ;(state.bots || []).forEach(function (b) { botsById[b.id] = b.name })
    var ordered = (wf.steps || []).slice().sort(function (a, b) { return a.order - b.order })
    return ordered.map(function (st) {
      if (!st.workerBotId) return '（等用户决策）'
      return botsById[st.workerBotId] || st.workerBotId
    }).join(' → ')
  }

  var hasWs = state.hasWorkspace

  return createElement('div', { style: panelStyle },
    createElement('div', { style: headerStyle },
      createElement('div', { style: titleStyle }, 'AI 员工'),
      createElement('div', { style: { fontSize: '11px', color: '#888' } },
        hasWs ? (state.workspace ? state.workspace.name : '') : '尚未建项目'),
    ),

    error ? createElement('div', { style: errorStyle }, error) : null,

    // 对话式入口提示：告诉用户"跟 AI 助手说"这条路怎么走
    createElement('div', { style: chatHintStyle },
      createElement('div', { style: { fontWeight: 600 } }, '💬 想对话式搭团队？'),
      createElement('div', { style: { marginTop: '3px' } },
        '去中间的主对话窗口，跟 AI 助手说一句，例如：'),
      createElement('div', { style: { marginTop: '3px', fontStyle: 'italic' } },
        '「帮我搭个团队：建个项目、几个员工、一个工作流」'),
      createElement('div', { style: { marginTop: '3px', fontSize: '11px', color: '#5b78a8' } },
        'AI 助手会自动调用本插件的工具把项目 / 员工 / 工作流 / 任务建出来。'),
    ),

    !hasWs
      ? createElement('form', { onSubmit: submitCreateProject, style: { marginTop: '4px' } },
          createElement('div', { style: sectionTitleStyle }, '建项目'),
          createElement('input', {
            type: 'text', placeholder: '项目名（例如：我的项目A）',
            value: projectName, onChange: function (e) { setProjectName(e.target.value) },
            style: inputStyle,
          }),
          createElement('input', {
            type: 'text', placeholder: '项目文件夹绝对路径（例如：/Users/me/projects/myproj）',
            value: projectPath, onChange: function (e) { setProjectPath(e.target.value) },
            style: inputStyle,
          }),
          createElement('button', {
            type: 'submit', disabled: busy,
            style: busy ? buttonDisabledStyle : buttonStyle,
          }, busy ? '处理中…' : '建项目'),
          createElement('div', { style: hintStyle }, '提示：路径必须是一个空目录或不存在；宿主会用 shell 建目录，并在里面建默认的 docs/。'),
        )

      : createElement('div', null,
          createElement('div', { style: sectionTitleStyle }, '当前项目'),
          createElement('div', { style: { fontSize: '13px', wordBreak: 'break-all' } }, state.workspace.name),
          createElement('div', { style: hintStyle }, '路径：' + state.workspace.rootPath),

          createElement('div', { style: sectionTitleStyle }, '员工（' + state.bots.length + '）'),
          state.bots.length === 0
            ? createElement('div', { style: hintStyle }, '还没有员工。用下面"新建员工"从 4 个样板里建。')
            : createElement('div', { style: { marginBottom: '6px' } },
                state.bots.map(function (bot) {
                  var isSelected = selectedBot && selectedBot.id === bot.id
                  // name 和 role 相同时只显示一次（v1 用样板默认名后两者总相等）
                  var chipLabel = bot.name === bot.role ? bot.name : (bot.name + ' · ' + bot.role)
                  return createElement('span', {
                    key: bot.id,
                    style: Object.assign({}, chipStyle, isSelected ? { background: '#dbe7ff', borderColor: '#2b6cff' } : {}),
                    onClick: function () { setSelectedBot(isSelected ? null : bot) },
                    title: bot.description,
                  }, chipLabel)
                }),
              ),

          selectedBot
            ? createElement('div', { style: detailBoxStyle },
                createElement('div', { style: { fontWeight: 600 } },
                  selectedBot.name === selectedBot.role
                    ? selectedBot.name
                    : (selectedBot.name + '（' + selectedBot.role + '）')),
                createElement('div', { style: { marginTop: '4px' } }, selectedBot.description),
                createElement('div', { style: { marginTop: '6px', color: '#666' } }, '工作规则：'),
                createElement('ul', { style: { margin: '4px 0', paddingLeft: '18px' } },
                  (selectedBot.workingRules || []).map(function (r, i) {
                    return createElement('li', { key: i }, r)
                  }),
                ),
                createElement('div', { style: { marginTop: '6px', color: '#666' } }, '系统提示词摘要：'),
                createElement('div', { style: codeStyle },
                  (selectedBot.systemPrompt || '').length > 200
                    ? selectedBot.systemPrompt.slice(0, 200) + '…'
                    : selectedBot.systemPrompt),
                createElement('div', { style: Object.assign({}, hintStyle, { marginTop: '8px' }) },
                  'v1 暂未开放私聊界面。请用主对话输入"@' + selectedBot.role + ' ..."来与该员工协作。'),
              )
            : null,

          createElement('form', { onSubmit: submitCreateBot, style: { marginTop: '10px' } },
            createElement('div', { style: sectionTitleStyle }, '新建员工'),
            createElement('select', {
              value: botTemplate, onChange: function (e) { setBotTemplate(e.target.value) },
              style: selectStyle,
            },
              createElement('option', { value: 'advisor' }, '总顾问（默认推荐）'),
              createElement('option', { value: 'programmer' }, '程序员'),
              createElement('option', { value: 'reviewer' }, '审核员'),
              createElement('option', { value: 'researcher' }, '情报员'),
            ),
            createElement('button', {
              type: 'submit', disabled: busy,
              style: busy ? buttonDisabledStyle : buttonStyle,
            }, busy ? '处理中…' : '新建员工'),
            createElement('div', { style: hintStyle }, '员工名 = 样板默认名（总顾问/程序员/审核员/情报员）。改名留 Phase 2 编辑功能。'),
          ),

          // ---------------- 工作流区 ----------------
          createElement('div', { style: sectionTitleStyle },
            '工作流（' + (state.workflows || []).length + '）'),

          (state.workflows || []).length === 0
            ? createElement('div', { style: hintStyle }, '还没有工作流。建一个，员工做完就会自动交给下一棒。')
            : createElement('div', { style: { marginBottom: '6px' } },
                state.workflows.map(function (wf) {
                  var open = wfDetail && wfDetail.id === wf.id
                  return createElement('div', {
                    key: wf.id,
                    style: Object.assign({}, chipStyle, { display: 'block', borderRadius: '6px', padding: '6px 9px' },
                      open ? { background: '#dbe7ff', borderColor: '#2b6cff' } : {}),
                    onClick: function () { setWfDetail(open ? null : wf) },
                    title: '点击查看步骤详情',
                  },
                    createElement('div', { style: { fontWeight: 600, fontSize: '12px' } }, wf.name),
                    createElement('div', { style: { fontSize: '11.5px', color: '#555', marginTop: '2px' } },
                      describeWorkflow(wf)),
                    open
                      ? createElement('div', { style: { marginTop: '5px', fontSize: '11.5px', color: '#666' } },
                          (wf.steps || []).slice().sort(function (a, b) { return a.order - b.order }).map(function (st) {
                            return createElement('div', { key: st.id },
                              '· 步骤 ' + st.order + '：' + st.id +
                              (st.workerBotId ? '（员工 ' + st.workerBotId + '）' : '（等用户决策）') +
                              (st.nextStepId ? ' → ' + st.nextStepId : ' → 结束'))
                          }),
                          createElement('div', { style: Object.assign({}, hintStyle, { marginTop: '4px' }) },
                            'ID: ' + wf.id),
                        )
                      : null,
                  )
                }),
              ),

          !wfOpen
            ? createElement('button', {
                type: 'button', disabled: busy || (state.bots || []).length === 0,
                style: busy || (state.bots || []).length === 0 ? buttonDisabledStyle : ghostButtonStyle,
                onClick: function () { setWfOpen(true) },
              }, (state.bots || []).length === 0 ? '先建员工才能建工作流' : '＋ 新建工作流')
            : createElement('form', { onSubmit: submitCreateWorkflow, style: { marginTop: '6px' } },
                createElement('div', { style: sectionTitleStyle }, '新建工作流'),
                createElement('input', {
                  type: 'text', placeholder: '工作流名（例如：开发→审核）',
                  value: wfName, onChange: function (e) { setWfName(e.target.value) },
                  style: inputStyle,
                }),
                createElement('div', { style: { fontSize: '11.5px', color: '#666', marginBottom: '4px' } },
                  '按顺序选每一步由谁来做（最后一棒做完流程结束）：'),
                wfSteps.map(function (chosen, idx) {
                  return createElement('div', { key: idx, style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '5px' } },
                    createElement('span', { style: { fontSize: '11.5px', color: '#888', minWidth: '40px' } },
                      '步骤 ' + (idx + 1)),
                    createElement('select', {
                      value: chosen,
                      onChange: function (e) { setStepBot(idx, e.target.value) },
                      style: Object.assign({}, selectStyle, { marginBottom: '0', flex: '1' }),
                    },
                      createElement('option', { value: '' }, '（等用户决策 / 不指派）'),
                      (state.bots || []).map(function (b) {
                        // name 和 role 相同时只显示一次（v1 用样板默认名后两者总相等）
                        var optLabel = b.name === b.role ? b.name : (b.name + ' · ' + b.role)
                        return createElement('option', { key: b.id, value: b.id }, optLabel)
                      }),
                    ),
                    createElement('button', {
                      type: 'button', onClick: function () { removeStep(idx) },
                      disabled: wfSteps.length <= 1,
                      style: Object.assign({}, ghostButtonStyle, {
                        padding: '2px 7px',
                        color: wfSteps.length <= 1 ? '#bbb' : '#c0392b',
                        borderColor: wfSteps.length <= 1 ? '#ddd' : '#c0392b',
                      }),
                    }, '×'),
                  )
                }),
                createElement('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                  createElement('button', {
                    type: 'submit', disabled: busy,
                    style: busy ? buttonDisabledStyle : buttonStyle,
                  }, busy ? '处理中…' : '新建工作流'),
                  createElement('button', {
                    type: 'button', onClick: addStep, style: ghostButtonStyle,
                  }, '添加步骤'),
                  createElement('button', {
                    type: 'button', onClick: function () { setWfOpen(false); setError(null) },
                    style: Object.assign({}, ghostButtonStyle, { color: '#888', borderColor: '#ccc' }),
                  }, '取消'),
                ),
                createElement('div', { style: hintStyle },
                  '步骤会串成线性链：步骤1 → 步骤2 → … → 结束。选「等用户决策」的步骤不派人，流程会停下等你。'),
              ),
        ),
  )
}

// -------------------- 装配 --------------------
function apply(ctx) {
  var slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('shell.overlay', function () {
    slots.register(
      { name: 'shell.overlay', id: 'ai-employee', label: 'AI 员工' },
      function () { return createElement(AiEmployeePanel) },
    )
  })
}

module.exports = { apply: apply, inject: ['slots'] }
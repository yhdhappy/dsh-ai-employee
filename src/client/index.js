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
  maxHeight: '70vh',
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
  overflow: 'hidden',
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
  var s = useState({ hasWorkspace: false, workspace: null, bots: [] })
  var state = s[0]; var setState = s[1]
  var errS = useState(null); var error = errS[0]; var setError = errS[1]
  var busyS = useState(false); var busy = busyS[0]; var setBusy = busyS[1]

  var projectNameS = useState(''); var projectName = projectNameS[0]; var setProjectName = projectNameS[1]
  var projectPathS = useState(''); var projectPath = projectPathS[0]; var setProjectPath = projectPathS[1]

  var botTemplateS = useState('advisor'); var botTemplate = botTemplateS[0]; var setBotTemplate = botTemplateS[1]

  var selectedBotS = useState(null); var selectedBot = selectedBotS[0]; var setSelectedBot = selectedBotS[1]

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

  var hasWs = state.hasWorkspace

  return createElement('div', { style: panelStyle },
    createElement('div', { style: headerStyle },
      createElement('div', { style: titleStyle }, 'AI 员工'),
      createElement('div', { style: { fontSize: '11px', color: '#888' } },
        hasWs ? (state.workspace ? state.workspace.name : '') : '尚未建项目'),
    ),

    error ? createElement('div', { style: errorStyle }, error) : null,

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
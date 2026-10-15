import http from 'node:http'
import express from 'express'
import { WebSocketServer } from 'ws'
import { compileTraceToWorkflow, getAIConfig } from './ai.ts'
import {
  onTraceUpdated,
  openRecordingBrowser,
  runProjectAutomation,
  stopRecordingBrowser,
} from './playwrightEngine.ts'
import {
  ensureDataDirs,
  loadProjects,
  loadTrace,
  loadWorkflow,
  saveProjects,
  saveWorkflow,
  SCREENSHOTS_DIR,
  updateWorkflowParameters,
} from './store.ts'
import type { Project, RecordingTrace } from './types.ts'

ensureDataDirs()

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/api/screenshots', express.static(SCREENSHOTS_DIR))

// 健康检查
app.get('/api/health', (_req, res) => {
  const aiConfig = getAIConfig()
  res.json({ status: 'ok', hasApiKey: Boolean(aiConfig.apiKey) })
})

// 获取所有项目
app.get('/api/projects', (_req, res) => {
  const projects = loadProjects()
  res.json(projects)
})

// 获取单个项目的完整录制轨迹 JSON (RecordingTrace)
app.get('/api/projects/:id/trace', (req, res) => {
  const { id } = req.params
  const trace = loadTrace(id)
  if (!trace) {
    res.status(404).json({ error: '该任务尚无录制轨迹数据' })
    return
  }
  res.json(trace)
})

// 获取单个项目经大模型清洗后的操作工作流 JSON (OperationWorkflow)
app.get('/api/projects/:id/workflow', (req, res) => {
  const { id } = req.params
  const workflow = loadWorkflow(id)
  if (!workflow) {
    res.status(404).json({ error: '该任务尚未通过大模型生成操作工作流' })
    return
  }
  res.json(workflow)
})

// 更新项目的动态工作流参数 (WorkflowParameter 值)
app.put('/api/projects/:id/parameters', (req, res) => {
  const { id } = req.params
  const { parameters } = req.body as { parameters?: Record<string, string> }
  if (!parameters || typeof parameters !== 'object') {
    res.status(400).json({ error: '参数格式不正确' })
    return
  }

  const updatedWorkflow = updateWorkflowParameters(id, parameters)
  if (!updatedWorkflow) {
    res.status(404).json({ error: '该任务尚未生成操作工作流，无法更新参数' })
    return
  }

  const latestProjects = loadProjects()
  res.json({
    project: latestProjects.find((p) => p.id === id),
    workflow: updatedWorkflow,
  })
})

// 新建项目（默认同时打开内置浏览器空白页面准备录制）
app.post('/api/projects', async (req, res) => {
  const { name, description, autoOpenBrowser = true } = req.body as {
    name?: string
    description?: string
    autoOpenBrowser?: boolean
  }
  if (!name || !name.trim()) {
    res.status(400).json({ error: '任务名称不能为空' })
    return
  }

  const projects = loadProjects()
  const createdId = `proj-${Date.now()}`
  const created: Project = {
    id: createdId,
    name: name.trim(),
    description: description?.trim() || '暂无描述，点击进入配置具体操作流程。',
    stepsCount: 0,
    lastStatus: autoOpenBrowser ? 'recording' : 'idle',
    runs: [],
    traceFile: `data/traces/${createdId}.json`,
  }

  const updated = [created, ...projects]
  saveProjects(updated)

  if (autoOpenBrowser) {
    try {
      await openRecordingBrowser(created.id)
      const allProjects = loadProjects().map((p) => ({
        ...p,
        lastStatus: p.id === created.id ? ('recording' as const) : p.lastStatus === 'recording' ? ('idle' as const) : p.lastStatus,
      }))
      saveProjects(allProjects)
    } catch (err) {
      console.error('Failed to open built-in browser:', err)
      const fallbackProjects = loadProjects().map((p) =>
        p.id === created.id ? { ...p, lastStatus: 'idle' as const } : p
      )
      saveProjects(fallbackProjects)
    }
  }

  const latest = loadProjects().find((p) => p.id === createdId) || created
  res.status(201).json(latest)
})

// 开启某个项目的录制（弹出内置浏览器空白页）
app.post('/api/projects/:id/record/start', async (req, res) => {
  const { id } = req.params
  const projects = loadProjects()
  const target = projects.find((p) => p.id === id)
  if (!target) {
    res.status(404).json({ error: '未找到该任务' })
    return
  }

  try {
    await openRecordingBrowser(id)
    const latestProjects = loadProjects().map((p) => ({
      ...p,
      lastStatus: p.id === id ? ('recording' as const) : p.lastStatus === 'recording' ? ('idle' as const) : p.lastStatus,
    }))
    saveProjects(latestProjects)
    res.json(latestProjects.find((p) => p.id === id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : '打开内置浏览器失败'
    res.status(500).json({ error: msg })
  }
})

// 停止某个项目的录制（若已配置 DEEPSEEK_API_KEY 且有录制事件，自动调用大模型清洗生成操作工作流）
app.post('/api/projects/:id/record/stop', async (req, res) => {
  const { id } = req.params
  const projects = loadProjects()
  const target = projects.find((p) => p.id === id)
  if (!target) {
    res.status(404).json({ error: '未找到该任务' })
    return
  }

  try {
    await stopRecordingBrowser()
    let latestProjects = loadProjects().map((p) =>
      p.id === id ? { ...p, lastStatus: 'idle' as const } : p
    )
    saveProjects(latestProjects)

    const trace = loadTrace(id)
    const aiConfig = getAIConfig()
    if (trace && trace.events.length > 0 && aiConfig.apiKey) {
      try {
        const workflow = await compileTraceToWorkflow(trace)
        saveWorkflow(id, workflow)
        latestProjects = loadProjects()
      } catch (compileErr) {
        console.warn('Auto compile workflow failed:', compileErr)
      }
    }

    res.json(latestProjects.find((p) => p.id === id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : '停止录制失败'
    res.status(500).json({ error: msg })
  }
})

// 删除项目
app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params
  const projects = loadProjects()
  const updated = projects.filter((p) => p.id !== id)
  saveProjects(updated)
  res.json({ success: true })
})

// 触发运行项目工作流或直接复现录制轨迹（支持在请求体中携带本次运行的动态参数）
app.post('/api/projects/:id/run', async (req, res) => {
  const { id } = req.params
  const { parameters } = (req.body || {}) as { parameters?: Record<string, string> }
  const projects = loadProjects()
  const target = projects.find((p) => p.id === id)
  if (!target) {
    res.status(404).json({ error: '未找到该任务' })
    return
  }

  if (parameters && typeof parameters === 'object' && Object.keys(parameters).length > 0) {
    updateWorkflowParameters(id, parameters)
  }

  const latestTarget = loadProjects().find((p) => p.id === id) || target
  const runRecord = await runProjectAutomation(
    id,
    latestTarget.workflow,
    latestTarget.trace,
    parameters
  )
  const latestProjects = loadProjects().map((p) =>
    p.id === id
      ? {
          ...p,
          lastStatus: runRecord.status,
          runs: [runRecord, ...p.runs],
        }
      : p
  )
  saveProjects(latestProjects)

  const updatedProject = latestProjects.find((p) => p.id === id)
  res.json(updatedProject)
})

// 提交录制轨迹并由大模型清洗编译生成操作工作流 (OperationWorkflow)
app.post('/api/projects/:id/compile', async (req, res) => {
  const { id } = req.params
  const trace = (req.body && Object.keys(req.body).length > 0 ? req.body : loadTrace(id)) as RecordingTrace | null
  const projects = loadProjects()
  const target = projects.find((p) => p.id === id)
  if (!target) {
    res.status(404).json({ error: '未找到该任务' })
    return
  }
  if (!trace || !trace.events || trace.events.length === 0) {
    res.status(400).json({ error: '该任务尚无录制轨迹数据，请先录制操作' })
    return
  }

  try {
    const workflow = await compileTraceToWorkflow(trace)
    saveWorkflow(id, workflow)
    const latestProjects = loadProjects()
    res.json({
      project: latestProjects.find((p) => p.id === id),
      workflow,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : '大模型编译工作流失败'
    res.status(500).json({ error: msg })
  }
})

const server = http.createServer(app)

// WebSocket 通道：实时推送录制到的每一个动作与最新步骤数
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', message: '已连接至本地自动化后端服务' }))
})

onTraceUpdated((projectId, trace, latestEvent) => {
  const payload = JSON.stringify({
    type: 'trace_updated',
    projectId,
    stepsCount: trace.events.length,
    latestEvent,
  })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload)
    }
  }
})

const PORT = Number(process.env.PORT || 3001)
server.listen(PORT, () => {
  console.log(`Backend server listening on http://localhost:${PORT}`)
})

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, ServerMessage } from '../../shared/types.ts'
import * as api from '../api/client.ts'

/** 卡片上展示的运行进度（来自 WS 的 run_started / run_progress） */
export interface RunProgress {
  runId: string
  stepIndex: number
  totalSteps: number
  title?: string
  status: 'running' | 'success' | 'failed'
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** 后端不可用时的兜底展示数据（纯 UI 演示用，不写回后端） */
const FALLBACK_PROJECTS: Project[] = [
  {
    id: 'proj-1',
    name: '人事入职审批单自动填报',
    description: '打开内部人事系统，筛选待办入职申请，自动核对部门信息并点击审批通过。',
    stepsCount: 6,
    lastStatus: 'success',
    runs: [
      {
        id: 'r-102',
        time: '今天 18:45',
        status: 'success',
        duration: '12.4 秒',
        note: '已处理 5 条入职审批单',
      },
      {
        id: 'r-101',
        time: '昨天 09:30',
        status: 'success',
        duration: '14.1 秒',
        note: '已处理 8 条入职审批单',
      },
    ],
  },
]

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>(FALLBACK_PROJECTS)
  const [runProgress, setRunProgress] = useState<Record<string, RunProgress>>({})
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [error, setError] = useState<string | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const errorTimerRef = useRef<number | undefined>(undefined)

  const dismissError = useCallback(() => setError(null), [])

  const reportError = useCallback((err: unknown, fallback: string) => {
    const message = err instanceof Error && err.message ? err.message : fallback
    setError(message)
    window.clearTimeout(errorTimerRef.current)
    errorTimerRef.current = window.setTimeout(() => setError(null), 4500)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await api.fetchProjects()
      setProjects(data)
    } catch {
      // 后端尚未就绪时保留本地默认列表
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .fetchProjects()
      .then((data) => {
        if (!cancelled) setProjects(data)
      })
      .catch(() => {
        // 后端尚未就绪时保留本地默认列表
      })
    return () => {
      cancelled = true
    }
  }, [])

  // WebSocket：订阅录制进度与运行进度，断线自动重连并重新拉一次列表
  useEffect(() => {
    let disposed = false
    let reconnectTimer: number | undefined
    let attempts = 0

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case 'trace_updated':
          setProjects((prev) =>
            prev.map((p) =>
              p.id === message.projectId ? { ...p, stepsCount: message.stepsCount } : p
            )
          )
          break
        case 'run_started':
          setProjects((prev) =>
            prev.map((p) => (p.id === message.projectId ? { ...p, lastStatus: 'running' } : p))
          )
          setRunProgress((prev) => ({
            ...prev,
            [message.projectId]: {
              runId: message.runId,
              stepIndex: 0,
              totalSteps: message.totalSteps,
              status: 'running',
            },
          }))
          break
        case 'run_progress':
          setRunProgress((prev) => ({
            ...prev,
            [message.projectId]: {
              runId: message.runId,
              stepIndex: message.stepIndex,
              totalSteps: message.totalSteps,
              title: message.title,
              status: message.status,
            },
          }))
          break
        case 'run_finished':
          setProjects((prev) =>
            prev.map((p) => (p.id === message.projectId ? message.project : p))
          )
          setRunProgress((prev) => {
            const next = { ...prev }
            delete next[message.projectId]
            return next
          })
          if (message.runRecord.status === 'failed') {
            reportError(message.runRecord.note, '自动化执行失败')
          }
          break
        default:
          break
      }
    }

    const connect = () => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`)
      socketRef.current = socket

      socket.onopen = () => {
        attempts = 0
        setConnectionState('open')
        // 断线期间可能错过消息，重连成功后补拉一次任务列表
        void refresh()
      }
      socket.onmessage = (event) => {
        try {
          handleMessage(JSON.parse(event.data as string) as ServerMessage)
        } catch {
          // 忽略非法消息
        }
      }
      socket.onclose = () => {
        socketRef.current = null
        if (disposed) return
        setConnectionState('closed')
        attempts += 1
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * attempts, 5000))
      }
      socket.onerror = () => socket.close()
    }

    connect()

    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
    }
  }, [refresh, reportError])

  useEffect(() => {
    return () => window.clearTimeout(errorTimerRef.current)
  }, [])

  const createProject = useCallback(async (name: string, description: string) => {
    const created = await api.createProject({ name, description, autoOpenBrowser: true })
    setProjects((prev) => [created, ...prev])
  }, [])

  const removeProject = useCallback(
    async (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id))
      try {
        await api.deleteProject(id)
      } catch (err) {
        reportError(err, '删除任务失败')
        void refresh()
      }
    },
    [refresh, reportError]
  )

  const toggleRecording = useCallback(
    async (project: Project) => {
      const isRecording = project.lastStatus === 'recording'
      try {
        const updated = isRecording
          ? await api.stopRecording(project.id)
          : await api.startRecording(project.id)
        setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
      } catch (err) {
        reportError(err, isRecording ? '结束录制失败' : '启动录制失败')
      }
    },
    [reportError]
  )

  const runProject = useCallback(
    async (id: string, parameters?: Record<string, string>) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, lastStatus: 'running' } : p))
      )
      try {
        const accepted = await api.runProject(id, parameters)
        setRunProgress((prev) => ({
          ...prev,
          [id]: {
            runId: accepted.runId,
            stepIndex: 0,
            totalSteps: accepted.totalSteps,
            status: 'running',
          },
        }))
      } catch (err) {
        setProjects((prev) =>
          prev.map((p) => (p.id === id ? { ...p, lastStatus: 'idle' } : p))
        )
        reportError(err, '启动运行失败')
      }
    },
    [reportError]
  )

  const applyProject = useCallback((updated: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
  }, [])

  return {
    projects,
    runProgress,
    connectionState,
    error,
    dismissError,
    refresh,
    createProject,
    removeProject,
    toggleRecording,
    runProject,
    applyProject,
  }
}

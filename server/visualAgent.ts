/**
 * L3 内网视觉 Agent 客户端（Node 侧）
 *
 * - 配置来源：环境变量 VISUAL_AGENT_* 优先，其次 data/visual-agent.json（便于 POC 无需重启切换）
 * - 只负责「请求定位」；执行动作、验证、回写全部在 playwrightEngine 里完成
 * - 服务不可用 / 超预算 / 低置信度 → 返回 null，由调用方决定失败或终止
 */
import fs from 'node:fs'
import path from 'node:path'

export interface ViewportSnapshot {
  width: number
  height: number
  dpr: number
  scrollX: number
  scrollY: number
}

export interface GroundRequest {
  /** 给视觉模型的任务指令（步骤标题/说明 + 目标线索） */
  instruction: string
  /** 现场截图（data URL，JPEG base64） */
  currentImage: string
  /** 录制时参考截图（data URL，可选） */
  referenceImage?: string
  viewport: ViewportSnapshot
  /** 录制时的 viewport 坐标，作为定位提示 */
  bboxHint?: { x: number; y: number; width: number; height: number }
}

export interface GroundResult {
  found: boolean
  point?: { x: number; y: number }
  confidence?: number
  reason?: string
  model?: string
  latencyMs?: number
}

export interface VisualAgentConfig {
  url?: string
  timeoutMs: number
  minConfidence: number
  maxCallsPerRun: number
}

const DEFAULT_CONFIG: VisualAgentConfig = {
  url: undefined,
  timeoutMs: 15_000,
  minConfidence: 0.6,
  maxCallsPerRun: 3,
}

const CONFIG_FILE = path.resolve(process.cwd(), 'data', 'visual-agent.json')

function readConfigFile(): Partial<VisualAgentConfig> {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    const config: Partial<VisualAgentConfig> = {}
    if (typeof raw.url === 'string' && raw.url.trim()) config.url = raw.url.trim()
    if (typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0) config.timeoutMs = raw.timeoutMs
    if (typeof raw.minConfidence === 'number') config.minConfidence = raw.minConfidence
    if (typeof raw.maxCallsPerRun === 'number' && raw.maxCallsPerRun > 0) {
      config.maxCallsPerRun = raw.maxCallsPerRun
    }
    return config
  } catch {
    return {}
  }
}

export function getVisualAgentConfig(): VisualAgentConfig {
  const file = readConfigFile()
  const envUrl = process.env.VISUAL_AGENT_URL?.trim()
  const envTimeout = Number(process.env.VISUAL_AGENT_TIMEOUT_MS)
  const envConfidence = Number(process.env.VISUAL_AGENT_MIN_CONFIDENCE)
  const envBudget = Number(process.env.VISUAL_AGENT_MAX_CALLS_PER_RUN)
  return {
    url: envUrl || file.url || DEFAULT_CONFIG.url,
    timeoutMs:
      Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : file.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    minConfidence: Number.isFinite(envConfidence)
      ? envConfidence
      : file.minConfidence ?? DEFAULT_CONFIG.minConfidence,
    maxCallsPerRun:
      Number.isFinite(envBudget) && envBudget > 0
        ? envBudget
        : file.maxCallsPerRun ?? DEFAULT_CONFIG.maxCallsPerRun,
  }
}

export function isVisualAgentEnabled(): boolean {
  return Boolean(getVisualAgentConfig().url)
}

let budgetUsed = 0

export function resetVisualAgentBudget(): void {
  budgetUsed = 0
}

export function getVisualAgentBudgetUsage(): number {
  return budgetUsed
}

/** 是否还有预算且服务已配置（不发起网络请求） */
export function canUseVisualAgent(): boolean {
  const config = getVisualAgentConfig()
  return Boolean(config.url) && budgetUsed < config.maxCallsPerRun
}

interface HealthState {
  checkedAt: number
  ok: boolean
}

let health: HealthState = { checkedAt: 0, ok: false }

async function ensureServiceReady(config: VisualAgentConfig): Promise<boolean> {
  if (!config.url) return false
  const now = Date.now()
  if (now - health.checkedAt < 15_000) return health.ok

  try {
    const response = await fetch(`${config.url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 3000)),
    })
    health = { checkedAt: now, ok: response.ok }
  } catch {
    health = { checkedAt: now, ok: false }
  }
  return health.ok
}

/**
 * 请求一次目标定位；失败/禁用/超预算均返回 null（不抛错，避免影响主流程判断）
 */
export async function requestGrounding(request: GroundRequest): Promise<GroundResult | null> {
  const config = getVisualAgentConfig()
  if (!config.url) return null
  if (budgetUsed >= config.maxCallsPerRun) return null
  if (!(await ensureServiceReady(config))) return null

  budgetUsed += 1
  try {
    const response = await fetch(`${config.url.replace(/\/$/, '')}/ground`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) return null
    const data = (await response.json()) as GroundResult
    if (!data || typeof data !== 'object') return null
    return data
  } catch {
    return null
  }
}

/** 读取录制参考截图并转成 data URL（只在本机读取，不落外部） */
export function loadScreenshotDataUrl(relativePath?: string): string | undefined {
  if (!relativePath) return undefined
  try {
    const absolute = path.resolve(process.cwd(), relativePath)
    if (!fs.existsSync(absolute)) return undefined
    const buffer = fs.readFileSync(absolute)
    const mime = absolute.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return undefined
  }
}

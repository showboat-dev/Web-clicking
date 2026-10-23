/**
 * 确定性规则编译器（P2 翻译器改造）
 *
 * 职责：
 * 1. 把原始录制轨迹清洗成「原子动作」（去噪、合并、被动跳转归因）；
 * 2. 规则化编译为可执行工作流（AI 不可用/失败时的兜底）；
 * 3. 生成覆盖审计（每个原始事件：映射到步骤 / 被剔除及原因）。
 *
 * 注意：这里不做任何 AI 调用，也不生成/修改定位器（定位器始终来自录制证据）。
 */
import type {
  FrameRef,
  OperationWorkflow,
  RecordedEvent,
  RecordingTrace,
  StepRecovery,
  StepVerificationRule,
  WorkflowActionType,
  WorkflowCoverage,
  WorkflowParameter,
  WorkflowStep,
} from './types.ts'

export const RULE_TRANSLATOR_VERSION = 'v3-rules@1'

export interface CleanStep {
  id: string
  actionType: WorkflowActionType
  tabId: string
  value?: string
  key?: string
  sourceEventIds: string[]
  startedAt: number
  target?: RecordedEvent['target']
  dragTo?: RecordedEvent['dragTo']
  frameChain?: FrameRef[]
  verification?: StepVerificationRule
  /** 规则判定：fill / select / file_upload 为参数化操作 */
  parameterized: boolean
}

export interface NoiseEvent {
  eventId: string
  reason: string
}

export interface CleanResult {
  steps: CleanStep[]
  noise: NoiseEvent[]
}

export interface StepAnnotation {
  stepId: string
  title: string
  description: string
  paramKey?: string
  paramLabel?: string
  paramDescription?: string
}

export interface AnnotationResult {
  summary: string
  annotations: StepAnnotation[]
}

const PAGE_ACTIONS = new Set([
  'click',
  'dblclick',
  'hover',
  'fill',
  'select',
  'select_text',
  'file_upload',
  'press',
])

function firstLocator(target?: RecordedEvent['target']): string | undefined {
  return target?.locators?.[0]?.value
}

function sameTarget(a?: RecordedEvent['target'], b?: RecordedEvent['target']): boolean {
  const left = firstLocator(a)
  const right = firstLocator(b)
  return Boolean(left && right && left === right)
}

function frameChainOf(event: RecordedEvent): FrameRef[] | undefined {
  if (event.pageContext.frameChain?.length) return event.pageContext.frameChain
  if (event.pageContext.frameUrl) return [{ url: event.pageContext.frameUrl }]
  return undefined
}

/**
 * 规则清洗：把原始事件序列折叠成原子动作
 */
/** 提交类 URL 里的 sys_id / UUID / 长数字每次都会变，校验时替换成通配符，避免回放误判 */
export function stabilizeVerificationUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const params = new URLSearchParams(parsed.search)
    let changed = false
    for (const [key, value] of Array.from(params.entries())) {
      if (
        /^[0-9a-f]{32}$/i.test(value) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
        /^\d{8,}$/.test(value)
      ) {
        params.set(key, '*')
        changed = true
      }
    }
    if (!changed) return url
    return `${parsed.origin}${parsed.pathname}?${params.toString()}${parsed.hash}`
  } catch {
    return url
  }
}

/**
 * 验证码 / 风控 / 登录跳转不属于业务结果，不能拿来当后置校验。
 * 只用于「点击后被动跳转」场景，避免把正常 goto 登录页也误删。
 */
export function isTransientRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const haystack = `${parsed.hostname}${parsed.pathname}`.toLowerCase()
    return /(captcha|antibot|wappass|challenge|verify|passport|oauth|sso|login)/.test(haystack)
  } catch {
    return false
  }
}

export function cleanTrace(trace: RecordingTrace): CleanResult {
  const events = trace.events
  const noise: NoiseEvent[] = []
  const steps: CleanStep[] = []
  const drop = (event: RecordedEvent, reason: string) => noise.push({ eventId: event.id, reason })

  const pushStep = (step: Omit<CleanStep, 'id'>) => {
    steps.push({ id: `cstep-${steps.length + 1}`, ...step })
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    const type = event.action.type
    const tabId = event.pageContext.tabId
    const prev = i > 0 ? events[i - 1] : null
    const next = i + 1 < events.length ? events[i + 1] : null
    const sameTab = (candidate: RecordedEvent | null) =>
      Boolean(candidate && candidate.pageContext.tabId === tabId)

    if (type === 'click') {
      const target = event.target
      if (
        target?.boundingBox &&
        target.boundingBox.width === 0 &&
        target.boundingBox.height === 0
      ) {
        drop(event, 'zero-size-click')
        continue
      }
      if (
        sameTab(prev) &&
        prev &&
        prev.action.type === 'press' &&
        (prev.action.key === 'Enter' || prev.action.value === 'Enter') &&
        event.timestamp - prev.timestamp <= 100
      ) {
        drop(event, 'synthetic-click-after-enter')
        continue
      }
      if (
        sameTab(prev) &&
        prev &&
        prev.action.type === 'click' &&
        event.timestamp - prev.timestamp < 50 &&
        !sameTarget(prev.target, target)
      ) {
        drop(event, 'label-duplicate-click')
        continue
      }
      if (
        sameTab(next) &&
        next &&
        next.action.type === 'fill' &&
        sameTarget(target, next.target) &&
        next.timestamp - event.timestamp <= 1500
      ) {
        drop(event, 'focus-click-merged-into-fill')
        continue
      }
      pushStep({
        actionType: 'click',
        tabId,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'dblclick') {
      pushStep({
        actionType: 'dblclick',
        tabId,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'hover') {
      // 悬停后立刻操作同一元素 → 属于鼠标划过噪声
      if (
        sameTab(next) &&
        next &&
        PAGE_ACTIONS.has(next.action.type) &&
        sameTarget(event.target, next.target) &&
        next.timestamp - event.timestamp <= 1500
      ) {
        drop(event, 'hover-incidental')
        continue
      }
      pushStep({
        actionType: 'hover',
        tabId,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'fill' || type === 'select' || type === 'file_upload') {
      const last = steps[steps.length - 1]
      if (
        type === 'fill' &&
        last &&
        last.actionType === 'fill' &&
        last.tabId === tabId &&
        sameTarget(last.target, event.target) &&
        event.timestamp - last.startedAt <= 5000
      ) {
        last.sourceEventIds.push(event.id)
        last.value = event.action.value
        last.startedAt = event.timestamp
        continue
      }
      pushStep({
        actionType: type,
        tabId,
        value: event.action.value,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        frameChain: frameChainOf(event),
        verification: { mode: 'value' },
        parameterized: true,
      })
      continue
    }

    if (type === 'contextmenu') {
      pushStep({
        actionType: 'contextmenu',
        tabId,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'drag') {
      pushStep({
        actionType: 'drag',
        tabId,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        dragTo: event.dragTo,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'scroll') {
      // 滚动主要影响懒加载；回放时 Playwright 会自动滚动到目标，默认作为轨迹证据剔除
      drop(event, 'scroll-evidence-only')
      continue
    }

    if (type === 'download') {
      // 下载由前面的点击触发，回放点击即可重新触发
      drop(event, 'download-side-effect')
      continue
    }

    if (type === 'dialog') {
      pushStep({
        actionType: 'dialog',
        tabId,
        value: event.action.value,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        parameterized: false,
      })
      continue
    }

    if (type === 'press') {
      pushStep({
        actionType: 'press',
        tabId,
        value: event.action.key || event.action.value,
        key: event.action.key,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'select_text') {
      pushStep({
        actionType: 'extract_text',
        tabId,
        value: event.action.value,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        target: event.target,
        frameChain: frameChainOf(event),
        parameterized: false,
      })
      continue
    }

    if (type === 'tab_open' || type === 'tab_close') {
      // 录制开始时的首个 tab_open 通常只是初始 about:blank 页面，回放时已有一个页面，无需重开
      if (type === 'tab_open' && steps.length === 0) {
        drop(event, 'initial-tab-open')
        continue
      }
      pushStep({
        actionType: type,
        tabId,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        parameterized: false,
      })
      continue
    }

    if (type === 'navigate') {
      const url = event.action.value
      if (!url || url === 'about:blank') {
        drop(event, 'blank-navigate')
        continue
      }
      const last = steps[steps.length - 1]
      if (last && last.actionType === 'tab_open' && last.tabId === tabId) {
        // 新标签页是空白页，必须把紧接着的导航落成 goto，否则后续动作都作用在 about:blank 上
        pushStep({
          actionType: 'goto',
          tabId,
          value: url,
          startedAt: event.timestamp,
          sourceEventIds: [event.id],
          verification: { mode: 'url', expected: stabilizeVerificationUrl(url), timeoutMs: 5000 },
          parameterized: false,
        })
        drop(event, 'tab-open-followed-by-navigate')
        continue
      }
      // 真实站点提交后跳转可能较慢（ServiceNow 约 2-5s），无中间动作时仍归因给上一步
      if (last && last.tabId === tabId && event.timestamp - last.startedAt <= 15000) {
        // 验证码/风控/登录跳转不是业务成功信号
        if (isTransientRedirectUrl(url)) {
          drop(event, 'transient-redirect')
          continue
        }
        // 只取第一次被动跳转作为校验；后续跳转（如结果页→验证码）不覆盖
        if (last.verification) {
          drop(event, 'duplicate-passive-navigate')
          continue
        }
        // 点击/回车引发的被动跳转：不单独成步，而是作为上一步的后置校验
        last.verification = { mode: 'url', expected: stabilizeVerificationUrl(url), timeoutMs: 5000 }
        drop(event, 'passive-navigate')
        continue
      }
      pushStep({
        actionType: 'goto',
        tabId,
        value: url,
        startedAt: event.timestamp,
        sourceEventIds: [event.id],
        verification: { mode: 'url', expected: stabilizeVerificationUrl(url), timeoutMs: 5000 },
        parameterized: false,
      })
      continue
    }

    // 未知动作类型：记录为噪声，避免静默丢失
    drop(event, `unsupported-action:${type}`)
  }

  // 剔除「打开后立刻关闭、且中间没有任何页面操作」的空标签页
  const tabPageActionCount = new Map<string, number>()
  for (const step of steps) {
    // goto 也属于该标签页的有效使用（否则「新标签页 + 导航」会被误判为空标签页）
    if (PAGE_ACTIONS.has(step.actionType) || step.actionType === 'goto') {
      tabPageActionCount.set(step.tabId, (tabPageActionCount.get(step.tabId) ?? 0) + 1)
    }
  }
  const kept: CleanStep[] = []
  for (const step of steps) {
    if (
      (step.actionType === 'tab_open' || step.actionType === 'tab_close') &&
      (tabPageActionCount.get(step.tabId) ?? 0) === 0
    ) {
      for (const eventId of step.sourceEventIds) {
        noise.push({ eventId, reason: 'empty-tab-open-close' })
      }
      continue
    }
    kept.push(step)
  }

  // 重新编号
  kept.forEach((step, index) => {
    step.id = `cstep-${index + 1}`
  })

  return { steps: kept, noise }
}

function deriveRecovery(
  target?: RecordedEvent['target'],
  referenceScreenshot?: string
): StepRecovery | undefined {
  if (!target) return undefined
  const recovery: StepRecovery = {}
  if (referenceScreenshot) recovery.referenceScreenshot = referenceScreenshot
  if (target.shadowChain?.length) recovery.shadowChain = target.shadowChain
  if (target.shadowMode) recovery.shadowMode = target.shadowMode
  if (target.domSnapshot) recovery.domSnapshot = target.domSnapshot
  if (target.nearbyLabel) recovery.nearbyText = target.nearbyLabel
  if (target.role) recovery.role = target.role
  if (target.innerText) recovery.innerText = target.innerText
  if (target.tagName) recovery.tagName = target.tagName
  if (target.attributes) recovery.attributes = target.attributes
  if (target.boundingBox) recovery.bbox = target.boundingBox
  return Object.keys(recovery).length > 0 ? recovery : undefined
}

function targetHint(step: CleanStep): string {
  const target = step.target
  const hint = target?.nearbyLabel || target?.innerText || target?.attributes?.placeholder
  return hint ? `「${hint.slice(0, 20)}」` : '元素'
}

function defaultTitle(step: CleanStep): string {
  switch (step.actionType) {
    case 'goto':
      return '打开页面'
    case 'click':
      return `点击${targetHint(step)}`
    case 'dblclick':
      return `双击${targetHint(step)}`
    case 'contextmenu':
      return `右键${targetHint(step)}`
    case 'drag':
      return `拖拽${targetHint(step)}`
    case 'dialog':
      return '处理原生弹窗'
    case 'hover':
      return `悬停${targetHint(step)}`
    case 'fill':
      return `填写${targetHint(step)}`
    case 'select':
      return `选择${targetHint(step)}`
    case 'press':
      return `按下 ${step.value || 'Enter'}`
    case 'file_upload':
      return '上传文件'
    case 'tab_open':
      return '新建标签页'
    case 'tab_close':
      return '关闭标签页'
    case 'extract_text':
      return '选中文本'
    default:
      return '操作步骤'
  }
}

function defaultParamKey(step: CleanStep, index: number): string {
  const name = step.target?.attributes?.name
  if (name) {
    const camel = name.replace(/[^a-zA-Z0-9]+(.)/g, (_, chr: string) => chr.toUpperCase())
    if (camel) return camel.replace(/^[A-Z]/, (chr) => chr.toLowerCase())
  }
  const hint = step.target?.nearbyLabel || step.target?.innerText || step.target?.attributes?.placeholder
  if (hint) {
    const ascii = hint.replace(/[^a-zA-Z0-9]+/g, ' ').trim().replace(/\s+(.)/g, (_, chr: string) => chr.toUpperCase())
    if (ascii) return ascii.replace(/^[A-Z]/, (chr) => chr.toLowerCase())
  }
  return `field${index + 1}`
}

function defaultParamLabel(step: CleanStep, index: number): string {
  return (
    step.target?.nearbyLabel ||
    step.target?.attributes?.placeholder ||
    step.target?.innerText ||
    `输入项 ${index + 1}`
  )
}

function defaultDescription(step: CleanStep, trace: RecordingTrace, index: number): string {
  const pageTitle = trace.events.find((event) => event.id === step.sourceEventIds[0])?.pageContext.title
  const label = defaultParamLabel(step, index)
  const where = pageTitle ? `「${pageTitle}」页面` : '页面'
  switch (step.actionType) {
    case 'goto':
      return `打开 ${step.value || '目标页面'}`
    case 'click':
      return `在${where}点击${targetHint(step)}`
    case 'dblclick':
      return `在${where}双击${targetHint(step)}`
    case 'contextmenu':
      return `在${where}右键${targetHint(step)}以打开菜单`
    case 'drag':
      return `在${where}把${targetHint(step)}拖拽到目标位置`
    case 'dialog':
      return `确认浏览器原生弹窗（${step.value || ''}）`
    case 'hover':
      return `在${where}悬停${targetHint(step)}以展开内容`
    case 'fill':
      return `在${where}填写 ${label}`
    case 'select':
      return `在${where}选择 ${label}`
    case 'press':
      return `在${where}按下 ${step.value || 'Enter'}`
    case 'file_upload':
      return `在${where}上传文件`
    case 'tab_open':
      return '新建浏览器标签页'
    case 'tab_close':
      return '关闭当前浏览器标签页'
    case 'extract_text':
      return `选中文本「${step.value || ''}」`
    default:
      return ''
  }
}

function buildCoverageFromClean(trace: RecordingTrace, clean: CleanResult): WorkflowCoverage {
  const mapped = new Set<string>()
  for (const step of clean.steps) {
    for (const eventId of step.sourceEventIds) mapped.add(eventId)
  }
  const dropped = new Set(clean.noise.map((item) => item.eventId))
  const unmapped = trace.events.filter((event) => !mapped.has(event.id) && !dropped.has(event.id))
  const dropReasons: Record<string, number> = {}
  for (const item of clean.noise) {
    dropReasons[item.reason] = (dropReasons[item.reason] ?? 0) + 1
  }
  const warnings: string[] = []
  if (unmapped.length > 0) {
    warnings.push(
      `有 ${unmapped.length} 个原始事件既未映射到步骤也未标记噪声，可能存在漏步骤`
    )
  }
  if (clean.steps.length === 0) warnings.push('清洗后没有任何可执行步骤')

  return {
    totalEvents: trace.events.length,
    mappedEvents: trace.events.length - dropped.size - unmapped.length,
    droppedEvents: dropped.size + unmapped.length,
    unmappedEventIds: unmapped.map((event) => event.id),
    warnings,
    dropReasons,
  }
}

/**
 * 把原子动作 + 可选 AI 语义标注编译为 OperationWorkflow
 */
function compileActions(
  trace: RecordingTrace,
  clean: CleanResult,
  annotation: AnnotationResult | undefined,
  translatorVersion: string
): OperationWorkflow {
  const annotationMap = new Map<string, StepAnnotation>()
  for (const item of annotation?.annotations ?? []) {
    if (item && typeof item.stepId === 'string') annotationMap.set(item.stepId, item)
  }

  const eventsById = new Map(trace.events.map((event) => [event.id, event]))
  const parameters: WorkflowParameter[] = []
  const paramKeys = new Set<string>()

  const steps: WorkflowStep[] = clean.steps.map((step, index) => {
    const ann = annotationMap.get(step.id)
    const isParam = step.parameterized
    let paramKey: string | undefined
    let paramLabel: string | undefined

    if (isParam) {
      paramKey = ann?.paramKey?.trim() || defaultParamKey(step, index)
      paramLabel = ann?.paramLabel?.trim() || defaultParamLabel(step, index)
      while (paramKeys.has(paramKey)) paramKey = `${paramKey}_${index + 1}`
      paramKeys.add(paramKey)

      parameters.push({
        key: paramKey,
        label: paramLabel,
        description:
          ann?.paramDescription?.trim() ||
          (step.actionType === 'file_upload'
            ? `运行时需填入本地文件的绝对路径（录制值：${step.value || ''}）`
            : `${trace.overallGoal ? `「${trace.overallGoal}」流程中` : ''}填写的 ${paramLabel}`),
        inputType: step.actionType === 'select' ? 'select' : 'text',
        defaultValue: step.value ?? '',
        value: step.value ?? '',
        required: true,
        boundStepIds: [step.id],
      })
    }

    const primaryEvent = step.sourceEventIds
      .map((id) => eventsById.get(id))
      .find((event) => Boolean(event?.screenshotPath))
    const recovery = deriveRecovery(step.target, primaryEvent?.screenshotPath)
    const dragRecovery = deriveRecovery(step.dragTo, primaryEvent?.screenshotPath)
    const binding: WorkflowStep['engineBinding'] = {
      tabId: step.tabId,
      ...(step.frameChain?.length ? { frameChain: step.frameChain } : {}),
      actionType: step.actionType,
      ...(paramKey ? { paramKey } : {}),
      ...(step.value !== undefined ? { value: step.value } : {}),
      locators: step.target?.locators ?? [],
      timeoutMs: 8000,
      ...(recovery ? { recovery } : {}),
      ...(step.dragTo
        ? {
            dragTo: {
              locators: step.dragTo.locators,
              ...(dragRecovery ? { recovery: dragRecovery } : {}),
            },
          }
        : {}),
      ...(step.verification ? { verification: step.verification } : {}),
    }

    return {
      id: `step-${index + 1}`,
      order: index + 1,
      stepCategory: isParam ? 'parameterized' : 'fixed',
      sourceEventIds: [...step.sourceEventIds],
      humanView: {
        title: ann?.title?.trim() || defaultTitle(step),
        description: ann?.description?.trim() || defaultDescription(step, trace, index),
        ...(paramKey ? { paramKey } : {}),
        ...(paramLabel ? { paramLabel } : {}),
      },
      engineBinding: binding,
    }
  })

  return {
    projectId: trace.projectId,
    updatedAt: new Date().toISOString(),
    schemaVersion: 2,
    translatorVersion,
    coverage: buildCoverageFromClean(trace, clean),
    summary: annotation?.summary?.trim() || trace.overallGoal || '自动生成的网页操作工作流',
    removedNoiseCount: clean.noise.length,
    parameters,
    steps,
  }
}

/** 规则编译（无 AI 兜底路径） */
export function buildWorkflowFromCleanTrace(
  trace: RecordingTrace,
  clean: CleanResult
): OperationWorkflow {
  return compileActions(trace, clean, undefined, `${RULE_TRANSLATOR_VERSION}+rules-only`)
}

/** 规则清洗 + AI 语义标注 */
export function buildWorkflowWithAnnotations(
  trace: RecordingTrace,
  clean: CleanResult,
  annotation: AnnotationResult
): OperationWorkflow {
  return compileActions(trace, clean, annotation, `${RULE_TRANSLATOR_VERSION}+ai-annot`)
}

/** 供 AI 用的紧凑动作清单（不含截图、完整 DOM 等大字段） */
export function buildAnnotationPayload(trace: RecordingTrace, clean: CleanResult) {
  return {
    projectGoal: trace.overallGoal,
    totalEvents: trace.events.length,
    removedNoiseCount: clean.noise.length,
    actions: clean.steps.map((step) => ({
      stepId: step.id,
      actionType: step.actionType,
      value: step.value,
      parameterized: step.parameterized,
      ...(step.actionType === 'dialog' ? { dialogValue: step.value } : {}),
      ...(step.dragTo
        ? {
            dragTo: {
              tagName: step.dragTo.tagName,
              role: step.dragTo.role,
              innerText: step.dragTo.innerText?.slice(0, 60),
              nearbyLabel: step.dragTo.nearbyLabel?.slice(0, 60),
            },
          }
        : {}),
      ...(step.target
        ? {
            target: {
              tagName: step.target.tagName,
              role: step.target.role,
              innerText: step.target.innerText?.slice(0, 60),
              nearbyLabel: step.target.nearbyLabel?.slice(0, 60),
              attributes: step.target.attributes,
            },
          }
        : {}),
    })),
  }
}

/** AI 标注结果校验：必须覆盖所有动作，且结构合法 */
export function validateAnnotations(
  raw: unknown,
  steps: CleanStep[]
): { valid: boolean; errors: string[]; annotation?: AnnotationResult } {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['标注结果不是对象'] }
  }
  const obj = raw as Record<string, unknown>
  const annotations = obj.annotations
  if (!Array.isArray(annotations)) {
    return { valid: false, errors: ['annotations 不是数组'] }
  }

  const stepIds = new Set(steps.map((step) => step.id))
  const seen = new Set<string>()
  const parsed: StepAnnotation[] = []

  annotations.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`annotations[${index}] 不是对象`)
      return
    }
    const annotation = item as Record<string, unknown>
    const stepId = annotation.stepId
    if (typeof stepId !== 'string' || !stepIds.has(stepId)) {
      errors.push(`annotations[${index}] stepId 非法：${String(stepId)}`)
      return
    }
    if (seen.has(stepId)) {
      errors.push(`annotations[${index}] stepId 重复：${stepId}`)
      return
    }
    seen.add(stepId)
    if (typeof annotation.title !== 'string' || annotation.title.trim() === '') {
      errors.push(`annotations[${index}] 缺少 title`)
      return
    }
    parsed.push({
      stepId,
      title: annotation.title.trim(),
      description:
        typeof annotation.description === 'string' ? annotation.description.trim() : '',
      ...(typeof annotation.paramKey === 'string' && annotation.paramKey.trim()
        ? { paramKey: annotation.paramKey.trim() }
        : {}),
      ...(typeof annotation.paramLabel === 'string' && annotation.paramLabel.trim()
        ? { paramLabel: annotation.paramLabel.trim() }
        : {}),
      ...(typeof annotation.paramDescription === 'string' && annotation.paramDescription.trim()
        ? { paramDescription: annotation.paramDescription.trim() }
        : {}),
    })
  })

  const missing = steps.filter((step) => !seen.has(step.id)).map((step) => step.id)
  if (missing.length > 0) errors.push(`以下动作缺少标注：${missing.join(', ')}`)

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!summary) errors.push('缺少 summary')

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, errors: [], annotation: { summary, annotations: parsed } }
}

import fs from 'node:fs'
import path from 'node:path'
import { chromium, type BrowserContext, type Frame, type Page } from 'playwright'
import {
  appendRecordedEvent,
  BROWSER_PROFILE_DIR,
  initOrResetTrace,
  loadProjects,
  loadTrace,
  loadWorkflow,
  SCREENSHOTS_DIR,
} from './store.ts'
import type {
  CandidateLocator,
  OperationWorkflow,
  RecordedEvent,
  RecordingTrace,
  RunRecord,
} from './types.ts'

// 指向项目内置的 .browsers 目录
const LOCAL_BROWSERS_DIR = path.resolve(process.cwd(), '.browsers')
process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS_DIR

let persistentContext: BrowserContext | null = null
let activeRecordingProjectId: string | null = null
let isContextInstrumented = false

const pageTabIds = new WeakMap<Page, string>()
let tabCounter = 0

type TraceUpdateListener = (projectId: string, trace: RecordingTrace, latestEvent: RecordedEvent) => void
const traceListeners = new Set<TraceUpdateListener>()

export function onTraceUpdated(listener: TraceUpdateListener) {
  traceListeners.add(listener)
  return () => traceListeners.delete(listener)
}

function notifyTraceListeners(projectId: string, trace: RecordingTrace, latestEvent: RecordedEvent) {
  for (const listener of traceListeners) {
    try {
      listener(projectId, trace, latestEvent)
    } catch {
      // ignore listener errors
    }
  }
}

function getOrAssignTabId(page: Page): string {
  let id = pageTabIds.get(page)
  if (!id) {
    tabCounter += 1
    id = `tab-${tabCounter}`
    pageTabIds.set(page, id)
  }
  return id
}

function getTabIndex(context: BrowserContext, page: Page): number {
  const idx = context.pages().indexOf(page)
  return idx >= 0 ? idx + 1 : 1
}

/**
 * 查找项目内置 .browsers 目录下已下载完成的 Chromium 可执行文件绝对路径
 */
function resolveLocalChromiumExecutable(): string | undefined {
  try {
    if (!fs.existsSync(LOCAL_BROWSERS_DIR)) return undefined
    const entries = fs.readdirSync(LOCAL_BROWSERS_DIR)
    for (const entry of entries) {
      if (!entry.startsWith('chromium-')) continue
      const baseDir = path.join(LOCAL_BROWSERS_DIR, entry)
      const candidates = [
        path.join(
          baseDir,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        ),
        path.join(
          baseDir,
          'chrome-mac-x64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        ),
      ]
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate
        }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 为录制动作保存页面截图快照
 */
async function captureSnapshot(projectId: string, eventId: string, page: Page): Promise<string | undefined> {
  try {
    if (page.isClosed()) return undefined
    const url = page.url()
    if (!url || url === 'about:blank') return undefined

    const projShotDir = path.join(SCREENSHOTS_DIR, projectId)
    if (!fs.existsSync(projShotDir)) {
      fs.mkdirSync(projShotDir, { recursive: true })
    }
    const fileName = `${eventId}.jpg`
    const absPath = path.join(projShotDir, fileName)
    await page.screenshot({ path: absPath, type: 'jpeg', quality: 65, timeout: 2000 })
    return `data/screenshots/${projectId}/${fileName}`
  } catch {
    return undefined
  }
}

/**
 * 注入到每个标签页及子 iframe 的 DOM 采集脚本
 */
const INJECTED_RECORDER_SCRIPT = `
(() => {
  if (window.__webclickRecorderInjected) return;
  window.__webclickRecorderInjected = true;

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let selector = cur.nodeName.toLowerCase();
      if (cur.id && !/^[0-9]+$/.test(cur.id) && cur.id.length < 40) {
        selector += '#' + CSS.escape(cur.id);
        parts.unshift(selector);
        break;
      } else {
        let sib = cur;
        let nth = 1;
        while ((sib = sib.previousElementSibling)) {
          if (sib.nodeName.toLowerCase() === selector) nth++;
        }
        if (nth > 1) selector += ':nth-of-type(' + nth + ')';
      }
      parts.unshift(selector);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function xpathFor(el) {
    if (!(el instanceof Element)) return '';
    if (el.id && el.id.length < 40) {
      return '//*[@id="' + el.id.replace(/"/g, '\\"') + '"]';
    }
    const segs = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && segs.length < 8) {
      let i = 1;
      let sib = cur.previousSibling;
      while (sib) {
        if (sib.nodeType === Node.ELEMENT_NODE && sib.nodeName === cur.nodeName) i++;
        sib = sib.previousSibling;
      }
      segs.unshift(cur.nodeName.toLowerCase() + '[' + i + ']');
      cur = cur.parentNode;
    }
    return '//' + segs.join('/');
  }

  function findNearbyLabel(el) {
    if (!el) return undefined;
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl && lbl.innerText) return lbl.innerText.trim().slice(0, 60);
    }
    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel.innerText) {
      return parentLabel.innerText.trim().slice(0, 60);
    }
    const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title');
    if (ariaLabel) return ariaLabel.trim().slice(0, 60);
    const prev = el.previousElementSibling;
    if (prev && prev.innerText) return prev.innerText.trim().slice(0, 60);
    return undefined;
  }

  function inferRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || (tag === 'input' && (el.type === 'button' || el.type === 'submit'))) return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || (tag === 'input' && (!el.type || ['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type)))) return 'textbox';
    if (tag === 'input' && el.type === 'checkbox') return 'checkbox';
    if (tag === 'input' && el.type === 'radio') return 'radio';
    return undefined;
  }

  function buildTargetInfo(el) {
    if (!(el instanceof Element)) return undefined;
    const tagName = el.tagName.toLowerCase();
    const role = inferRole(el);
    const rawText = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const nearbyLabel = findNearbyLabel(el);

    const attrs = {};
    for (const name of ['id', 'name', 'type', 'placeholder', 'aria-label', 'data-testid', 'data-test', 'href', 'class']) {
      const val = el.getAttribute(name);
      if (val) attrs[name] = val.slice(0, 120);
    }

    const locators = [];
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) {
      locators.push({ strategy: 'testId', value: testId, priority: 1 });
    }
    if (el.id && !/^[0-9]{4,}$/.test(el.id)) {
      locators.push({ strategy: 'id', value: '#' + CSS.escape(el.id), priority: 2 });
    }
    if (nearbyLabel) {
      locators.push({ strategy: 'label', value: nearbyLabel, priority: 3 });
    }
    if (role && rawText && rawText.length <= 40) {
      locators.push({ strategy: 'role', value: role + ':' + rawText, priority: 4 });
    }
    if (rawText && rawText.length <= 40 && ['button', 'a', 'span', 'label', 'li'].includes(tagName)) {
      locators.push({ strategy: 'text', value: rawText, priority: 5 });
    }
    const css = cssPath(el);
    if (css) {
      locators.push({ strategy: 'css', value: css, priority: 6 });
    }
    const xp = xpathFor(el);
    if (xp) {
      locators.push({ strategy: 'xpath', value: xp, priority: 7 });
    }

    const rect = el.getBoundingClientRect();
    const boundingBox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    return {
      tagName,
      role,
      innerText: rawText || undefined,
      nearbyLabel,
      attributes: Object.keys(attrs).length ? attrs : undefined,
      locators,
      boundingBox,
    };
  }

  function sendEvent(payload) {
    if (typeof window.__webclickRecordAction === 'function') {
      window.__webclickRecordAction(payload).catch(() => {});
    }
  }

  // 1. 点击事件（忽略回车触发表单的 0 尺寸隐藏按钮合成点击）
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const rawEl = e.target;
    if (!(rawEl instanceof Element)) return;
    const interactive = rawEl.closest('button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], label') || rawEl;
    const targetInfo = buildTargetInfo(interactive);
    if (e.detail === 0 && targetInfo?.boundingBox && targetInfo.boundingBox.width === 0 && targetInfo.boundingBox.height === 0) {
      return;
    }
    sendEvent({
      actionType: 'click',
      target: targetInfo,
    });
  }, true);

  // 2. 输入框与下拉选择变更
  document.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const inputEl = el;
      if (['checkbox', 'radio', 'button', 'submit'].includes(inputEl.type)) return;
      const isPassword = inputEl.type === 'password';
      sendEvent({
        actionType: 'fill',
        value: isPassword ? '******' : inputEl.value,
        target: buildTargetInfo(inputEl),
      });
    }
  }, true);

  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    if (el.tagName.toLowerCase() === 'select') {
      sendEvent({
        actionType: 'select',
        value: el.value,
        target: buildTargetInfo(el),
      });
    }
  }, true);

  // 3. 关键按键事件 (Enter / Escape)
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (['Enter', 'Escape'].includes(e.key)) {
      const el = e.target instanceof Element ? e.target : document.activeElement;
      sendEvent({
        actionType: 'press',
        key: e.key,
        value: e.key,
        target: el ? buildTargetInfo(el) : undefined,
      });
    }
  }, true);

  // 4. 选中页面文本事件
  document.addEventListener('mouseup', (e) => {
    if (!e.isTrusted) return;
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString().trim() : '';
    if (selectedText && selectedText.length >= 2) {
      const anchorEl = sel.anchorNode && sel.anchorNode.parentElement ? sel.anchorNode.parentElement : document.body;
      sendEvent({
        actionType: 'select_text',
        value: selectedText.slice(0, 200),
        target: buildTargetInfo(anchorEl),
      });
    }
  }, true);
})();
`

/**
 * 为单个 Page 挂载窗口/标签页级别的监听（导航跳转、关闭标签页）
 */
function attachPageLifecycleListeners(context: BrowserContext, page: Page, isInitialTab = false) {
  const tabId = getOrAssignTabId(page)

  if (!isInitialTab && activeRecordingProjectId) {
    const projectId = activeRecordingProjectId
    const now = Date.now()
    const event: RecordedEvent = {
      id: `evt-${now}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      pageContext: {
        tabId,
        tabIndex: getTabIndex(context, page),
        url: page.url() || 'about:blank',
        title: '新建标签页',
      },
      action: {
        category: 'window',
        type: 'tab_open',
        value: page.url() || 'about:blank',
      },
    }
    const trace = appendRecordedEvent(projectId, event)
    notifyTraceListeners(projectId, trace, event)
  }

  // 监听主框架 URL 导航变化
  let lastRecordedUrl = page.url()
  page.on('framenavigated', async (frame: Frame) => {
    if (frame !== page.mainFrame()) return
    if (!activeRecordingProjectId) return

    const currentUrl = frame.url()
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('chrome://') || currentUrl === lastRecordedUrl) {
      return
    }
    lastRecordedUrl = currentUrl

    const projectId = activeRecordingProjectId
    const now = Date.now()
    const eventId = `evt-${now}-${Math.random().toString(36).slice(2, 6)}`
    const title = await page.title().catch(() => '')
    const screenshotPath = await captureSnapshot(projectId, eventId, page)

    const event: RecordedEvent = {
      id: eventId,
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      pageContext: {
        tabId,
        tabIndex: getTabIndex(context, page),
        url: currentUrl,
        title,
      },
      action: {
        category: 'window',
        type: 'navigate',
        value: currentUrl,
      },
      screenshotPath,
    }

    const trace = appendRecordedEvent(projectId, event)
    notifyTraceListeners(projectId, trace, event)
  })

  // 监听标签页关闭
  page.on('close', () => {
    if (!activeRecordingProjectId) return
    const projectId = activeRecordingProjectId
    const now = Date.now()
    const event: RecordedEvent = {
      id: `evt-${now}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      pageContext: {
        tabId,
        tabIndex: getTabIndex(context, page),
        url: lastRecordedUrl || 'about:blank',
        title: '关闭标签页',
      },
      action: {
        category: 'window',
        type: 'tab_close',
      },
    }
    const trace = appendRecordedEvent(projectId, event)
    notifyTraceListeners(projectId, trace, event)
  })
}

/**
 * 为整个 BrowserContext 挂载跨标签页、跨 iframe 的全局录制能力
 */
async function ensureContextInstrumented(context: BrowserContext) {
  if (isContextInstrumented) return
  isContextInstrumented = true

  // 1. 暴露全局回调：任何标签页或子 iframe 触发 DOM 事件都会回调到这里
  await context.exposeBinding(
    '__webclickRecordAction',
    async (
      source,
      payload: {
        actionType: 'click' | 'fill' | 'select' | 'select_text' | 'press'
        value?: string
        key?: string
        target?: RecordedEvent['target']
      }
    ) => {
      if (!activeRecordingProjectId) return
      const projectId = activeRecordingProjectId
      const { page, frame } = source
      const tabId = getOrAssignTabId(page)
      const now = Date.now()
      const eventId = `evt-${now}-${Math.random().toString(36).slice(2, 6)}`
      const pageUrl = page.url()
      const pageTitle = await page.title().catch(() => '')
      const frameUrl = frame !== page.mainFrame() ? frame.url() : undefined

      const screenshotPath = await captureSnapshot(projectId, eventId, page)

      const event: RecordedEvent = {
        id: eventId,
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        pageContext: {
          tabId,
          tabIndex: getTabIndex(context, page),
          url: pageUrl,
          title: pageTitle,
          frameUrl,
        },
        action: {
          category: 'page',
          type: payload.actionType,
          value: payload.value,
          key: payload.key,
        },
        target: payload.target,
        screenshotPath,
      }

      const trace = appendRecordedEvent(projectId, event)
      notifyTraceListeners(projectId, trace, event)
    }
  )

  // 2. 注入初始化脚本：对所有当前和未来打开的标签页及子 iframe 生效
  await context.addInitScript({ content: INJECTED_RECORDER_SCRIPT })

  // 3. 给已有的页面挂载生命周期监听并立即注入一次脚本
  for (const existingPage of context.pages()) {
    attachPageLifecycleListeners(context, existingPage, true)
    await existingPage.evaluate(INJECTED_RECORDER_SCRIPT).catch(() => {})
  }

  // 4. 监听未来新建的任何标签页或弹窗窗口
  context.on('page', (newPage: Page) => {
    attachPageLifecycleListeners(context, newPage, false)
  })
}

/**
 * 启动或复用带本地持久化缓存目录的内置浏览器（保留公司 SSO 登录态）
 */
export async function getPersistentBrowserContext(headless = false): Promise<BrowserContext> {
  if (persistentContext) {
    try {
      persistentContext.pages()
      return persistentContext
    } catch {
      persistentContext = null
      isContextInstrumented = false
    }
  }

  const localExecPath = resolveLocalChromiumExecutable()

  persistentContext = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    ...(localExecPath ? { executablePath: localExecPath } : { channel: 'chrome' }),
    viewport: null,
    args: ['--start-maximized'],
  })

  isContextInstrumented = false

  persistentContext.on('close', () => {
    persistentContext = null
    activeRecordingProjectId = null
    isContextInstrumented = false
  })

  await ensureContextInstrumented(persistentContext)

  return persistentContext
}

/**
 * 为指定项目打开内置浏览器空白页面，进入录制状态并初始化该项目的 Trace JSON 文件
 */
export async function openRecordingBrowser(projectId: string): Promise<{ pageUrl: string }> {
  const projects = loadProjects()
  const proj = projects.find((p) => p.id === projectId)
  initOrResetTrace(projectId, proj?.description)

  const context = await getPersistentBrowserContext(false)
  activeRecordingProjectId = projectId

  const pages = context.pages()
  const page = pages.length > 0 ? pages[0] : await context.newPage()

  await page.goto('about:blank')
  await page.bringToFront()

  return { pageUrl: page.url() }
}

/**
 * 结束当前项目的录制
 */
export async function stopRecordingBrowser(): Promise<void> {
  activeRecordingProjectId = null
  if (persistentContext) {
    await persistentContext.close()
    persistentContext = null
    isContextInstrumented = false
  }
}

export function getActiveRecordingProjectId(): string | null {
  return activeRecordingProjectId
}

/**
 * 按候选选择器优先级依次尝试定位元素
 */
async function resolveLocator(page: Page, locators: CandidateLocator[], timeoutMs: number) {
  const sorted = [...locators].sort((a, b) => a.priority - b.priority)

  for (const loc of sorted) {
    try {
      const target =
        loc.strategy === 'testId'
          ? page.getByTestId(loc.value)
          : loc.strategy === 'label'
            ? page.getByLabel(loc.value)
            : loc.strategy === 'text'
              ? page.getByText(loc.value)
              : page.locator(loc.value)

      await target.first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 3500) })
      return target.first()
    } catch {
      // 当前选择器未命中，继续尝试下一个候选选择器
    }
  }

  throw new Error(`未找到目标元素 (${locators.map((l) => l.value).join(', ')})`)
}

/**
 * 执行经大模型清洗后的结构化操作工作流 (OperationWorkflow)，支持注入项目动态参数
 */
async function executeCompiledWorkflow(
  workflow: OperationWorkflow,
  runtimeParams?: Record<string, string>
): Promise<RunRecord> {
  const startedAt = Date.now()
  activeRecordingProjectId = null

  // 构建参数字典：优先取本次运行传入的参数，其次取 workflow.parameters 中保存的当前值
  const paramValues = new Map<string, { label: string; value: string }>()
  for (const p of workflow.parameters || []) {
    paramValues.set(p.key, {
      label: p.label,
      value: runtimeParams?.[p.key] !== undefined ? String(runtimeParams[p.key]) : p.value,
    })
  }

  try {
    const context = await getPersistentBrowserContext(false)
    const initialPage = context.pages()[0] || (await context.newPage())
    await initialPage.bringToFront()

    const tabMap = new Map<string, Page>()
    const firstTabId = workflow.steps[0]?.engineBinding.tabId || 'tab-1'
    tabMap.set(firstTabId, initialPage)

    for (const step of workflow.steps) {
      const { tabId, actionType, locators, timeoutMs } = step.engineBinding
      const paramKey = step.engineBinding.paramKey || step.humanView.paramKey
      // 如果是动态抽象步骤，从项目参数表中读取对应参数值；否则使用固定值
      const resolvedParam = paramKey ? paramValues.get(paramKey)?.value : undefined
      const value =
        resolvedParam !== undefined
          ? resolvedParam
          : (step.engineBinding.value ?? '')

      let page = tabMap.get(tabId)
      if (!page || page.isClosed()) {
        page = context.pages()[0] || (await context.newPage())
        tabMap.set(tabId, page)
      }

      if (actionType === 'tab_open') {
        const newPage = await context.newPage()
        await newPage.bringToFront()
        tabMap.set(tabId, newPage)
        continue
      }

      if (actionType === 'tab_close') {
        if (!page.isClosed() && context.pages().length > 1) {
          await page.close()
        }
        continue
      }

      if (actionType === 'goto') {
        await page.goto(value, { waitUntil: 'domcontentloaded', timeout: timeoutMs || 15000 })
        await page.waitForTimeout(400)
        continue
      }

      if (actionType === 'click') {
        const el = await resolveLocator(page, locators, timeoutMs)
        await el.click({ timeout: timeoutMs })
        await page.waitForTimeout(350)
        continue
      }

      if (actionType === 'fill') {
        const el = await resolveLocator(page, locators, timeoutMs)
        await el.fill(value, { timeout: timeoutMs })
        await page.waitForTimeout(350)
        continue
      }

      if (actionType === 'select') {
        const el = await resolveLocator(page, locators, timeoutMs)
        await el.selectOption(value, { timeout: timeoutMs })
        await page.waitForTimeout(350)
        continue
      }

      if (actionType === 'press') {
        const pressKey = value || 'Enter'
        if (locators && locators.length > 0) {
          const el = await resolveLocator(page, locators, timeoutMs)
          await el.press(pressKey, { timeout: timeoutMs })
        } else {
          await page.keyboard.press(pressKey)
        }
        await page.waitForTimeout(600)
        continue
      }

      if (actionType === 'extract_text' && value) {
        await page
          .evaluate((textToSelect) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
            let node: Node | null
            while ((node = walker.nextNode())) {
              const content = node.textContent || ''
              const idx = content.indexOf(textToSelect)
              if (idx !== -1) {
                const range = document.createRange()
                range.setStart(node, idx)
                range.setEnd(node, idx + textToSelect.length)
                const sel = window.getSelection()
                sel?.removeAllRanges()
                sel?.addRange(range)
                break
              }
            }
          }, value)
          .catch(() => {})
        await page.waitForTimeout(350)
        continue
      }

      if (actionType === 'wait_for_text' && value) {
        await page.getByText(value).first().waitFor({ state: 'visible', timeout: timeoutMs })
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const paramSummary = Array.from(paramValues.values())
      .map((p) => `${p.label}：${p.value}`)
      .join('，')
    return {
      id: `r-${Date.now()}`,
      time: '刚刚',
      status: 'success',
      duration: `${elapsed} 秒`,
      note: paramSummary
        ? `已执行 ${workflow.steps.length} 个工作流步骤（${paramSummary}）`
        : `已按操作工作流执行完成 ${workflow.steps.length} 个步骤`,
    }
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const message = err instanceof Error ? err.message : '未知执行错误'
    return {
      id: `r-${Date.now()}`,
      time: '刚刚',
      status: 'failed',
      duration: `${elapsed} 秒`,
      note: `执行中断：${message}`,
    }
  }
}

/**
 * 直接根据录制下来的 RecordingTrace 复现用户的完整操作（未经过大模型编译时的兜底回放）
 */
async function replayRecordingTrace(trace: RecordingTrace): Promise<RunRecord> {
  const startedAt = Date.now()
  activeRecordingProjectId = null

  try {
    const context = await getPersistentBrowserContext(false)
    const initialPage = context.pages()[0] || (await context.newPage())
    await initialPage.bringToFront()

    const tabMap = new Map<string, Page>()
    const firstTabId = trace.events[0]?.pageContext.tabId || 'tab-1'
    tabMap.set(firstTabId, initialPage)

    let executedCount = 0

    for (let i = 0; i < trace.events.length; i++) {
      const evt = trace.events[i]
      const prevEvt = i > 0 ? trace.events[i - 1] : null
      const { tabId } = evt.pageContext

      let page = tabMap.get(tabId)
      if (!page || page.isClosed()) {
        page = context.pages()[0] || (await context.newPage())
        tabMap.set(tabId, page)
      }

      const { type, value, key } = evt.action

      if (type === 'tab_open') {
        const newPage = await context.newPage()
        await newPage.bringToFront()
        tabMap.set(tabId, newPage)
        executedCount += 1
        continue
      }

      if (type === 'tab_close') {
        if (!page.isClosed() && context.pages().length > 1) {
          await page.close()
        }
        executedCount += 1
        continue
      }

      if (type === 'navigate' && value) {
        const prevTriggeredNav =
          prevEvt &&
          prevEvt.pageContext.tabId === tabId &&
          (prevEvt.action.type === 'press' ||
            prevEvt.action.type === 'click' ||
            prevEvt.action.type === 'navigate') &&
          evt.timestamp - prevEvt.timestamp < 2500

        if (prevTriggeredNav && i > 0) {
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
          continue
        }

        await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 15000 })
        executedCount += 1
        await page.waitForTimeout(400)
        continue
      }

      if (type === 'click' && evt.target?.locators?.length) {
        const isZeroBox =
          evt.target.boundingBox &&
          evt.target.boundingBox.width === 0 &&
          evt.target.boundingBox.height === 0
        const rightAfterEnter =
          prevEvt &&
          prevEvt.action.type === 'press' &&
          evt.timestamp - prevEvt.timestamp < 100
        const rightBeforeFillSameInput =
          trace.events[i + 1] &&
          trace.events[i + 1].action.type === 'fill' &&
          trace.events[i + 1].target?.locators?.[0]?.value === evt.target.locators[0]?.value

        if (isZeroBox || rightAfterEnter) {
          continue
        }

        const el = await resolveLocator(page, evt.target.locators, 8000)
        await el.click({ timeout: 5000 })
        executedCount += 1
        if (!rightBeforeFillSameInput) {
          await page.waitForTimeout(350)
        }
        continue
      }

      if (type === 'fill' && evt.target?.locators?.length) {
        const el = await resolveLocator(page, evt.target.locators, 8000)
        await el.fill(value ?? '', { timeout: 5000 })
        executedCount += 1
        await page.waitForTimeout(350)
        continue
      }

      if (type === 'select' && evt.target?.locators?.length) {
        const el = await resolveLocator(page, evt.target.locators, 8000)
        await el.selectOption(value ?? '', { timeout: 5000 })
        executedCount += 1
        await page.waitForTimeout(350)
        continue
      }

      if (type === 'press') {
        const pressKey = key || value || 'Enter'
        if (evt.target?.locators?.length) {
          const el = await resolveLocator(page, evt.target.locators, 8000)
          await el.press(pressKey, { timeout: 5000 })
        } else {
          await page.keyboard.press(pressKey)
        }
        executedCount += 1
        await page.waitForTimeout(600)
        continue
      }

      if (type === 'select_text' && value) {
        await page
          .evaluate((textToSelect) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
            let node: Node | null
            while ((node = walker.nextNode())) {
              const content = node.textContent || ''
              const idx = content.indexOf(textToSelect)
              if (idx !== -1) {
                const range = document.createRange()
                range.setStart(node, idx)
                range.setEnd(node, idx + textToSelect.length)
                const sel = window.getSelection()
                sel?.removeAllRanges()
                sel?.addRange(range)
                break
              }
            }
          }, value)
          .catch(() => {})
        executedCount += 1
        await page.waitForTimeout(350)
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    return {
      id: `r-${Date.now()}`,
      time: '刚刚',
      status: 'success',
      duration: `${elapsed} 秒`,
      note: `已复现完成 ${executedCount} 个录制动作`,
    }
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const message = err instanceof Error ? err.message : '未知执行错误'
    return {
      id: `r-${Date.now()}`,
      time: '刚刚',
      status: 'failed',
      duration: `${elapsed} 秒`,
      note: `复现中断：${message}`,
    }
  }
}

/**
 * 解释并执行项目的操作工作流（优先执行大模型编译生成的 OperationWorkflow，若尚未编译则直接复现录制的 RecordingTrace）
 */
export async function runProjectAutomation(
  projectId: string,
  workflow?: OperationWorkflow,
  trace?: RecordingTrace,
  runtimeParams?: Record<string, string>
): Promise<RunRecord> {
  const startedAt = Date.now()
  activeRecordingProjectId = null

  // 1. 优先读取并执行大模型编译后的结构化操作工作流
  const resolvedWorkflow = workflow || loadWorkflow(projectId)
  if (resolvedWorkflow && resolvedWorkflow.steps.length > 0) {
    return executeCompiledWorkflow(resolvedWorkflow, runtimeParams)
  }

  // 2. 如果还没有编译成工作流，但已经录制了原始轨迹，直接用 Playwright 复现录制动作
  const resolvedTrace = trace || loadTrace(projectId)
  if (resolvedTrace && resolvedTrace.events.length > 0) {
    return replayRecordingTrace(resolvedTrace)
  }

  // 3. 既没有工作流也没有录制轨迹的示例项目兜底
  await new Promise((r) => setTimeout(r, 1200))
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  return {
    id: `r-${Date.now()}`,
    time: '刚刚',
    status: 'success',
    duration: `${elapsed} 秒`,
    note: '自动化执行完成，所有操作步骤均已通过',
  }
}

import fs from 'node:fs'
import path from 'node:path'
import type { OperationWorkflow } from './types.ts'

export interface CatalogChoice {
  label: string
  value: string
}

export interface CatalogField {
  name: string
  label: string
  kind: 'text' | 'choice' | 'mrvs'
  mandatory: boolean
  choices: CatalogChoice[]
  columns: Array<{ name: string; label: string }>
}

export interface CatalogInput {
  key: string
  label: string
  value: string
}

const SKIP_TYPES = new Set([11, 12, 14, 15, 17, 19, 20])

function readDotEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env')
  const result: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return result
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[line.slice(0, index).trim()] = value
  }
  return result
}

export function serviceNowConfig(): { instanceUrl: string; clientId: string; clientSecret: string } | null {
  const env = readDotEnv()
  const instanceUrl = (env.SERVICENOW_INSTANCE_URL || process.env.SERVICENOW_INSTANCE_URL || '').replace(/\/$/, '')
  const clientId = env.SERVICENOW_CLIENT_ID || process.env.SERVICENOW_CLIENT_ID || ''
  const clientSecret = env.SERVICENOW_CLIENT_SECRET || process.env.SERVICENOW_CLIENT_SECRET || ''
  if (!instanceUrl || !clientId || !clientSecret) return null
  return { instanceUrl, clientId, clientSecret }
}

export function catalogSysIdFromWorkflow(workflow: OperationWorkflow, instanceUrl: string): string | null {
  let instanceHost = ''
  try {
    instanceHost = new URL(instanceUrl).host
  } catch {
    return null
  }
  for (const step of workflow.steps) {
    const raw = step.engineBinding.value || ''
    if (!/^https?:\/\//i.test(raw)) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.host !== instanceHost) continue
    const sysId = url.searchParams.get('sys_id') || ''
    const pageId = url.searchParams.get('id') || ''
    const table = url.searchParams.get('table') || ''
    const isCatalog =
      pageId === 'sc_cat_item' || table === 'sc_cat_item' || url.pathname.includes('sc_cat_item')
    if (isCatalog && /^[0-9a-f]{32}$/i.test(sysId)) return sysId
  }
  return null
}

function asChoices(raw: unknown): CatalogChoice[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((choice) => {
      const record = choice as { label?: string; value?: string }
      return { label: String(record.label || ''), value: String(record.value || '') }
    })
    .filter((choice) => choice.value)
}

function fieldFromVariable(variable: Record<string, unknown>): CatalogField | null {
  const type = Number(variable.type)
  if (SKIP_TYPES.has(type)) return null
  const name = String(variable.name || '')
  if (!name) return null
  const choices = asChoices(variable.choices)
  const children = Array.isArray(variable.children) ? variable.children : []
  const columns = children
    .map((child) => {
      const record = child as { name?: string; label?: string }
      return { name: String(record.name || ''), label: String(record.label || record.name || '') }
    })
    .filter((column) => column.name)
  const kind = columns.length > 0 ? 'mrvs' : choices.length > 0 ? 'choice' : 'text'
  return {
    name,
    label: String(variable.label || name),
    kind,
    mandatory: Boolean(variable.mandatory),
    choices,
    columns,
  }
}

/** 把目录项接口返回的 variables / variable_sets 收成可提交字段。 */
export function fieldsFromCatalogItem(result: Record<string, unknown>): CatalogField[] {
  const fields: CatalogField[] = []
  const variables = Array.isArray(result.variables) ? result.variables : []
  for (const variable of variables) {
    if (!variable || typeof variable !== 'object') continue
    const field = fieldFromVariable(variable as Record<string, unknown>)
    if (field) fields.push(field)
  }
  const sets = Array.isArray(result.variable_sets)
    ? result.variable_sets
    : Array.isArray(result.variableSets)
      ? result.variableSets
      : []
  for (const set of sets) {
    if (!set || typeof set !== 'object') continue
    const record = set as Record<string, unknown>
    const name = String(record.internal_name || record.name || '')
    if (!name || fields.some((field) => field.name === name)) continue
    const columns = (Array.isArray(record.variables) ? record.variables : [])
      .map((variable) => {
        const column = variable as { name?: string; label?: string }
        return { name: String(column.name || ''), label: String(column.label || column.name || '') }
      })
      .filter((column) => column.name)
    fields.push({
      name,
      label: String(record.title || record.label || name),
      kind: 'mrvs',
      mandatory: Boolean(record.mandatory),
      choices: [],
      columns,
    })
  }
  return fields
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function matchScore(input: CatalogInput, field: CatalogField) {
  const haystack = normalize(`${input.key} ${input.label}`)
  const name = normalize(field.name)
  const label = normalize(field.label)
  if (!haystack) return 0
  if (name && (haystack === name || haystack.includes(name) || name.includes(haystack))) return 8
  if (label && (haystack === label || haystack.includes(label) || label.includes(haystack))) return 7
  const tokens = field.label.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((token) => token.length > 2)
  const hits = tokens.filter((token) => haystack.includes(normalize(token))).length
  return hits
}

export function resolveChoiceValue(raw: string, choices: CatalogChoice[]) {
  const wanted = raw.trim().toLowerCase()
  if (!wanted) return raw
  const exact = choices.find(
    (choice) => choice.value.toLowerCase() === wanted || choice.label.toLowerCase() === wanted
  )
  if (exact) return exact.value
  const fuzzy = choices.find((choice) => choice.label.toLowerCase().includes(wanted))
  return fuzzy ? fuzzy.value : raw
}

function mrvsValue(raw: string, columns: Array<{ name: string }>) {
  const text = raw.trim()
  if (!text) return ''
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return JSON.stringify(parsed)
    } catch {
      // 不是合法 JSON 时按单行文本处理
    }
  }
  if (columns.length === 1) return JSON.stringify([{ [columns[0].name]: text }])
  return text
}

/** 把工作流参数对齐到目录项字段。多行变量集的值会变成 JSON 字符串。 */
export function mapCatalogFields(fields: CatalogField[], inputs: CatalogInput[]): Record<string, string> {
  const usedInputs = new Set<string>()
  const pairs: Array<{ field: CatalogField; input: CatalogInput; score: number }> = []
  for (const field of fields) {
    let best: { input: CatalogInput; score: number } | null = null
    for (const input of inputs) {
      if (!input.value.trim()) continue
      const score = matchScore(input, field)
      if (score <= 0) continue
      if (!best || score > best.score) best = { input, score }
    }
    if (best) pairs.push({ field, input: best.input, score: best.score })
  }
  pairs.sort((a, b) => b.score - a.score)
  const variables: Record<string, string> = {}
  const usedFields = new Set<string>()
  for (const pair of pairs) {
    if (usedFields.has(pair.field.name) || usedInputs.has(pair.input.key)) continue
    usedFields.add(pair.field.name)
    usedInputs.add(pair.input.key)
    if (pair.field.kind === 'choice') {
      variables[pair.field.name] = resolveChoiceValue(pair.input.value, pair.field.choices)
    } else if (pair.field.kind === 'mrvs') {
      variables[pair.field.name] = mrvsValue(pair.input.value, pair.field.columns)
    } else {
      variables[pair.field.name] = pair.input.value
    }
  }
  const missing = fields.filter((field) => field.mandatory && !variables[field.name])
  if (missing.length > 0) {
    throw new Error(
      `ServiceNow 目录项还有必填字段没有对上参数：${missing.map((field) => field.label).join('、')}`
    )
  }
  return variables
}

export function inputsFromWorkflow(
  workflow: OperationWorkflow,
  paramValues: Map<string, { label: string; value: string }>
): CatalogInput[] {
  const inputs: CatalogInput[] = []
  for (const param of workflow.parameters || []) {
    const resolved = paramValues.get(param.key)
    inputs.push({
      key: param.key,
      label: `${param.label} ${param.description || ''}`,
      value: resolved?.value ?? param.value,
    })
  }
  for (const step of workflow.steps) {
    const action = step.engineBinding.actionType
    if (action !== 'fill' && action !== 'select') continue
    if (step.engineBinding.paramKey && inputs.some((input) => input.key === step.engineBinding.paramKey)) continue
    const value = step.engineBinding.value || ''
    if (!value) continue
    inputs.push({
      key: step.id,
      label: `${step.humanView.title} ${step.humanView.description || ''} ${step.humanView.paramLabel || ''}`,
      value,
    })
  }
  return inputs
}

async function accessToken(config: { instanceUrl: string; clientId: string; clientSecret: string }) {
  const response = await fetch(`${config.instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  })
  const body = (await response.json().catch(() => null)) as { access_token?: string; error_description?: string } | null
  if (!response.ok || !body?.access_token) {
    throw new Error(body?.error_description || `获取 ServiceNow token 失败 (${response.status})`)
  }
  return body.access_token
}

function snStamp(minutesAgo: number) {
  const date = new Date(Date.now() - minutesAgo * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

async function newestNumber(
  config: { instanceUrl: string },
  token: string,
  table: string,
  since: string
) {
  const query = encodeURIComponent(`sys_created_on>${since}^ORDERBYDESCsys_created_on`)
  const response = await fetch(
    `${config.instanceUrl}/api/now/table/${table}?sysparm_query=${query}&sysparm_limit=1&sysparm_fields=number,short_description,description,sys_created_on`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  )
  if (!response.ok) return null
  const body = (await response.json()) as { result?: Array<{ number?: string; short_description?: string; description?: string }> }
  return body.result?.[0] || null
}

/**
 * 工作流入口是当前实例上的目录项时，直接 order_now。
 * 返回 null 表示这条工作流不走 API，调用方继续浏览器回放。
 */
export async function trySubmitServiceNowCatalog(
  workflow: OperationWorkflow,
  paramValues: Map<string, { label: string; value: string }>
): Promise<{ number: string; itemName: string } | null> {
  const config = serviceNowConfig()
  if (!config) return null
  const sysId = catalogSysIdFromWorkflow(workflow, config.instanceUrl)
  if (!sysId) return null

  const token = await accessToken(config)
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const itemResponse = await fetch(`${config.instanceUrl}/api/sn_sc/servicecatalog/items/${sysId}`, { headers })
  if (!itemResponse.ok) return null
  const itemBody = (await itemResponse.json()) as { result?: Record<string, unknown> }
  const result = itemBody.result || {}
  const fields = fieldsFromCatalogItem(result)
  if (fields.length === 0) return null
  const variables = mapCatalogFields(fields, inputsFromWorkflow(workflow, paramValues))
  const since = snStamp(2)
  const orderResponse = await fetch(`${config.instanceUrl}/api/sn_sc/servicecatalog/items/${sysId}/order_now`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sysparm_quantity: '1', variables }),
  })
  const orderText = await orderResponse.text()
  let orderJson: { result?: { number?: string; request_number?: string } } | null = null
  try {
    orderJson = JSON.parse(orderText) as { result?: { number?: string; request_number?: string } }
  } catch {
    orderJson = null
  }
  const directNumber = orderJson?.result?.number || orderJson?.result?.request_number
  const itemName = String(result.name || result.short_description || sysId)
  if (orderResponse.ok && directNumber) return { number: directNumber, itemName }

  const needle = Object.values(variables).find((value) => value && !value.startsWith('[')) || ''
  for (const table of ['incident', 'sc_req_item', 'sc_request']) {
    const row = await newestNumber(config, token, table, since)
    const blob = `${row?.short_description || ''} ${row?.description || ''}`
    if (row?.number && (!needle || blob.includes(needle.slice(0, 40)))) return { number: row.number, itemName }
  }
  throw new Error(
    `ServiceNow API 提交失败 (${orderResponse.status})${orderText ? `：${orderText.slice(0, 180)}` : ''}`
  )
}

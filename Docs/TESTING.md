# 测试与验证（截至 2026-10-18）

> 本文记录当前测试分层、真站回归结果、以及测试过程中发现并修复的问题。
> 核心逻辑单测已在 `tests/` 并由 GitHub Actions 运行（`npm test`）；浏览器 E2E 脚本目前仍为临时脚本，后续可迁入 `tests/e2e/`。

## 1. 测试分层与结果

| 层 | 覆盖内容 | 结果 |
|---|---|---|
| 规则编译器单测（仓库 `tests/`） | 清洗规则（合成点击 / 被动跳转 / 聚焦合并 / 空标签页 / 悬停噪声 / 新动作）、规则编译、参数生成、标注 Schema 校验 | 29/29 |
| 翻译器证据增强单测（仓库 `tests/`） | frameChain / shadowChain / DOM 快照 / 派生定位器 / 后置校验生成 / 覆盖审计 | 14/14 |
| 真实 AI 编译 | DeepSeek 语义标注链路、Schema、覆盖审计、参数命名（真实 API 调用） | 14/14 |
| 执行器 E2E（本地） | P0（iframe/校验/遥测）、P1（嵌套 iframe / shadow L2 / 失败截图）、新动作（hover/dblclick/文件上传）、右键/拖拽/弹窗 | 11 + 11 + 8 + 7 |
| L3 视觉兜底（mock sidecar） | 命中 L3、预算耗尽、服务不可用降级 | 12/12 |
| 录制器 E2E（本地页面） | 所有录制动作 + 噪声过滤（双击合并、hover 防抖、右键/拖拽选区误记、文件上传） | 9/9 + 7/7 |
| 前端 UI E2E | 任务列表、工作流弹窗、异步进度、执行历史、遥测展示、无 JS 报错 | 15/15（注意：首次偶发时序抖动，重跑通过） |
| **真站全链路** | 录制 → AI 编译 → 执行 → 稳定性复跑 + replay/L2/L3/失败专项 | **42 通过 / 0 失败 / 1 跳过** |
| **ServiceNow 端到端**（2026-10-19） | 登录 → Create Incident 目录表单（Select2 下拉）→ 提交 → 回放 → 新工单校验 | **15/15 通过** |
| **Shadow DOM 专项**（2026-10-19） | open 两层嵌套 + closed shadow：录制目标、open L1 回放、closed L3 兜底 | **13/13 通过** |

## 2. 真实站点回归

| 站点 | 场景 | 结果 |
|---|---|---|
| example.com | 打开页面 → 点击外链 → 跳转 iana.org | ✅ 录制 2 步、两次执行成功、2/2 校验通过 |
| selenium.dev web-form | 表单填写 + select + 提交 | ✅ 4 步、两次执行成功、参数化 `text` 正确 |
| en.wikipedia.org | 首页搜索框输入 + 回车 → 结果页 | ✅ 3 步、两次执行成功、3/3 校验通过 |
| news.ycombinator.com | 首页点击第一条外链 | ✅ 2 步、两次执行成功、2/2 校验通过 |
| baidu.com | 搜索框输入 + 回车 | ⏭ 跳过：百度对自动化浏览器有反爬/风控，`fill` 不可交互，属于站点限制 |
| ServiceNow dev403453（Employee Center） | 登录 → Create Incident（Urgency + 描述）→ 提交 → 回放 | ✅ 录制 INC0010006，回放新建 INC0010007，登录/表单/提交全链路通过 |
| **专项** | replay（无工作流直接回放）/ L2（破坏定位器保留证据）/ L3（mock 视觉兜底）/ 失败注入 | ✅ 全部通过；失败时现场截图与 URL 正常留存 |

每次执行都检查了：编译出的步骤数、覆盖审计（mapped + dropped = 总事件数）、参数与标题、至少一步后置校验、连续两次执行成功。

## 3. 本轮真站测试发现并修复的问题

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 导航型点击（外链/提交）录制丢失，导致步骤缺失、被动跳转挂错步骤 | 点击延迟 220ms 上报 + 主进程异步截图，页面卸载打断上报 | 点击**立即上报**；双击改为主进程「替换最后一条 click」；`stopRecording` 前 flush 350ms |
| 2 | 表单提交后 URL 校验误判失败 | URL 编码差异（`+` vs `%20`）、参数顺序、重定向 | URL 模糊匹配：解码归一化 + 参数集合比对 |
| 3 | Submit 按钮被记成 `label: Default radio`，执行时点错元素 | 录制器的 `nearbyLabel` 用「前一个兄弟元素」兜底，误取无关文案 | 移除该兜底；仅保留 `label[for]` / 包裹 label / aria-label / placeholder / title |
| 4 | HN 链接点击点到「login」等无关元素 | 候选定位器按优先级盲选，CSS 路径可能匹配多个同构元素 | 用**录制证据身份校验**（tagName / innerText / href）复核候选；同一选择器多匹配时逐个校验前 3 个 |
| 5 | 维基百科回车步骤超时（元素瞬时不可用） | 真实站点重渲染导致按 Enter 瞬间 `#searchInput` 被替换 | 按键兜底：若焦点在输入框/可编辑元素上，改用 `keyboard.press`，语义等价并记录 `matchedVia` |
| 6 | 录制 select 时无事件 | 测试驱动 `selectOption` 产生的是程序化（untrusted）事件，被录制器按噪声过滤 | 产品逻辑无需改；测试改用键盘操作原生 select（真实用户事件） |
| 7 | 测试脚本串行状态问题（前一场景录制浏览器未关闭 → profile 锁） | 场景异常时未 stopRecording；并发运行偶发 409 | 测试脚本修正：异常必关浏览器、409 短暂重试 |
| 8 | closed shadow root 内元素只录到宿主 | `composedPath()` 在 closed 树外被截断 | 页面脚本执行前 hook `attachShadow` 保存 root 引用，按「坐标命中 / 当前焦点」反查真实节点，记录 `shadowMode` |
| 9 | closed shadow 回放失败 | Playwright 无法穿透 closed shadow | 执行器看到 `shadowMode=closed` 直接走 L3 视觉兜底，不再浪费 L1/L2 |
| 10 | Select2 下拉「展开」动作没录到 | Select2 在 mousedown 展开，mouseup 时命中的已是浮层 | mousedown 阶段补记 Select2/ARIA 控件点击，200ms 去重 |
| 11 | ServiceNow 提交后 URL 的 `sys_id` 每次不同，回放校验失败 | 校验规则记录了录制时的具体 ID | 编译期把 URL 参数里的 sys_id/UUID/长数字替换为 `*`，执行器按通配参数匹配 |
| 12 | 登录密码回放 | 录制时密码打码为 `******` | 编译后把密码步骤改为运行参数，回放用 `POST /run {parameters:{password}}` 注入 |
| 13 | 回放只打开空白标签页，后续什么都不做 | 录制开头的 `tab_open(about:blank)` 被保留成第 1 步；执行器新开空白页，后续动作都落在空白页 | 清洗时丢弃「初始 tab_open」；`tab_open` 后的 `navigate` 落成 `goto`；验证码/登录跳转与重复被动跳转不再覆盖后置校验 |
| 14 | 风控站点回放报「URL 未包含」难以理解 | 提交后被重定向到验证码页，URL 校验失败 | 运行时识别验证码/风控跳转，失败原因明确为「站点触发验证码/风控（host）」 |

## 4. 已知限制

- **反爬站点**（百度等）无法稳定自动化：录制与回放都会被重定向到 `wappass` 验证码，运行会以明确的风控提示失败；属于站点策略限制，不是产品缺陷；
- closed shadow DOM / canvas 仍不可观测，只能依赖 L3 内网视觉（当前为 mock 骨架）；
- 真站语料目前 5 个，建议后续扩到 10–20 个异构图（后台管理系统、表格、弹窗、富文本、文件上传）；
- L3 真实模型尚未接入，准确率基线未建立；
- L2 结构恢复的成功率在真实站点上还没有统计样本（当前只验证了单点场景）；
- ServiceNow 登录会话是 session 级 cookie，回放时需重新登录（已验证自动登录链路可复用）；
- 登录密码目前以「运行参数」方式注入，生产环境应接密钥管理，不落工作流文件。

## 5. CI

`.github/workflows/ci.yml`（GitHub Actions）：

- 触发：push 到 `main` / 任意 PR；
- 步骤：`npm ci` → `npm run lint` → `npm run build` → `npm test`；
- 覆盖：类型检查、前端构建、规则清洗/编译/证据增强/标注校验单测；
- 暂不入 CI：浏览器 E2E、真站回归、L3 mock（依赖 Playwright 浏览器与网络，后续可单独做定时任务或自建 runner）。

本地等价命令：

```bash
npm ci
npm run lint
npm run build
npm test
```

## 6. 下一阶段建议

1. 把真站矩阵扩展为回归基准（10–20 站），记录 L1/L2/L3 命中率、失败原因分布；
2. 接入内网 VLM，测 grounding 准确率与延迟，决定是否启用多步 Agent；
3. 将临时 E2E 脚本迁入 `tests/e2e/`（浏览器类用例可放自建 runner 或定时任务）；
4. 补 L3 成功后的 IR 自愈回写（下次自动走 L1/L2）。

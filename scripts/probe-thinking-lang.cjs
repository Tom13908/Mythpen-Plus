/**
 * 诊断用探针：思维链语言到底受哪个提示词位置影响。
 *
 * 用真实档案 + 真实适配器发三笔最小请求，逐字节复现 app 的请求构造路径：
 *   A 提示写在系统提示词里（当前实现的行为）
 *   B 提示写在最后一条用户消息里
 *   C 完全不写提示（对照组）
 *
 * 只读 ~/.mythpen/config.db，不改任何数据。用完即可删除本文件。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const initSqlJs = require(path.join(__dirname, '../node_modules/sql.js'))
const { createAIAdapter } = require('../server/ai-adapter')

const HINT = '（思考语言：请使用与正文相同的语言进行思考，不要换用其他语言思考。）'
const SYSTEM = '你是一位经验丰富专业的小说创作助手，帮助作者高质量完稿。'
const USER = '比较 17×23 与 19×21 的大小，只回答较大的那个乘积。'

// 语种判定：汉字占比。>=20% 记为中文，否则记为英文。
function langOf(s) {
  if (!s) return '（无思考内容）'
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (s.match(/[A-Za-z]/g) || []).length
  const total = cjk + latin
  if (!total) return '（无字母/汉字）'
  return `${cjk / total >= 0.2 ? '中文' : '英文'}（汉字 ${cjk} / 拉丁字母 ${latin}）`
}

async function main() {
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(path.join(os.homedir(), '.mythpen/config.db')))
  const map = {}
  for (const row of db.exec('SELECT key, value FROM app_settings')[0].values) map[row[0]] = row[1]
  db.close()

  const aiConfig = {
    apiBaseUrl: map.api_base_url,
    apiKey: map.api_key,
    apiModel: map.api_model,
    apiType: map.api_type,
    maxOutputTokens: parseInt(map.max_output_tokens, 10) || 4096,
    contextLimit: parseInt(map.context_limit, 10) || 128000,
    reasoningLang: map.reasoning_lang || undefined,
    thinkingLevel: map.thinking_level || undefined,
  }

  console.log(`模型：${aiConfig.apiModel}（${aiConfig.apiType}）  档案：reasoningLang=${aiConfig.reasoningLang ?? '-'} thinkingLevel=${aiConfig.thinkingLevel ?? '-'}\n`)

  async function probe(label, systemPrompt, userMessage) {
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType)
    const t0 = Date.now()
    console.log(`━━━ ${label} ━━━`)
    try {
      const r = await adapter.complete(systemPrompt, [{ role: 'user', content: userMessage }], null, undefined)
      console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | stop=${r.stopReason} | 输出 ${r.usage.outputTokens} tok`)
      console.log(`  思维链语种：${langOf(r.reasoning)}`)
      console.log(`  思维链开头：${JSON.stringify(r.reasoning.slice(0, 150))}`)
      console.log(`  正文长度：${(r.content || '').length}`)
    } catch (e) {
      console.log(`  ❌ 请求失败：status=${e.status || '-'} ${e.message}`)
      if (e.detail) console.log(`     detail: ${String(e.detail).slice(0, 300)}`)
    }
    console.log('')
  }

  await probe('A 提示写在系统提示词（当前实现）', SYSTEM + '\n\n' + HINT, USER)
  await probe('B 提示写在用户消息末尾', SYSTEM, USER + '\n' + HINT)
  await probe('C 不写任何提示（对照组）', SYSTEM, USER)
}

main().catch((e) => { console.error('探针异常：', e); process.exit(1) })

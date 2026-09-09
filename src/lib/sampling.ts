// ─── 采样参数兼容性辅助 ───
// 三层策略的前端部分：协议硬钳制（本文件范围表）+ 已知模型族软提示（正则表）+ 探针结果。
// 后端另有第 3 层兜底（上游 400 时 mismatchHint 给出中文建议）。

import type { AIProviderProfile } from '@/types'

/** 各协议的采样参数合法范围（claude 0-1，openai 系 0-2） */
export function samplingRange(type: AIProviderProfile['type'] | string): { temperatureMax: number; topPMax: number } {
  if (type === 'claude') return { temperatureMax: 1, topPMax: 1 }
  return { temperatureMax: 2, topPMax: 1 }
}

/**
 * 已知模型族采样特性提示（软提示，不强制——模型迭代快，表格只做教育用途）。
 * 命中返回中文说明，未命中返回空串。
 */
const MODEL_SAMPLING_HINTS: { pattern: RegExp; hint: string }[] = [
  {
    pattern: /^(o1|o3|o4)[-_.]?/i,
    hint: 'OpenAI 推理模型（o 系列不接受自定义 temperature/top_p，参数会被忽略或报错）',
  },
  {
    pattern: /(^|\/|-)(deepseek-r1|qwq|glm-zero|kimi-k2-thinking)/i,
    hint: '推理类模型对采样参数不敏感或忽略，温度设置可能无效',
  },
  {
    pattern: /gemini/i,
    hint: 'Gemini 模型 temperature 范围为 0-2，top_p 0-1',
  },
  {
    pattern: /gpt-5|gpt-4\.1/i,
    hint: '较新的 GPT 模型推荐用默认采样，仅 temperature 支持 0-2',
  },
  {
    pattern: /doubao|ernie|hunyuan/i,
    hint: '国产模型温度范围各异（多为 0-1 或 0-2），超出范围会被拒绝',
  },
]

export function modelSamplingHint(model: string): string {
  const m = String(model || '').trim()
  if (!m) return ''
  for (const { pattern, hint } of MODEL_SAMPLING_HINTS) {
    if (pattern.test(m)) return hint
  }
  return ''
}

/** 探针结果 → 用户可读文案 */
export function toppProbeLabel(toppSupported?: boolean | null): string {
  if (toppSupported === true) return '已实测支持 top_p'
  if (toppSupported === false) return '已实测不支持 top_p（发送该字段将被拒绝）'
  return '尚未实测 top_p 支持情况'
}

/**
 * 可选的使用统计（Aptabase）。
 *
 * 只有构建时提供 `MYTHPEN_APTABASE_KEY`，Rust 侧才会注册插件；
 * 否则这里的调用会静默失败，不发任何网络请求。
 *
 * 只上报事件名与少量粗粒度属性，不含项目名、正文或任何用户内容。
 */

type Props = Record<string, string | number>

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function track(event: string, props?: Props): void {
  if (!inTauri()) return
  try {
    const internals = (window as any).__TAURI_INTERNALS__
    const result = internals?.invoke('plugin:aptabase|track_event', { eventName: event, props })
    if (result && typeof result.catch === 'function') result.catch(() => {})
  } catch {
    // 统计绝不影响主流程
  }
}

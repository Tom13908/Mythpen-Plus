/**
 * 导入旧稿的客户端预处理。
 *
 * 分两件事做，都交给浏览器：
 * - TXT：解码。浏览器自带完整编码表，能试 utf-8 / gbk / big5，
 *   服务端（Bun 编译的 sidecar）不保证有 GBK 解码器。
 * - EPUB：不做解析，只把字节转 base64 交给服务端。
 *   解析放服务端可以避免把 zip 库打进主包。
 */

/** 首选 utf-8；中文旧稿常见 GBK / Big5。 */
const ENCODINGS = ['utf-8', 'gbk', 'big5'] as const

export type DecodeWarning = 'encodingFallback' | 'unknownEncoding'

export interface DecodedText {
  text: string
  encoding: string
  warning?: DecodeWarning
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 严格解码：只要有一个非法字节就抛错，用来判定「这个编码不对」。 */
function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export async function readTextFile(file: File): Promise<DecodedText> {
  const bytes = new Uint8Array(await file.arrayBuffer())

  // 有 BOM 就直接按 BOM 指定的编码读，别去猜
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(new TextDecoder('utf-8').decode(bytes)), encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: stripBom(new TextDecoder('utf-16le').decode(bytes)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: stripBom(new TextDecoder('utf-16be').decode(bytes)), encoding: 'utf-16be' }
  }

  for (const enc of ENCODINGS) {
    const text = tryDecode(bytes, enc)
    if (text != null) {
      return { text: stripBom(text), encoding: enc, warning: enc === 'utf-8' ? undefined : 'encodingFallback' }
    }
  }
  // 全都解不干净：用非严格 utf-8 兜底，把替换字符留给用户自己看
  return { text: stripBom(new TextDecoder('utf-8').decode(bytes)), encoding: 'utf-8', warning: 'unknownEncoding' }
}

/** ArrayBuffer → base64。分块处理，避免大文件把调用栈撑爆。 */
export async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

export function isEpubFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.epub')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ─── 工具语法清洗 ───
//
// 当模型被要求使用工具、但请求里没有注册任何工具时（典型是我们的「续写」路径），
// DeepSeek 一类模型会把原生工具语法当普通文本吐出来：
//
//   <｜｜DSML｜｜ calls>
//   <｜｜DSML｜｜ invoke name="list_chapters">
//   </｜｜DSML｜｜ invoke>
//   </｜｜DSML｜｜ calls>
//
// 这些片段一旦落进正文就会污染稿件。这里做**增量**清洗：逐个 chunk 出去，
// 只把还可能是半个标记的尾巴留在缓冲里，既能实时显示又不会漏标记。

const OPEN_TOKEN = String.raw`<[|｜]{1,2}DSML[|｜]{1,2}`;
const START_RE = new RegExp(OPEN_TOKEN);
const KIND_RE = new RegExp(`^${OPEN_TOKEN}\\s*([A-Za-z_]+)\\b[^>]*>`);
const STRAY_TOKEN_RE = new RegExp(String.raw`</?[|｜]{1,2}DSML[|｜]{1,2}[^>]*>`, 'g');
/** 尾部可能是标记的前缀：`<`、`<|`、`<||D`、`<||DSM` … */
const PARTIAL_RE = /<[|｜]{0,2}(?:D(?:S(?:M(?:L)?)?)?)?$/;

function closingRe(kind) {
  return new RegExp(`</\\s*[|｜]{1,2}DSML[|｜]{1,2}\\s*${kind}\\s*>`, 'i');
}

/** 清理一段已确定的文本：去掉孤立标记、压缩多余空行。 */
function tidy(text) {
  return text
    .replace(STRAY_TOKEN_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 移除完整响应里的工具语法（非流式场景用）。
 * 标记前后的正文保留；未闭合的块（多是被输出上限截断）丢到结尾。
 */
function stripToolMarkup(text) {
  if (!text || !text.includes('DSML')) return text;

  let out = '';
  let rest = text;
  while (rest) {
    const start = rest.search(START_RE);
    if (start === -1) {
      out += rest;
      break;
    }
    out += rest.slice(0, start);
    rest = rest.slice(start);

    const kindMatch = rest.match(KIND_RE);
    const closeMatch = closingRe(kindMatch ? kindMatch[1] : 'calls').exec(rest);
    if (!closeMatch) break;
    rest = rest.slice(closeMatch.index + closeMatch[0].length);
  }

  return tidy(out).trim();
}

/**
 * 增量清洗器：把流式 chunk 逐个喂进来，返回可以安全下发的文本。
 * 未闭合的标记块会留在内部缓冲里，等后续 chunk 补齐。
 */
class ToolMarkupScrubber {
  constructor() {
    this.buf = '';
  }

  /** 返回本次可以安全发送的文本（可能为空串）。 */
  push(chunk) {
    this.buf += chunk || '';
    let out = '';

    // 一块可能包含多个标记块，循环直到没有完整块可切
    for (;;) {
      const start = this.buf.search(START_RE);
      if (start === -1) {
        // 没有标记：把「可能是标记前缀」的尾巴留下，其余直接下发
        const cut = this._safeCut();
        out += this.buf.slice(0, cut);
        this.buf = this.buf.slice(cut);
        break;
      }

      out += this.buf.slice(0, start);
      this.buf = this.buf.slice(start);

      const kindMatch = this.buf.match(KIND_RE);
      const closeMatch = closingRe(kindMatch ? kindMatch[1] : 'calls').exec(this.buf);
      if (!closeMatch) break; // 还没闭合，等更多数据
      this.buf = this.buf.slice(closeMatch.index + closeMatch[0].length);
    }

    return tidy(out);
  }

  /** 流结束时调用：把残留缓冲清掉（未闭合的标记块整块丢弃）。 */
  flush() {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return '';
    return stripToolMarkup(rest);
  }

  /** 缓冲区里最后一段可能是标记前缀的位置。 */
  _safeCut() {
    const tail = this.buf.slice(-16);
    const m = tail.match(PARTIAL_RE);
    if (m && m[0].startsWith('<')) return this.buf.length - m[0].length;
    return this.buf.length;
  }
}

module.exports = { stripToolMarkup, ToolMarkupScrubber };

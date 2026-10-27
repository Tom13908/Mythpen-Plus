/**
 * 旧稿导入：TXT / EPUB → 项目 + 分卷 + 章节。
 *
 * 设计取舍：
 * - 解析放在服务端。EPUB 是 zip，服务端用 jszip 解；前端只负责「读文件 + 解码成文本」，
 *   这样主包不会因为导入功能变大。
 * - 章节切分只认标题特征，不做 AI 判断 —— 快、可预测、失败可解释。AI 只在
 *   「补充人物设定」这种可选步骤里出现（没有 API Key 也能导入）。
 * - 导入结果必须与原稿一致：正文一字不改，只切边界。不做摘要、不生成大纲。
 */

const path = require('path');
const { CHAPTER_LABEL_RE, VOLUME_LABEL_RE } = require('./titles');

/** 单本上限：约 300 万字。再大就不适合放进一个项目库。 */
const MAX_TEXT_CHARS = 6_000_000;
const MAX_CHAPTERS = 5000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const FALLBACK_TARGET_CHARS = 10_000;
const HEADING_MAX_LEN = 40;

function tooBig(text) {
  return text.length > MAX_TEXT_CHARS;
}

function normalizeNewlines(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

/** 标题行判定：短、不像句子、且带章节/分卷标签。 */
function isHeadingLine(raw) {
  const line = String(raw || '').trim();
  if (!line || line.length > HEADING_MAX_LEN) return false;
  // 句子结尾的标点说明这是正文，不是标题
  if (/[。！？!?，,；;]$/.test(line)) return false;
  return CHAPTER_LABEL_RE.test(line) || VOLUME_LABEL_RE.test(line);
}

function isVolumeLine(raw) {
  const line = String(raw || '').trim();
  if (!line || line.length > HEADING_MAX_LEN) return false;
  if (/[。！？!?，,；;]$/.test(line)) return false;
  return VOLUME_LABEL_RE.test(line);
}

/** 无章节标记时按篇幅均分，标题用「第N章」。 */
function fallbackVolumes(lines) {
  const chapters = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    const content = buf.join('\n').trim();
    if (!content) {
      buf = [];
      size = 0;
      return;
    }
    chapters.push({ title: `第${chapters.length + 1}章`, content });
    buf = [];
    size = 0;
  };
  for (const line of lines) {
    buf.push(line);
    size += line.length;
    // 只在空行处切，避免把段落劈成两半
    if (size >= FALLBACK_TARGET_CHARS && !line.trim()) flush();
  }
  flush();
  return chapters.length ? [{ title: '第一卷', chapters }] : [];
}

/**
 * 解析纯文本。
 * @returns {{volumes: Array<{title: string, chapters: Array<{title: string, content: string}>}>, warnings: Array<object>}}
 */
function parseTxt(rawText) {
  const text = normalizeNewlines(rawText);
  const lines = text.split('\n');
  const warnings = [];

  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) marks.push({ index: i, title: lines[i].trim(), volume: isVolumeLine(lines[i]) });
  }

  if (marks.length === 0) {
    warnings.push({ code: 'noChapterMarkers' });
    return { volumes: fallbackVolumes(lines), warnings };
  }

  const volumes = [];
  let volume = { title: '第一卷', chapters: [] };
  let chapter = null;

  const closeChapter = (endIndex) => {
    if (!chapter) return;
    const content = lines
      .slice(chapter.startIndex, endIndex)
      .join('\n')
      .trim();
    // 空的标题行（只有标题没有正文）不丢：留一个空章，作者自己能补
    volume.chapters.push({ title: chapter.title, content });
    chapter = null;
  };

  const closeVolume = () => {
    if (volume.chapters.length > 0) volumes.push(volume);
    volume = { title: '第一卷', chapters: [] };
  };

  // 首个标记之前的正文：只要非空就留下。旧稿开头常是书名、作者、简介，
  // 丢掉就是数据损失 —— 宁可多一个「前言」章，也不吞内容。
  const head = lines.slice(0, marks[0].index).join('\n').trim();
  if (head) volume.chapters.push({ title: '前言', content: head });

  for (let m = 0; m < marks.length; m++) {
    const mark = marks[m];

    if (mark.volume) {
      closeChapter(mark.index);
      // 当前卷只有「前言」时不要另起一卷：直接把卷名给它，
      // 否则会出现「第一卷（只有前言）+ 第一卷 风起」这种多余的空卷。
      if (volume.chapters.length === 1 && volume.chapters[0].title === '前言') {
        volume.title = mark.title;
      } else {
        closeVolume();
        volume.title = mark.title;
      }
      continue;
    }

    closeChapter(mark.index);
    chapter = { title: mark.title, startIndex: mark.index + 1 };
  }
  closeChapter(lines.length);
  closeVolume();

  if (volumes.length === 0) {
    warnings.push({ code: 'noChapterMarkers' });
    return { volumes: fallbackVolumes(lines), warnings };
  }
  return { volumes, warnings };
}

// ─── EPUB ───

function decodeEntities(input) {
  return String(input)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pick(html, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(String(html));
  return m ? htmlToText(m[1]).split('\n')[0].trim() : '';
}

/**
 * 解析 EPUB。
 * @param {Buffer} buffer
 * @returns {Promise<{title: string, author: string, volumes: Array, warnings: Array}>}
 */
async function parseEpub(buffer) {
  let JSZip;
  try {
    JSZip = require('jszip');
  } catch {
    throw Object.assign(new Error('缺少解压组件，无法读取 EPUB'), { code: 'EPUB_UNSUPPORTED' });
  }
  const zip = await JSZip.loadAsync(buffer);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw Object.assign(new Error('EPUB 结构不完整：缺少 META-INF/container.xml'), { code: 'INVALID_EPUB' });
  }
  const container = await containerFile.async('string');
  const opfPath = /full-path="([^"]+)"/i.exec(container)?.[1];
  if (!opfPath) throw Object.assign(new Error('EPUB 结构不完整：找不到 OPF 文件'), { code: 'INVALID_EPUB' });

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw Object.assign(new Error('EPUB 结构不完整：OPF 文件缺失'), { code: 'INVALID_EPUB' });
  const opf = await opfFile.async('string');
  const baseDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

  const title = pick(opf, 'dc:title') || '';
  const author = pick(opf, 'dc:creator') || '';

  // manifest: id → { href, type }
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/i.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    const type = /\bmedia-type="([^"]+)"/i.exec(tag)?.[1] || '';
    if (id && href) manifest.set(id, { href, type });
  }

  const order = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*\/?>/gi)) {
    const idref = /\bidref="([^"]+)"/i.exec(m[0])?.[1];
    if (idref && manifest.has(idref)) order.push(manifest.get(idref));
  }

  const warnings = [];
  if (order.length === 0) {
    warnings.push({ code: 'emptyBook' });
    return { title, author, volumes: [], warnings };
  }

  const chapters = [];
  for (const item of order) {
    if (!/x?html/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue;
    const rel = decodeURIComponent(item.href.split('#')[0]);
    const full = baseDir ? path.posix.join(baseDir, rel) : rel;
    const file = zip.file(full) || zip.file(rel);
    if (!file) continue;
    const raw = await file.async('string');
    const text = htmlToText(raw);
    if (text.length < 20) continue;
    const heading = pick(raw, 'h1') || pick(raw, 'h2') || pick(raw, 'h3') || pick(raw, 'title');
    // 大多数 EPUB 第一行就是标题（<h1>）。标题已经单独存了，正文里再留一遍
    // 会让每章开头重复一次，导出时更明显。
    let body = text;
    if (heading) {
      const lines = body.split('\n');
      if (lines[0] && lines[0].trim() === heading) body = lines.slice(1).join('\n').trim();
    }
    chapters.push({
      title: heading || `第${chapters.length + 1}章`,
      content: body,
    });
    if (chapters.length >= MAX_CHAPTERS) {
      warnings.push({ code: 'tooManyChapters' });
      break;
    }
  }

  if (chapters.length === 0) {
    warnings.push({ code: 'emptyBook' });
    return { title, author, volumes: [], warnings };
  }
  return { title, author, volumes: [{ title: '第一卷', chapters }], warnings };
}

module.exports = {
  MAX_TEXT_CHARS,
  MAX_CHAPTERS,
  MAX_FILE_BYTES,
  parseTxt,
  parseEpub,
  htmlToText,
  tooBig,
};

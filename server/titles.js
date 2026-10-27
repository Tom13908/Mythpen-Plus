/**
 * 章节/分卷标题格式化，导出与提示词共用。
 *
 * 导入或 AI 生成的标题可能已自带标签（"第一章 风起"、"第一卷 · 完美样本"）。
 * 这些函数避免把标签前缀再加一遍，否则导出会出现"第三章 第三章 风起"。
 */

const CN_NUM = '[0-9０-９零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+';

const VOLUME_LABEL_RE = new RegExp(
  `^(?:第\\s*${CN_NUM}\\s*[卷部集]|卷\\s*${CN_NUM}|(?:volume|book|part)\\s*(?:[0-9]+|[ivxlcdm]+)|上卷|中卷|下卷|上部|中部|下部)`,
  'i',
);

const CHAPTER_LABEL_RE = new RegExp(
  `^(?:第\\s*${CN_NUM}\\s*[章节回话話幕集]|(?:chapter|chap\\.?|ch\\.?)\\s*(?:[0-9]+|[ivxlcdm]+)|` +
    '序章|序言|序|楔子|引子|前言|后记|尾声|终章|尾章|番外(?:篇)?|外传|附录|完本感言|prologue|epilogue)',
  'i',
);

/** 章节显示标题：已带标签就原样返回，否则补「第N章」。 */
function chapterHeading(ch) {
  const title = (ch && ch.title ? String(ch.title) : '').trim();
  if (!title) return `第${ch.num}章`;
  return CHAPTER_LABEL_RE.test(title) ? title : `第${ch.num}章 ${title}`;
}

/** 分卷显示标题：已带标签就原样返回，否则补「第N卷」。 */
function volumeHeading(vol) {
  const title = (vol && vol.title ? String(vol.title) : '').trim();
  const order = vol && (vol.sort_order ?? vol.sortOrder ?? vol.id);
  if (!title) return `第${order}卷`;
  return VOLUME_LABEL_RE.test(title) ? title : `第${order}卷 ${title}`;
}

module.exports = { chapterHeading, volumeHeading, CHAPTER_LABEL_RE, VOLUME_LABEL_RE };

/**
 * 写作语言自动判定。
 *
 * 为什么不加设置项：写作语言只有一处在用 —— 给模型的「写作语言」那一行提示。
 * 让作者去设置里选一次，等于让他维护一个本该自动得出的值；而且项目中途改用外语
 * 写作时，设置项还会滞留在旧值上。
 *
 * 判定优先级（高 → 低）：
 *   1. 与 AI 最近几轮对话的用词 —— 作者正在用这种语言下指令，最能代表意图
 *   2. 最近改动的章节正文 —— 已经写出来的东西
 *   3. 应用界面语言 —— 兜底，作者还在空项目阶段时用
 *
 * 只输出「有把握」的结果：样本不足或平分时返回 null，让调用方干脆不写这一行。
 * 写错一行语言提示比不写更糟 —— 模型会照着错的语言走。
 */

const LANG_NAMES = {
  zh: '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  es: 'Español',
  ru: 'Русский',
};

const SUPPORTED = new Set(Object.keys(LANG_NAMES));

/** 判定样本下限：少于此数不足以判断，宁可不说。 */
const MIN_SAMPLE_CHARS = 12;
/** 主文字占比门槛：低于它视为混排、不判。 */
const DOMINANCE = 0.5;

// 繁/简判别样本。只收录「简繁不同形且常用」的字，避免生僻字干扰。
const TRADITIONAL_MARKERS = '們個這說時裡為對國會來後學點麼樣開關無發現實電腦書車東馬長門問間讓給帶還經過聽寫讀講話頭體變應該當藝術樂習歲華萬與專業團結鳥魚龍鳳';
const SIMPLIFIED_MARKERS = '们个这说时里为对国会来后学点么样开关无发现实电脑书车东马长门问间让给带还经过听写读讲话头体变应该当艺术乐习岁华万与专业团结鸟鱼龙凤';

function countScripts(text) {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  const total = han + kana + hangul + cyrillic + latin;
  return { han, kana, hangul, cyrillic, latin, total };
}

function sinaRatio(text, markers) {
  const hit = new Set();
  for (const ch of text) if (markers.includes(ch)) hit.add(ch);
  return hit.size;
}

/** 拉丁文字细分：法语、西班牙语有稳定特征，其余按英语处理。 */
function classifyLatin(text) {
  const lower = ` ${text.toLowerCase()} `;
  let fr = 0;
  let es = 0;
  for (const w of [' le ', ' la ', ' les ', ' des ', ' une ', ' est ', ' dans ', ' pour ', ' avec ', ' que ', ' qui ', ' pas ']) {
    if (lower.includes(w)) fr++;
  }
  for (const w of [' el ', ' la ', ' los ', ' las ', ' que ', ' de ', ' en ', ' y ', ' es ', ' un ', ' una ', ' por ', ' con ', ' para ']) {
    if (lower.includes(w)) es++;
  }
  // 变音符号：ç / œ 只有法语用；ñ / ¿ / ¡ 只有西班牙语用
  if (/[çœ]/i.test(text)) fr += 3;
  if (/[ñ¿¡]/i.test(text)) es += 3;
  if (fr > es && fr >= 2) return 'fr';
  if (es > fr && es >= 2) return 'es';
  return 'en';
}

/**
 * 从一段文本判定写作语言。
 * @returns {{code: string, confidence: number} | null} null = 样本不足或无把握
 */
function detectFromText(text) {
  if (!text || typeof text !== 'string') return null;
  // 去掉代码块、URL、表格线：它们会把拉丁字母比例抬高，误判成英语
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\|/g, ' ');
  const s = countScripts(prose);
  if (s.total < MIN_SAMPLE_CHARS) return null;

  const share = (n) => n / s.total;

  if (share(s.hangul) >= DOMINANCE) return { code: 'ko', confidence: share(s.hangul) };
  // 日语：假名一定参与。只有汉字没有假名的文本按中文处理。
  if (s.kana > 0 && share(s.kana + s.han) >= DOMINANCE) {
    return { code: 'ja', confidence: share(s.kana + s.han) };
  }
  if (share(s.han) >= DOMINANCE) {
    const tr = sinaRatio(prose, TRADITIONAL_MARKERS);
    const si = sinaRatio(prose, SIMPLIFIED_MARKERS);
    // 两种标记都出现时，谁多听谁的；都没出现就按简体（默认用户群）
    const code = tr > si ? 'zh-TW' : 'zh';
    const conf = tr + si > 0 ? Math.max(tr, si) / (tr + si) : 1;
    return { code, confidence: conf };
  }
  if (share(s.cyrillic) >= DOMINANCE) return { code: 'ru', confidence: share(s.cyrillic) };
  if (share(s.latin) >= DOMINANCE) return { code: classifyLatin(prose), confidence: share(s.latin) };
  return null;
}

/** 应用界面语言（config.db 的 app_settings） */
function uiLanguage() {
  try {
    const db = require('./db');
    const row = db.dbGet("SELECT value FROM app_settings WHERE key = 'ui_language'");
    const code = row && row.value;
    return SUPPORTED.has(code) ? code : null;
  } catch {
    return null;
  }
}

function chatSample(pdb, limit = 3) {
  try {
    const rows = pdb
      .prepare("SELECT content FROM chat_messages WHERE role = 'user' ORDER BY rowid DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => r.content).join('\n');
  } catch {
    return '';
  }
}

function chapterSample(pdb) {
  try {
    const row = pdb
      .prepare("SELECT content FROM chapters WHERE content != '' ORDER BY updated_at DESC LIMIT 1")
      .get();
    return row ? String(row.content).slice(0, 4000) : '';
  } catch {
    return '';
  }
}

/**
 * 解析该项目的写作语言。
 * @param {object} pdb 已打开的项目库
 * @returns {{code: string, name: string, source: 'chat'|'chapter'|'ui'} | null}
 */
function resolveWritingLanguage(pdb) {
  const fromChat = detectFromText(chatSample(pdb));
  if (fromChat) return { code: fromChat.code, name: LANG_NAMES[fromChat.code], source: 'chat' };

  const fromChapter = detectFromText(chapterSample(pdb));
  if (fromChapter) return { code: fromChapter.code, name: LANG_NAMES[fromChapter.code], source: 'chapter' };

  const ui = uiLanguage();
  if (ui) return { code: ui, name: LANG_NAMES[ui], source: 'ui' };

  return null;
}

module.exports = {
  LANG_NAMES,
  detectFromText,
  resolveWritingLanguage,
};

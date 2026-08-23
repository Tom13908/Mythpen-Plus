/**
 * Shared project context builder — extracts current project state
 * from the database and formats it for injection into system prompts.
 */
const db = require('../db');

const GENRE_LABELS = {
  'sci-fi': '科幻', 'fantasy': '玄幻', 'romance': '言情',
  'history': '历史', 'urban': '都市', 'power-fantasy': '爽文',
  'biography': '传记', 'other': '其他',
};

const MODE_LABELS = {
  'short-story': '短篇（<=3万字）',
  'medium-novel': '中篇（5-10万字）',
  'long-novel': '长篇（20万字+）',
};

const PHASE_LABELS = {
  idea: '选题', setting: '设定', outline: '大纲',
  writing: '写作', review: '审阅', consistency: '一致性', export: '导出',
};

function buildProjectContext(projectName) {
  try {
    const pdb = db.getProjectDb(projectName);
    const meta = {};
    pdb.prepare('SELECT key, value FROM project_meta').all().forEach(m => meta[m.key] = m.value);
    const genres = pdb.prepare('SELECT genre FROM project_genres').all().map(g => g.genre);
    const chars = pdb.prepare('SELECT * FROM characters').all();
    const chapters = pdb.prepare('SELECT num, title, outline, status FROM chapters ORDER BY num').all();
    const foreshadows = pdb.prepare("SELECT * FROM foreshadows WHERE status IN ('planted','progressing')").all();

    const genreStr = genres.map(g => GENRE_LABELS[g] || g).join('、') || '未设定';
    // 篇幅提示：用户设定过目标字数则按目标推算档位，否则回退到模式默认
    const customTarget = parseInt(meta.target_words, 10) || 0;
    let modeStr;
    if (customTarget > 0) {
      const label = customTarget < 50000 ? '短篇' : customTarget < 150000 ? '中篇' : '长篇';
      modeStr = `${label}（目标约${Math.round(customTarget / 10000)}万字）`;
    } else {
      modeStr = MODE_LABELS[meta.mode] || meta.mode || '中篇';
    }
    const langStr = meta.language === 'en' ? 'English' : '中文';
    const phaseStr = PHASE_LABELS[meta.workflow_phase] || meta.workflow_phase || '选题';

    return `
项目: ${meta.name || projectName}
创作类型: ${genreStr}
篇幅目标: ${modeStr}
写作语言: ${langStr}
当前阶段: ${phaseStr}
当前总字数: ${meta.word_count || '0'}

角色列表:
${chars.map(c => `- ${c.name}（${c.age}岁，${c.gender}）：${c.personality || ''} ${c.background || ''}`).join('\n')}

章节概览:
${chapters.map(ch => `[${ch.status}] 第${ch.num}章 ${ch.title} - ${ch.outline || '（暂无大纲）'}`).join('\n')}

活跃伏笔:
${foreshadows.map(f => `[${f.priority}] ${f.title}：${f.description || ''}`).join('\n')}`;
  } catch(e) {
    return `项目: ${projectName}`;
  }
}

module.exports = { buildProjectContext };

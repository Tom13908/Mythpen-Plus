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

// ─── Token 估算与预算裁剪 ───
// 服务端没有分词器，用启发式估算：中文约 1.5 字符/token（保守取 1.5）。
// 用于"超没超预算"这种粗粒度决策足够，不需要精确到个位数。

function estimateTokens(str) {
  return Math.ceil((str || '').length / 1.5);
}

/**
 * 按预算裁剪章节概览：最近章节保留完整大纲，较早章节先降级为
 * "只留标题"，再不够则整行省略。预算优先保证活跃伏笔与角色设定。
 */
function buildChapterSummary(chapters, budgetToken) {
  const lines = chapters.map(ch => `[${ch.status}] 第${ch.num}章 ${ch.title} - ${ch.outline || '（暂无大纲）'}`);
  if (!budgetToken || budgetToken <= 0) return lines.join('\n');

  // 第一遍：全部保留完整大纲
  let joined = lines.join('\n');
  if (estimateTokens(joined) <= budgetToken) return joined;

  // 第二遍：最近的章节优先保留（小说的连续性靠近期内容），
  // 放不下的更早章节先降级为"只留标题"，再不够则整行省略
  const kept = [];
  let droppedTitles = 0;
  let droppedLines = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const candidate = [...kept, line].join('\n');
    if (estimateTokens(candidate) <= budgetToken) {
      kept.push(line);
      continue;
    }
    // 降级：去掉 "- outline" 部分再试
    const titleOnly = line.split(' - ')[0];
    const candidate2 = [...kept, titleOnly].join('\n');
    if (estimateTokens(candidate2) <= budgetToken) {
      kept.push(titleOnly);
      droppedTitles++;
    } else {
      droppedLines++;
    }
  }
  kept.reverse(); // 恢复章节编号顺序
  const suffix =
    droppedLines + droppedTitles > 0
      ? `\n...（更早的 ${droppedLines + droppedTitles} 章已压缩/省略，如需细节可单独查询）`
      : '';
  return kept.join('\n') + suffix;
}

function buildProjectContext(projectName, budgetToken) {
  if (!projectName) {
    // 无项目上下文（如设置里的连接测试）——绝不能去开库，
    // 否则会凭空创建 "undefined.mythpen.db"
    return '项目:（未指定项目，无项目上下文）';
  }
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
    const phaseStr = PHASE_LABELS[meta.workflow_phase] || meta.workflow_phase || '选题';

    // 预算分配：基础信息（元信息/角色/伏笔）优先，剩余给章节概览
    // 注：不显式声明写作语言——模型可从用户输入/正文直接识别，写死反而会误导外语项目
    const baseInfo = `
项目: ${meta.name || projectName}
创作类型: ${genreStr}
篇幅目标: ${modeStr}
当前阶段: ${phaseStr}
当前总字数: ${meta.word_count || '0'}`;

    const roleLines = chars.map(c => `- ${c.name}（${c.age}岁，${c.gender}）：${c.personality || ''} ${c.background || ''}`).join('\n');
    const roleBlock = `角色列表:\n${roleLines}`;

    const foreshadowBlock = foreshadows.length
      ? `活跃伏笔:\n${foreshadows.map(f => `[${f.priority}] ${f.title}：${f.description || ''}`).join('\n')}`
      : '';

    let chapterBudget = null;
    if (budgetToken && budgetToken > 0) {
      const baseTokens = estimateTokens(baseInfo) + estimateTokens(roleBlock) + estimateTokens(foreshadowBlock) + 60; // 60 = 各区块标题/空行开销
      chapterBudget = budgetToken - baseTokens;
      if (chapterBudget < 200) chapterBudget = 200; // 至少保留一点章节概览
    }

    const chapterBlock = `章节概览:\n${buildChapterSummary(chapters, chapterBudget)}`;

    return `${baseInfo}

${roleBlock}

${chapterBlock}

${foreshadowBlock}`;
  } catch(e) {
    return `项目: ${projectName}`;
  }
}

module.exports = { buildProjectContext, estimateTokens, buildChapterSummary };

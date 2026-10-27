/**
 * 本轮改动的后端验收脚本。
 *
 * 覆盖：角色 role/notes、科学设定编辑/删除、章节编号方式、导出标题去重。
 * 全部在临时项目里做，结束后删除项目，不碰真实数据。
 *
 * 用法：先启动 server（node server/index.js），再 `node scripts/test-new-features.mjs`
 */

const BASE = process.env.BASE || 'http://127.0.0.1:3001/api';
const PROJECT = `tmpcheck-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const enc = encodeURIComponent;

async function main() {
  console.log(`项目：${PROJECT}\n`);

  // ─── 1. 角色 role / notes ───
  console.log('【1】角色定位与备注');
  const created = await api(`/projects`, { method: 'POST', body: { name: PROJECT } });
  ok('建项目', created.status === 200 || created.status === 201, JSON.stringify(created.data).slice(0, 120));

  const c1 = await api(`/${enc(PROJECT)}/characters`, {
    method: 'POST',
    body: { name: '测试主角', role: 'major', notes: '别写死' },
  });
  ok('创建角色返回 201', c1.status === 201, JSON.stringify(c1.data));
  const charId = c1.data?.id;

  const list1 = await api(`/${enc(PROJECT)}/characters`);
  const row = (list1.data || []).find((c) => c.id === charId);
  ok('role 落库为 major', row?.role === 'major', JSON.stringify(row));
  ok('notes 落库', row?.notes === '别写死', JSON.stringify(row?.notes));

  const upd = await api(`/${enc(PROJECT)}/characters/${charId}`, { method: 'PUT', body: { role: 'minor' } });
  ok('改 role 成功', upd.status === 200);
  const list2 = await api(`/${enc(PROJECT)}/characters`);
  ok('role 改为 minor', (list2.data || []).find((c) => c.id === charId)?.role === 'minor');

  const bad = await api(`/${enc(PROJECT)}/characters/${charId}`, { method: 'PUT', body: { role: 'boss' } });
  ok('非法 role 被拒 400', bad.status === 400, `status=${bad.status}`);

  // ─── 2. 科学设定编辑 / 删除 ───
  console.log('\n【2】科学设定编辑与删除');
  const sc = await api(`/${enc(PROJECT)}/science`, {
    method: 'POST',
    body: { label: 'known', name: '曲率航行', description: '初版描述' },
  });
  ok('新建条目 201', sc.status === 201, JSON.stringify(sc.data));
  const scId = sc.data?.id;

  const scUpd = await api(`/${enc(PROJECT)}/science/${scId}`, {
    method: 'PUT',
    body: { name: '曲率航行（改）', description: '改过的描述' },
  });
  ok('PUT 更新成功', scUpd.status === 200, JSON.stringify(scUpd.data));

  const scList = await api(`/${enc(PROJECT)}/science`);
  const scRow = (scList.data || []).find((e) => e.id === scId);
  ok('名称已更新', scRow?.name === '曲率航行（改）', JSON.stringify(scRow));
  ok('描述已更新', scRow?.description === '改过的描述');

  const scEmpty = await api(`/${enc(PROJECT)}/science/${scId}`, { method: 'PUT', body: {} });
  ok('空 body 被拒 400', scEmpty.status === 400, `status=${scEmpty.status}`);

  const scDel = await api(`/${enc(PROJECT)}/science/${scId}`, { method: 'DELETE' });
  ok('删除成功', scDel.status === 200);
  const scGone = (await api(`/${enc(PROJECT)}/science`)).data || [];
  ok('条目已消失', !scGone.some((e) => e.id === scId));

  // ─── 3. 章节编号方式 ───
  console.log('\n【3】章节编号方式');
  const def = await api(`/${enc(PROJECT)}/chapter-numbering`);
  ok('默认 per-volume', def.data?.mode === 'per-volume', JSON.stringify(def.data));

  const vols = (await api(`/${enc(PROJECT)}/volumes`)).data || [];
  const v1 = vols[0]?.id;
  const v2 = await api(`/${enc(PROJECT)}/volumes`, { method: 'POST', body: { title: '第二卷' } });
  const v2id = v2.data?.id ?? v2.data?.id;
  ok('新建第二卷', !!v2id, JSON.stringify(v2.data));

  const before = (await api(`/${enc(PROJECT)}/volumes`)).data?.find((v) => v.id === v2id)?.chapters || [];
  const chB = await api(`/${enc(PROJECT)}/chapters`, { method: 'POST', body: { title: 'B卷第一章', volume_id: v2id } });
  ok('第二卷新章 num=1（每卷独立）', chB.data?.num === 1, `num=${chB.data?.num}`);

  const setGlobal = await api(`/${enc(PROJECT)}/chapter-numbering`, { method: 'PUT', body: { mode: 'global' } });
  ok('切换为 global', setGlobal.status === 200 && setGlobal.data?.mode === 'global');

  const allNums = ((await api(`/${enc(PROJECT)}/volumes`)).data || []).flatMap((v) =>
    (v.chapters || []).map((c) => c.num),
  );
  const maxNum = Math.max(0, ...allNums);
  const chG = await api(`/${enc(PROJECT)}/chapters`, { method: 'POST', body: { title: '全书连续章', volume_id: v2id } });
  ok('global 下 num 接全书最大值', chG.data?.num === maxNum + 1, `got=${chG.data?.num} expect=${maxNum + 1}`);

  const badMode = await api(`/${enc(PROJECT)}/chapter-numbering`, { method: 'PUT', body: { mode: 'x' } });
  ok('非法 mode 被拒 400', badMode.status === 400);

  // ─── 4. 导出标题去重 ───
  console.log('\n【4】导出标题去重');
  // 直接建一个标题已带「第一章」的章节，导出时不应出现「第一章 第一章 …」
  await api(`/${enc(PROJECT)}/chapters`, {
    method: 'POST',
    body: { title: '第一章 风起', volume_id: v1, chapter_num: 999 },
  });
  // 导出只收 content 非空的章节
  await api(`/${enc(PROJECT)}/chapters/999?volume_id=${v1}`, {
    method: 'PUT',
    body: { content: '风起于青萍之末。' },
  });
  const md = await api(`/${enc(PROJECT)}/export?format=md&download=1`);
  const mdText = typeof md.data === 'string' ? md.data : '';
  ok('MD 导出成功', mdText.length > 0, `status=${md.status}`);
  ok('MD 不含重复标题', !mdText.includes('第999章 第一章'), '出现了「第999章 第一章」');
  ok('MD 保留原题', mdText.includes('第一章 风起'));

  const txt = await api(`/${enc(PROJECT)}/export?format=txt&download=1`);
  const txtText = typeof txt.data === 'string' ? txt.data : '';
  ok('TXT 不含重复标题', txtText.length > 0 && !txtText.includes('第999章 第一章'));

  // 排序：每卷独立编号时 num 会重复，导出必须按「卷顺序 → 章号」而不是只按 num
  console.log('\n【4b】导出顺序');
  if (chB.data?.num) {
    await api(`/${enc(PROJECT)}/chapters/${chB.data.num}?volume_id=${v2id}`, {
      method: 'PUT',
      body: { content: '第二卷的正文。' },
    });
  }
  const md2 = await api(`/${enc(PROJECT)}/export?format=md&download=1`);
  const md2Text = typeof md2.data === 'string' ? md2.data : '';
  const iVol1 = md2Text.indexOf('第一章 风起');
  const iVol2 = md2Text.indexOf('B卷第一章');
  ok('两章都进了导出', iVol1 >= 0 && iVol2 >= 0, `vol1=${iVol1} vol2=${iVol2}`);
  ok('第一卷章节排在第二卷之前', iVol1 >= 0 && iVol2 >= 0 && iVol1 < iVol2, `vol1=${iVol1} vol2=${iVol2}`);

  // ─── 5. 清理 ───
  console.log('\n【5】清理');
  const del = await api(`/projects/${enc(PROJECT)}`, { method: 'DELETE' });
  ok('删除测试项目', del.status === 200);

  console.log('\n────────────────────────────────');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本出错：', e);
  process.exit(1);
});

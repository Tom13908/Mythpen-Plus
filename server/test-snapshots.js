// ─── 里程碑快照集成测试 ───
// 覆盖：创建时自动留「初始状态」、共创产物写入后还原回初始状态、
//       还原本身可撤销（还原前自动留安全副本）、损坏快照不得覆盖现役库、
//       非法 id 被拒、删除项目时清理快照、迁移存储目录不丢快照。
//
// Usage: node server/test-snapshots.js
// Requires Express server running (BASE，默认 http://localhost:3001/api)。
// 注意：本脚本只操作自己的测试项目，不会碰其他项目的数据。

const BASE = process.env.BASE || 'http://localhost:3001/api';
const P = `snaptest-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;

function assert(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: ${detail === undefined ? 'FAILED' : JSON.stringify(detail)}`);
  }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 无响应体（如 204） */
  }
  return { status: res.status, ok: res.ok, data };
}

/** 断言某次请求以指定状态码 / 错误码失败。返回响应便于进一步检查。 */
async function expectFail(label, method, path, body, wantStatus, wantCode) {
  const r = await api(method, path, body);
  const codeOk = wantCode === undefined || r.data?.error?.code === wantCode;
  assert(
    label,
    r.status === wantStatus && codeOk,
    `期望 ${wantStatus}${wantCode ? `/${wantCode}` : ''}，实际 ${r.status}/${r.data?.error?.code}`,
  );
  return r;
}

const snap = (path = '') => `/${encodeURIComponent(P)}/snapshots${path}`;

async function main() {
  console.log(`\n项目名：${P}\n`);

  // ─── 0. 建项目 → 自动留下「初始状态」───
  console.log('【0】建项目并自动留下初始状态');
  const created = await api('POST', '/projects', {
    name: P,
    mode: 'medium-novel',
    language: 'zh',
    genres: ['奇幻', '悬疑'],
  });
  assert('创建项目', created.ok, created.data);

  // 核心需求：项目一建立就该有一份「库里什么都没有」的快照，且不需要客户端额外发请求。
  // 这条断言刻意不自己调 POST /snapshots —— 它验的是自动化，不是接口能不能用。
  const autoList = await api('GET', snap());
  const auto = autoList.data?.snapshots?.find((s) => s.kind === 'initial');
  assert('建项目后自动出现 1 条 initial 快照', autoList.data?.snapshots?.length === 1 && !!auto, autoList.data?.snapshots);
  assert('自动快照 kind 为 initial', auto?.kind === 'initial', auto?.kind);
  assert(
    '自动快照就是「空库」：0 章、0 角色、0 会话',
    auto?.stats?.chapters === 0 && auto?.stats?.characters === 0 && auto?.stats?.chatSessions === 0,
    auto?.stats,
  );
  assert('自动快照没有封面', auto?.hasCover === false, auto?.hasCover);

  // 显式再要一次 initial 必须幂等：前端重复进入、重试建项目都不该堆出第二份。
  const again = await api('POST', snap(), { kind: 'initial', label: '初始状态' });
  assert(
    '重复请求初始快照是幂等的（200 且同一个 id）',
    again.status === 200 && again.data?.id === auto?.id,
    { status: again.status, id: again.data?.id, first: auto?.id },
  );

  const initial = { data: auto };

  // ─── 1. 准备：第 1 章 ───
  console.log('\n【1】准备：建第 1 章');
  const ch = await api('POST', `/${encodeURIComponent(P)}/chapters`, { title: '第1章' });
  assert('创建第 1 章', ch.status === 201, ch.data);

  // ─── 2. 模拟 AI 共创写入叙事元素 ───
  console.log('\n【2】模拟 AI 共创写入（2 角色 / 1 世界观 / 1 伏笔 / 1 会话 + 消息 / 章节正文）');
  const c1 = await api('POST', `/${encodeURIComponent(P)}/characters`, { name: '林晚', personality: '谨慎' });
  const c2 = await api('POST', `/${encodeURIComponent(P)}/characters`, { name: '周叙', personality: '莽撞' });
  assert('写入 2 个角色', c1.status === 201 && c2.status === 201, [c1.status, c2.status]);
  const w1 = await api('POST', `/${encodeURIComponent(P)}/world`, {
    category: 'location',
    name: '雾港',
    description: '终年不散的港口',
  });
  assert('写入世界观', w1.status === 201, w1.status);
  const f1 = await api('POST', `/${encodeURIComponent(P)}/foreshadows`, {
    title: '灯塔里的人影',
    description: '第 3 章回收',
  });
  assert('写入伏笔', f1.status === 201, f1.status);

  const sess = await api('POST', `/${encodeURIComponent(P)}/chat/sessions`, { title: '开局共创' });
  assert('创建会话', sess.status === 201, sess.data);
  const msg = await api('POST', `/${encodeURIComponent(P)}/chat/messages`, {
    role: 'user',
    content: '来个悬疑开局',
    session_id: sess.data?.id,
  });
  assert('写入会话消息', msg.status === 201, msg.status);

  const put = await api('PUT', `/${encodeURIComponent(P)}/chapters/1`, {
    content: '雾从港口漫上来，林晚数着靠岸的船。',
    status: 'review',
  });
  assert('写入章节正文并定稿为 review', put.ok, put.data);

  const beforeRestore = await api('GET', `/${encodeURIComponent(P)}/characters`);
  assert('还原前角色数为 2', beforeRestore.data?.length === 2, beforeRestore.data?.length);
  const chBefore = await api('GET', `/${encodeURIComponent(P)}/chapters/1`);
  assert('还原前章节有正文', (chBefore.data?.content || '').length > 0, chBefore.data?.content);

  // ─── 3. 手动里程碑 ───
  console.log('\n【3】手动打点');
  const manual = await api('POST', snap(), { label: '开局共创完成后' });
  assert('创建手动里程碑', manual.status === 201, manual.data);
  assert('kind 为 manual', manual.data?.kind === 'manual', manual.data?.kind);
  assert('手动里程碑记录到 2 角色', manual.data?.stats?.characters === 2, manual.data?.stats);

  const listBefore = await api('GET', snap());
  assert('列表共 2 条', listBefore.data?.snapshots?.length === 2, listBefore.data?.snapshots?.length);
  assert('列表按时间倒序，最新在前', listBefore.data?.snapshots?.[0]?.id === manual.data?.id, listBefore.data?.snapshots?.[0]?.label);

  // ─── 4. 还原到初始状态（核心场景）───
  console.log('\n【4】还原到初始状态');
  const restore = await api('POST', snap(`/${initial.data.id}/restore`), {});
  assert('还原成功', restore.ok, restore.data);
  assert('还原前自动留下了安全副本', restore.data?.safetySnapshot?.kind === 'safety', restore.data?.safetySnapshot?.kind);
  assert(
    '安全副本记录了还原前的 2 个角色',
    restore.data?.safetySnapshot?.stats?.characters === 2,
    restore.data?.safetySnapshot?.stats,
  );

  const afterChars = await api('GET', `/${encodeURIComponent(P)}/characters`);
  const afterWorld = await api('GET', `/${encodeURIComponent(P)}/world`);
  const afterFores = await api('GET', `/${encodeURIComponent(P)}/foreshadows`);
  const afterSess = await api('GET', `/${encodeURIComponent(P)}/chat/sessions`);
  const afterCh = await api('GET', `/${encodeURIComponent(P)}/chapters/1`);
  assert('角色被清空', afterChars.data?.length === 0, afterChars.data?.length);
  assert('世界观被清空', afterWorld.data?.length === 0, afterWorld.data?.length);
  assert('伏笔被清空', afterFores.data?.length === 0, afterFores.data?.length);
  assert('会话被清空', afterSess.data?.length === 0, afterSess.data?.length);
  // 自动快照取在建项目那一刻，那时第 1 章还没被创建，所以还原后章节也不该在。
  assert('第 1 章也被退回（初始状态取在首章创建之前）', afterCh.status === 404, { status: afterCh.status, body: afterCh.data });
  const afterVols = await api('GET', `/${encodeURIComponent(P)}/volumes`);
  const afterChCount = (afterVols.data || []).reduce((n, v) => n + (v.chapters || []).length, 0);
  assert('章列表为空', afterChCount === 0, afterChCount);
  assert('卷仍在（空卷是容器）', (afterVols.data || []).length === 1, afterVols.data);
  const afterMeta = await api('GET', `/projects/${encodeURIComponent(P)}`);
  assert('风格关键词仍在', Array.isArray(afterMeta.data?.genres) && afterMeta.data.genres.length === 2, afterMeta.data?.genres);
  assert('工作流阶段回到 idea', afterMeta.data?.workflow_phase === 'idea', afterMeta.data?.workflow_phase);

  // ─── 5. 还原本身可撤销 ───
  console.log('\n【5】还原可撤销（用安全副本退回去）');
  const back = await api('POST', snap(`/${restore.data.safetySnapshot.id}/restore`), {});
  assert('还原安全副本成功', back.ok, back.data);
  const backChars = await api('GET', `/${encodeURIComponent(P)}/characters`);
  assert('角色回到 2 个', backChars.data?.length === 2, backChars.data?.length);
  const backCh = await api('GET', `/${encodeURIComponent(P)}/chapters/1`);
  assert('章节正文回来了', (backCh.data?.content || '').length > 0, backCh.data?.content);

  // ─── 6. 损坏的快照不得覆盖现役库 ───
  console.log('\n【6】损坏快照的防护');
  const info = await api('GET', '/storage-location');
  const fs = require('fs');
  const path = require('path');
  const corruptDir = path.join(info.data.currentDir, 'snapshots', P, initial.data.id);
  const corruptDb = path.join(corruptDir, 'db.mythpen.db');
  const original = fs.readFileSync(corruptDb);
  fs.writeFileSync(corruptDb, Buffer.alloc(64, 0)); // 破坏文件头

  const bad = await expectFail(
    '还原损坏快照被拒（409 SNAPSHOT_CORRUPT）',
    'POST',
    snap(`/${initial.data.id}/restore`),
    {},
    409,
    'SNAPSHOT_CORRUPT',
  );
  const stillThere = await api('GET', `/${encodeURIComponent(P)}/characters`);
  assert('被拒后现役数据未被改动（仍 2 角色）', stillThere.data?.length === 2, stillThere.data?.length);
  const brokenList = await api('GET', snap());
  assert(
    '列表把损坏快照标为 broken',
    brokenList.data?.snapshots?.find((s) => s.id === initial.data.id)?.integrity === 'broken',
    brokenList.data?.snapshots?.find((s) => s.id === initial.data.id)?.integrity,
  );
  fs.writeFileSync(corruptDb, original); // 复原，供后续步骤使用

  // ─── 7. 非法 id ───
  console.log('\n【7】非法快照 id');
  // 注意：整段的 `%2E%2E`（即 `..`）压根到不了处理函数 —— Express 在路由匹配前就把
  // 点段规范化掉了，请求直接 404。这对安全是好事，但也意味着只有"能路由到"的形状
  // （如段内含编码斜杠）才测得到 id 校验本身，所以这里用 `a%2Fb`。
  await expectFail('restore 非法 id 被拒', 'POST', snap('/a%2Fb/restore'), {}, 400, 'INVALID_SNAPSHOT_ID');
  await expectFail('delete 非法 id 被拒', 'DELETE', snap('/a%2Fb'), undefined, 400, 'INVALID_SNAPSHOT_ID');
  await expectFail('delete 含非法字符的 id 被拒', 'DELETE', snap('/ok!.x'), undefined, 400, 'INVALID_SNAPSHOT_ID');
  await expectFail('还原不存在的快照 → 404', 'POST', snap('/20990101-000000-000-zzzz/restore'), {}, 404, 'SNAPSHOT_NOT_FOUND');

  // ─── 8. 删除快照 ───
  console.log('\n【8】删除快照');
  const del = await api('DELETE', snap(`/${manual.data.id}`));
  assert('删除手动里程碑', del.ok, del.data);
  const listAfterDel = await api('GET', snap());
  assert(
    '列表里已不含被删的快照',
    !listAfterDel.data?.snapshots?.some((s) => s.id === manual.data.id),
    listAfterDel.data?.snapshots?.map((s) => s.id),
  );

  // ─── 9. 迁移存储目录不丢快照 ───
  console.log('\n【9】迁移存储目录');
  const migrateDir = fs.mkdtempSync('/tmp/mythpen-snap-migrate-');
  const mig = await api('POST', '/storage-location', { newDir: migrateDir });
  assert('迁移接口返回成功', mig.ok, mig.data);
  const copied = fs.existsSync(path.join(migrateDir, 'snapshots', P, initial.data.id, 'db.mythpen.db'));
  assert('快照已随迁移复制到新目录', copied, path.join(migrateDir, 'snapshots', P));
  fs.rmSync(migrateDir, { recursive: true, force: true });

  // ─── 10. 删除项目时清理快照 ───
  console.log('\n【10】删除项目');
  const snapDir = path.join(info.data.currentDir, 'snapshots', P);
  const projectDelete = await api('DELETE', `/projects/${encodeURIComponent(P)}`);
  assert('删除项目成功', projectDelete.ok, projectDelete.data);
  assert('项目库文件已删除', !fs.existsSync(path.join(info.data.currentDir, 'projects', `${P}.mythpen.db`)));
  assert('快照目录已随之清理', !fs.existsSync(snapDir), snapDir);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\n测试脚本本身出错：', e);
  process.exitCode = 1;
});

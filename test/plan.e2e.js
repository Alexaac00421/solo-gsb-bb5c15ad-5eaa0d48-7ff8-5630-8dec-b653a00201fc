'use strict';
// 隔离建议(最小挂牌方案)端到端回归。
// 使用方式: LOTO_DB=/tmp/loto-plan-test.db PORT=3100 node server.js 后执行 node test/plan.e2e.js
// 覆盖: 建议内容 / 带入预演确认 / 确认须用建议时 revision(STALE_REVISION) /
//       已隔离空步骤 / 不经过开关的来电通路不可行 / 超步数上限不可整单执行且不截断。
const BASE = process.env.BASE || 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}

async function call(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const OP = { actor: '建议回归操作员', role: 'operator' };
const ADMIN = { actor: '建议回归管理员', role: 'admin' };

(async () => {
  let rev = (await call('GET', '/api/state')).data.revision;
  console.log('初始修订号:', rev);
  const S1 = 1, K1 = 3, K3 = 5, D1 = 6, D2 = 7;
  const M = (body) => ({ ...body, revision: rev });
  const state = async () => (await call('GET', '/api/state')).data;

  console.log('\n[G1] 隔离建议: 演示网络中 1#循环水泵 的最少方案为联络开关 K3 一个');
  let r = await call('GET', `/api/devices/${D1}/isolation-plan`);
  ok(r.status === 200 && r.data.ok && r.data.kind === 'isolation.plan', 'HTTP 200 且类型正确');
  ok(r.data.revision === rev, `建议基于当前修订号 ${rev}`);
  ok(r.data.feasible === true && r.data.isolated === false, '可行且当前未隔离');
  ok(r.data.minTags === 1 && r.data.switches.length === 1
    && r.data.switches[0].node_id === K3, '最小集合为联络开关 K3(1 个)');
  ok(r.data.switches[0].open_pos === false && r.data.switches[0].tagged === false,
    '开关携带当前分合/挂牌状态');
  ok(r.data.steps.length === 2
    && r.data.steps[0].action === 'open' && r.data.steps[0].node_id === K3
    && r.data.steps[1].action === 'tag' && r.data.steps[1].node_id === K3,
    '步骤为先分闸再挂牌');
  ok(r.data.stepCount === 2 && r.data.maxOrderSteps === 200
    && r.data.orderExecutable === true, '步数与上限信息完整, 可整单执行');
  ok(r.data.livePath === null, '可行时无见证路径');

  console.log('\n[G2] 建议步骤带入预演: 追加末步许可, 预演通过且不落库');
  const planSteps = r.data.steps;
  r = await call('POST', '/api/orders/preview',
    { ...OP, revision: rev, steps: [...planSteps, { action: 'permit', device_id: D1 }] });
  ok(r.status === 200 && r.data.success === true, '预演通过');
  ok(r.data.steps.length === 3 && r.data.steps[2].isolation.isolated === true,
    '末步许可推演后满足隔离');
  ok((await state()).revision === rev, '预演不改变修订号');

  console.log('\n[G3] 确认必须使用建议时的 revision: 期间网络改变 → 409 + 当前完整状态, 不自动改用新方案');
  const planRev = rev;
  // 期间发生一次无关变更(分闸 K1), 修订号前进
  rev = (await call('POST', `/api/switches/${K1}/open`, M(OP))).data.revision;
  r = await call('POST', '/api/orders/confirm',
    { ...OP, revision: planRev, steps: [...planSteps, { action: 'permit', device_id: D1 }] });
  ok(r.status === 409 && r.data.error.code === 'STALE_REVISION', '过期建议确认 → 409 STALE_REVISION');
  ok(r.data.current && r.data.current.revision === rev
    && Array.isArray(r.data.current.nodes) && Array.isArray(r.data.current.permits),
    '响应携带当前完整状态');
  ok(r.data.current.nodes.find((n) => n.id === K3).tagged === false
    && r.data.current.permits.length === 0, '整单未落库: K3 未挂牌、许可未创建(不自动改用新方案)');

  console.log('\n[G4] 重新获取建议(新 revision)并确认: 原子落库, 修订号只 +1');
  r = await call('GET', `/api/devices/${D1}/isolation-plan`);
  ok(r.data.revision === rev && r.data.minTags === 1, '新建议基于新修订号, 方案不变');
  r = await call('POST', '/api/orders/confirm',
    { ...OP, revision: r.data.revision, steps: [...r.data.steps, { action: 'permit', device_id: D1 }] });
  ok(r.status === 200 && r.data.revision === rev + 1, `确认成功, 修订号 ${rev} → ${r.data.revision}`);
  rev = r.data.revision;
  let cur = await state();
  ok(cur.nodes.find((n) => n.id === K3).tagged === true, 'K3 已挂牌');
  ok(cur.permits.some((p) => p.device_id === D1), 'D1 许可已生效');

  console.log('\n[G5] 已隔离设备: 建议返回空步骤');
  r = await call('GET', `/api/devices/${D1}/isolation-plan`);
  ok(r.data.isolated === true && r.data.minTags === 0
    && r.data.switches.length === 0 && r.data.steps.length === 0,
    '已隔离 → 空步骤');
  ok(r.data.orderExecutable === true, '空单不越限');

  console.log('\n[G6] 不经过开关的来电通路: 不可行 + 一条真实带电路径');
  // 管理员架设 S1→D2 直边(D2 是末端, 不影响 D1 许可)
  let a = await call('POST', '/api/admin/edges', M({ ...ADMIN, from_node: S1, to_node: D2 }));
  ok(a.status === 200, '准备: 架设 S1→D2 直连旁路'); rev = a.data.revision;
  const bypassEdge = a.data.snapshot.edges.find((e) => e.from_node === S1 && e.to_node === D2);
  r = await call('GET', `/api/devices/${D2}/isolation-plan`);
  ok(r.data.feasible === false && r.data.isolated === false, '判定不可行');
  ok(r.data.minTags === null && r.data.steps.length === 0, '无最小集合、不生成步骤');
  ok(r.data.livePath && r.data.livePath.nodes.length === 2
    && r.data.livePath.nodes[0].id === S1 && r.data.livePath.nodes[1].id === D2,
    '见证路径为 S1→D2 直连(不经过开关)');
  a = await call('DELETE', `/api/admin/edges/${bypassEdge.id}`, M(ADMIN));
  ok(a.status === 200, '清理: 拆除直连旁路'); rev = a.data.revision;

  console.log('\n[G7] 步骤按状态生成: 已分闸的开关只需挂牌');
  // K1 在 G3 中已分闸; D2 唯一通路 S1→K1→D2, 建议应只有“挂牌 K1”一步
  r = await call('GET', `/api/devices/${D2}/isolation-plan`);
  ok(r.data.minTags === 1 && r.data.steps.length === 1
    && r.data.steps[0].action === 'tag' && r.data.steps[0].node_id === K1,
    '已分闸开关只生成挂牌步');

  console.log('\n[G8] 非设备目标 → 404');
  r = await call('GET', `/api/devices/${K1}/isolation-plan`);
  ok(r.status === 404, '对开关获取建议 → 404');
  r = await call('GET', '/api/devices/9999/isolation-plan');
  ok(r.status === 404, '不存在的节点 → 404');

  console.log('\n[G9] 结束 D1 许可, 为步数上限场景做准备');
  const permitId = (await state()).permits.find((p) => p.device_id === D1).id;
  rev = (await call('POST', `/api/permits/${permitId}/end`, M(OP))).data.revision;

  console.log('\n[G10] 步骤超单据上限: 明确不可整单执行, 步骤完整不截断');
  // 101 个并联开关(均合闸) → 202 步 > 200
  const COUNT = 101;
  const src = await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'source', name: '建议回归电源' }));
  rev = src.data.revision;
  const srcId = src.data.snapshot.nodes.find((n) => n.name === '建议回归电源').id;
  const dev = await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'device', name: '建议回归设备' }));
  rev = dev.data.revision;
  const devId = dev.data.snapshot.nodes.find((n) => n.name === '建议回归设备').id;
  const swIds = [];
  for (let i = 0; i < COUNT; i++) {
    const s = await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'switch', name: `建议回归K${i}` }));
    rev = s.data.revision;
    const swId = s.data.snapshot.nodes.find((n) => n.name === `建议回归K${i}`).id;
    swIds.push(swId);
    rev = (await call('POST', '/api/admin/edges', M({ ...ADMIN, from_node: srcId, to_node: swId }))).data.revision;
    rev = (await call('POST', '/api/admin/edges', M({ ...ADMIN, from_node: swId, to_node: devId }))).data.revision;
  }
  r = await call('GET', `/api/devices/${devId}/isolation-plan`);
  ok(r.data.feasible === true && r.data.minTags === COUNT, `最小集合 ${COUNT} 个`);
  ok(r.data.stepCount === COUNT * 2 && r.data.steps.length === COUNT * 2,
    `步骤完整 ${COUNT * 2} 步, 不截断`);
  ok(r.data.orderExecutable === false && r.data.maxOrderSteps === 200,
    '明确不可整单执行(orderExecutable=false)');
  r = await call('POST', '/api/orders/preview',
    { ...OP, revision: rev, steps: (await call('GET', `/api/devices/${devId}/isolation-plan`)).data.steps });
  ok(r.status === 400 && r.data.error.code === 'STEPS_TOO_LONG',
    '超上限步骤带入预演 → 400 STEPS_TOO_LONG(不可整单执行)');

  console.log('\n[G11] 清理临时拓扑');
  rev = (await call('DELETE', `/api/admin/nodes/${devId}`, M(ADMIN))).data.revision;
  rev = (await call('DELETE', `/api/admin/nodes/${srcId}`, M(ADMIN))).data.revision;
  for (const id of swIds) {
    rev = (await call('DELETE', `/api/admin/nodes/${id}`, M(ADMIN))).data.revision;
  }
  cur = await state();
  ok(!cur.nodes.some((n) => n.name.startsWith('建议回归')), '临时拓扑已清理');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

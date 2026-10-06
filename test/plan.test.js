'use strict';

// src/plan.js 隔离建议(最小挂牌方案)单元测试(不走 HTTP), 重点验证:
//   - 最小节点割正确性(含共享开关、并联支路、环路);
//   - 不依赖带数量/长度上限的诊断路径枚举(>200 条路径、>64 节点长链仍正确);
//   - 不经过开关的来电通路 → 不可行 + 真实带电路径;
//   - 步骤按状态先分闸再挂牌; 已隔离返回空步骤;
//   - 超出单据步数上限 → orderExecutable=false 且步骤不截断。
// 运行: node test/plan.test.js

const assert = require('assert');
const { computeIsolationPlan, computeMinTagSet } = require('../src/plan');
const { MAX_STEPS } = require('../src/orders');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✔', msg);
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg} (期望 ${b}, 实际 ${a})`);
  pass++;
  console.log('  ✔', msg);
}

// 与 graph.test.js 同构的图构造, 额外支持 open_pos。spec:
//   nodes: [[id, kind, {enabled?, tagged?, open?}], ...]
//   edges: [[id, from, to], ...]
function buildGraph(nodeSpecs, edgeSpecs) {
  const nodes = nodeSpecs.map(([id, kind, extra = {}]) => ({
    id, kind, name: `N${id}`,
    enabled: extra.enabled !== undefined ? !!extra.enabled : true,
    open_pos: !!extra.open,
    tagged: !!extra.tagged
  }));
  const edges = edgeSpecs.map(([id, from, to]) => ({
    id, from, to, from_node: from, to_node: to
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from_node)) outAdj.set(e.from_node, []);
    outAdj.get(e.from_node).push(e);
  }
  return { nodes, edges, nodeById, outAdj };
}

console.log('\n[P1] 单电源-单开关-设备: 最小集合为该开关, 合闸中 → 先分闸再挂牌');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const p = computeIsolationPlan(g, 3);
  eq(p.feasible, true, '可行');
  eq(p.isolated, false, '当前未隔离');
  eq(p.minTags, 1, '最少新增挂牌 1 个');
  eq(p.switches.length, 1, '建议 1 个开关');
  eq(p.switches[0].node_id, 2, '建议开关为 N2');
  eq(p.switches[0].open_pos, false, '携带当前分合状态(合闸)');
  eq(p.steps.length, 2, '生成 2 步');
  eq(p.steps[0].action, 'open', '第 1 步分闸');
  eq(p.steps[1].action, 'tag', '第 2 步挂牌(先分闸再挂牌)');
  eq(p.orderExecutable, true, '未超步数上限, 可整单执行');
  eq(p.livePath, null, '可行时无见证路径');
}

console.log('\n[P2] 开关已分闸未挂牌: 步骤只有挂牌');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch', { open: true }], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const p = computeIsolationPlan(g, 3);
  eq(p.steps.length, 1, '仅 1 步');
  eq(p.steps[0].action, 'tag', '该步为挂牌(已分闸无需再分)');
}

console.log('\n[P3] 通路已被挂牌开关切断: 已隔离, 返回空步骤');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch', { tagged: true }], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const p = computeIsolationPlan(g, 3);
  eq(p.isolated, true, '判定已隔离');
  eq(p.minTags, 0, '无需新增挂牌');
  eq(p.switches.length, 0, '建议开关为空');
  eq(p.steps.length, 0, '返回空步骤');
  eq(p.orderExecutable, true, '空单不越限');
}

console.log('\n[P4] 双电源经共同联络开关(演示网络形态): 最小集合为联络开关 1 个');
{
  // S1→K1→K3→D, S2→K2→K3→D —— 切 K3 一处即可断电
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch'], [4, 'switch'], [5, 'switch'], [6, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 5], [4, 4, 5], [5, 5, 6]]
  );
  const p = computeIsolationPlan(g, 6);
  eq(p.minTags, 1, '最少 1 个');
  eq(p.switches[0].node_id, 5, '选中联络开关 K3');
}

console.log('\n[P5] 双电源各自独立开关(无汇合点): 最小集合为 2 个, 步骤按开关分组');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch'], [4, 'switch'], [6, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 6], [4, 4, 6]]
  );
  const p = computeIsolationPlan(g, 6);
  eq(p.minTags, 2, '最少 2 个');
  eq(p.switches.map((s) => s.node_id).join(','), '3,4', '开关升序');
  eq(p.steps.length, 4, '4 步(各分闸+挂牌)');
  eq(p.steps.map((s) => `${s.action}${s.node_id}`).join(','), 'open3,tag3,open4,tag4',
    '每个开关先分闸再挂牌');
}

console.log('\n[P6] 存在不经过开关的来电通路: 不可行 + 一条真实带电路径');
{
  // S1→K1→D 可切, 但 S2→D 直连无开关 → 永远切不断
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch'], [6, 'device']],
    [[1, 1, 3], [2, 3, 6], [3, 2, 6]]
  );
  const p = computeIsolationPlan(g, 6);
  eq(p.feasible, false, '判定不可行');
  eq(p.isolated, false, '未隔离');
  eq(p.minTags, null, '无最小挂牌数');
  eq(p.steps.length, 0, '不生成步骤');
  ok(p.livePath, '携带见证路径');
  eq(p.livePath.nodes.join(','), '2,6', '见证路径为 S2→D 直连(不经过开关)');
}

console.log('\n[P7] 部分支路已被挂牌切断: 只对剩余带电通路求最小集合');
{
  // S1→K1(已挂牌)→D 已切断; S2→K2→D 带电 → 只需再挂 K2
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch', { tagged: true }], [4, 'switch'], [6, 'device']],
    [[1, 1, 3], [2, 3, 6], [3, 2, 4], [4, 4, 6]]
  );
  const p = computeIsolationPlan(g, 6);
  eq(p.minTags, 1, '只需新增 1 个');
  eq(p.switches[0].node_id, 4, '建议 K2');
  eq(p.switches[0].tagged, false, '建议集合不含已挂牌开关');
}

console.log('\n[P8] 243 条路径(5 层×3 全连接): 最小集合为一整层 3 个, 不依赖 200 条枚举上限');
{
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  for (let layer = 0; layer < 5; layer++) {
    for (let j = 0; j < 3; j++) nodeSpecs.push([10 + layer * 10 + j, 'switch']);
  }
  const edgeSpecs = [];
  let eid = 1;
  const layerIds = (l) => (l < 0 ? [1] : [0, 1, 2].map((j) => 10 + l * 10 + j));
  for (let layer = 0; layer < 5; layer++) {
    for (const a of layerIds(layer - 1)) for (const b of layerIds(layer)) edgeSpecs.push([eid++, a, b]);
  }
  for (const a of layerIds(4)) edgeSpecs.push([eid++, a, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const p = computeIsolationPlan(g, 1000);
  eq(p.feasible, true, '可行');
  eq(p.minTags, 3, '最小割为一整层 3 个开关(243 条路径也不误判)');
  eq(p.switches.length, 3, '建议 3 个开关');
  eq(p.steps.length, 6, '6 步');
}

console.log('\n[P9] 超长链(66 节点 > 64 展示上限): 最小集合 1 个, 不受长度上限影响');
{
  const MIDDLE = 64;
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  for (let i = 0; i < MIDDLE; i++) nodeSpecs.push([100 + i, 'switch']);
  const edgeSpecs = [[1, 1, 100]];
  for (let i = 0; i < MIDDLE - 1; i++) edgeSpecs.push([i + 2, 100 + i, 100 + i + 1]);
  edgeSpecs.push([MIDDLE + 1, 100 + MIDDLE - 1, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const p = computeIsolationPlan(g, 1000);
  eq(p.minTags, 1, '链上任切一处即可, 最少 1 个');
  eq(p.switches.length, 1, '建议 1 个开关');
}

console.log('\n[P10] 步骤超单据上限: 明确不可整单执行, 步骤完整不截断');
{
  // 101 个并联开关(均合闸) → 202 步 > MAX_STEPS(200)
  const COUNT = 101;
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  const edgeSpecs = [];
  for (let i = 0; i < COUNT; i++) {
    nodeSpecs.push([100 + i, 'switch']);
    edgeSpecs.push([2 * i + 1, 1, 100 + i]);
    edgeSpecs.push([2 * i + 2, 100 + i, 1000]);
  }
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const p = computeIsolationPlan(g, 1000);
  eq(p.minTags, COUNT, '每条并联支路都需各切一处');
  eq(p.stepCount, COUNT * 2, `共 ${COUNT * 2} 步`);
  ok(p.stepCount > MAX_STEPS, `超过单据上限 ${MAX_STEPS}`);
  eq(p.orderExecutable, false, '明确不可整单执行');
  eq(p.steps.length, COUNT * 2, '步骤清单完整, 不截断');
  eq(p.maxOrderSteps, MAX_STEPS, '响应携带单据步数上限');
}

console.log('\n[P11] 无启用电源: 已隔离, 空步骤');
{
  const g = buildGraph(
    [[1, 'source', { enabled: false }], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const p = computeIsolationPlan(g, 3);
  eq(p.isolated, true, '已隔离');
  eq(p.steps.length, 0, '空步骤');
}

console.log('\n[P12] 含环图: 正常求解且结果确定');
{
  // S→A, A↔B 成环, A→T, B→T: 简单路径 S→A→T 与 S→A→B→T, 切 A 一处即可
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'switch'], [4, 'device']],
    [[1, 1, 2], [2, 2, 3], [3, 3, 2], [4, 2, 4], [5, 3, 4]]
  );
  const p = computeIsolationPlan(g, 4);
  eq(p.minTags, 1, '最小 1 个');
  eq(p.switches[0].node_id, 2, '选中环入口开关 A');
}

console.log('\n[P13] minTags 与建议集合一致; 停用电源不参与; 直连边绕过停用电源仍不可行');
{
  // 停用电源 S2 有直连边不算不可行; 启用电源 S1 经开关可切
  const g = buildGraph(
    [[1, 'source'], [2, 'source', { enabled: false }], [3, 'switch'], [6, 'device']],
    [[1, 1, 3], [2, 3, 6], [3, 2, 6]]
  );
  const p = computeIsolationPlan(g, 6);
  eq(p.feasible, true, '停用电源的直连边不影响可行性');
  eq(p.minTags, 1, '只需切启用电源通路');
  const cut = computeMinTagSet(g, 6);
  eq(cut.minTags, cut.switches.length, '最大流值 = 建议开关数(最小割容量一致)');
}

console.log(`\n结果: ${pass} 项断言全部通过`);

'use strict';

// 隔离建议(最小挂牌方案)。
//
// 在“所有启用电源 → 目标设备”的完整供电图上, 把已挂牌开关视作屏障,
// 求使设备断电所需新增挂牌开关数最少的一组开关。建模为最小节点割:
//   - 已挂牌开关是屏障, 直接从流网络中移除(等价容量 0);
//   - 未挂牌开关拆点、容量 1 —— 切断它 = 新挂一块牌;
//   - 电源 / 设备拆点、容量 ∞ —— 不能作为切断点;
//   - 供电边容量 ∞; 超级源向每个启用电源连 ∞; 汇 = 目标设备入点。
// 最大流 = 最小割 = 最少新增挂牌数; 残量网络源侧可达集给出具体开关集合。
//
// 与隔离判定同一原则: 全程基于完整图结构(最大流 / BFS 可达性),
// 不依赖带数量/长度上限的诊断路径枚举(200 条 / 64 节点只影响展示,
// 与方案求解无关); 路径再多再长, 最小集合与不可行结论都不受影响。
//
// 步骤生成遵守现有开关状态机: 合闸中的开关先分闸再挂牌; 已分闸的直接挂牌。
// 步骤数超出临时操作单 MAX_STEPS 上限时: orderExecutable=false 明确不可整单
// 执行, 步骤清单保持完整、不截断。

const { MAX_STEPS } = require('./orders');

function enabledSourceIds(graph) {
  return graph.nodes
    .filter((n) => n.kind === 'source' && n.enabled)
    .map((n) => n.id);
}

/**
 * 不经过任何开关的来电通路(完整 BFS, 不设数量/长度上限):
 * 从所有启用电源出发, 不进入任何开关节点(无论是否挂牌)。
 * 若能到达设备, 该通路永远无法通过“新增挂牌”切断 → 方案不可行,
 * 返回一条真实带电路径作为见证; 否则返回 null。
 */
function findSwitchFreePath(graph, deviceId) {
  const parent = new Map(); // nodeId -> { from, edge }
  const queue = [];
  for (const src of enabledSourceIds(graph)) {
    if (!parent.has(src)) {
      parent.set(src, { from: null, edge: null });
      queue.push(src);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    if (cur === deviceId) {
      const nodes = [cur];
      const edges = [];
      let p = parent.get(cur);
      while (p.from !== null) {
        nodes.unshift(p.from);
        edges.unshift(p.edge);
        p = parent.get(p.from);
      }
      return { nodes, edges, tagged: [] };
    }
    for (const e of graph.outAdj.get(cur) || []) {
      if (parent.has(e.to)) continue;
      const t = graph.nodeById.get(e.to);
      if (t && t.kind === 'switch') continue; // 不经过任何开关
      parent.set(e.to, { from: cur, edge: e.id });
      queue.push(e.to);
    }
  }
  return null;
}

/**
 * 最小新增挂牌集合(最小节点割, Edmonds-Karp 最大流)。
 * 前置条件: 不存在不经过开关的来电通路(否则不存在有限割, 调用方先判)。
 * @returns {{ minTags:number, switches:number[] }} 开关 id 升序, 结果确定。
 */
function computeMinTagSet(graph, deviceId) {
  const isBarrier = (n) => n.kind === 'switch' && n.tagged;
  const kept = graph.nodes.filter((n) => !isBarrier(n));
  const untaggedSwitches = kept.filter((n) => n.kind === 'switch');
  // 流值上界: 切完全部未挂牌开关必然隔离(前置条件保证每条来电通路都过开关)
  const INF = untaggedSwitches.length + 1;

  // 拆点: v -> (in, out); 超级源 SS; 汇 = 设备入点
  const idx = new Map();
  kept.forEach((n, i) => idx.set(n.id, { in: 2 * i, out: 2 * i + 1 }));
  const SS = 2 * kept.length;
  const N = SS + 1;
  const adj = Array.from({ length: N }, () => []);
  const addEdge = (u, v, cap) => {
    adj[u].push({ to: v, cap, rev: adj[v].length });
    adj[v].push({ to: u, cap: 0, rev: adj[u].length - 1 });
  };

  for (const n of kept) {
    const { in: i, out: o } = idx.get(n.id);
    addEdge(i, o, n.kind === 'switch' ? 1 : INF); // 未挂牌开关可切; 电源/设备不可切
  }
  for (const e of graph.edges) {
    const a = idx.get(e.from_node);
    const b = idx.get(e.to_node);
    if (!a || !b) continue; // 端点是已挂牌开关(屏障)的边不进入流网络
    addEdge(a.out, b.in, INF);
  }
  for (const src of enabledSourceIds(graph)) {
    addEdge(SS, idx.get(src).in, INF);
  }
  const sink = idx.get(deviceId).in;

  // Edmonds-Karp 最大流
  let flow = 0;
  for (;;) {
    const prevNode = new Array(N).fill(-1);
    const prevEdge = new Array(N).fill(-1);
    prevNode[SS] = SS;
    const queue = [SS];
    while (queue.length && prevNode[sink] === -1) {
      const u = queue.shift();
      for (let i = 0; i < adj[u].length; i++) {
        const e = adj[u][i];
        if (e.cap > 0 && prevNode[e.to] === -1) {
          prevNode[e.to] = u;
          prevEdge[e.to] = i;
          queue.push(e.to);
        }
      }
    }
    if (prevNode[sink] === -1) break;
    let bottleneck = Infinity;
    for (let v = sink; v !== SS; v = prevNode[v]) {
      bottleneck = Math.min(bottleneck, adj[prevNode[v]][prevEdge[v]].cap);
    }
    for (let v = sink; v !== SS; v = prevNode[v]) {
      const e = adj[prevNode[v]][prevEdge[v]];
      e.cap -= bottleneck;
      adj[v][e.rev].cap += bottleneck;
    }
    flow += bottleneck;
  }

  // 残量网络源侧可达集 → 最小割上的未挂牌开关(in 可达而 out 不可达)
  const reach = new Array(N).fill(false);
  reach[SS] = true;
  const queue = [SS];
  while (queue.length) {
    const u = queue.shift();
    for (const e of adj[u]) {
      if (e.cap > 0 && !reach[e.to]) {
        reach[e.to] = true;
        queue.push(e.to);
      }
    }
  }
  const switches = [];
  for (const n of untaggedSwitches) {
    const { in: i, out: o } = idx.get(n.id);
    if (reach[i] && !reach[o]) switches.push(n.id);
  }
  switches.sort((a, b) => a - b);
  return { minTags: flow, switches };
}

/**
 * 计算目标设备的最小挂牌隔离建议(纯只读, 不修改 graph)。
 * @returns {{
 *   feasible:boolean,            // false: 存在不经过开关的来电通路, 无法靠挂牌隔离
 *   isolated:boolean,            // 当前已隔离(最小集合为空)
 *   minTags:number|null,         // 最少新增挂牌数(不可行时为 null)
 *   switches:Array<{node_id:number,name:string,open_pos:boolean,tagged:boolean}>,
 *   steps:Array<{action:string,node_id:number}>,  // 与临时操作单步骤同构, 可直接预演/确认
 *   stepCount:number,
 *   maxOrderSteps:number,
 *   orderExecutable:boolean,     // false: 超出单据步数上限, 不可整单执行(steps 不截断)
 *   livePath:({nodes:number[],edges:number[]}|null) // 不可行时的真实带电见证路径
 * }}
 */
function computeIsolationPlan(graph, deviceId) {
  // 不可行判定: 不经过任何开关的来电通路(完整 BFS 见证, 与枚举上限无关)
  const switchFree = findSwitchFreePath(graph, deviceId);
  if (switchFree) {
    return {
      feasible: false, isolated: false, minTags: null,
      switches: [], steps: [], stepCount: 0,
      maxOrderSteps: MAX_STEPS, orderExecutable: false,
      livePath: switchFree
    };
  }

  const { minTags, switches } = computeMinTagSet(graph, deviceId);

  // 按当前状态生成步骤: 合闸中的开关先分闸再挂牌; 已分闸的直接挂牌
  const steps = [];
  const switchInfo = switches.map((id) => {
    const n = graph.nodeById.get(id);
    if (!n.open_pos) steps.push({ action: 'open', node_id: id });
    steps.push({ action: 'tag', node_id: id });
    return { node_id: id, name: n.name, open_pos: !!n.open_pos, tagged: !!n.tagged };
  });

  return {
    feasible: true,
    isolated: switches.length === 0, // 最小割为 0 ⟺ 完整可达性分析下设备已不可达
    minTags,
    switches: switchInfo,
    steps,
    stepCount: steps.length,
    maxOrderSteps: MAX_STEPS,
    // 超出单据步数上限: 明确不可整单执行; steps 保持完整不截断
    orderExecutable: steps.length <= MAX_STEPS,
    livePath: null
  };
}

module.exports = {
  computeIsolationPlan,
  findSwitchFreePath,
  computeMinTagSet
};

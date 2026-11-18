/**
 * sim.ts 单元测试。运行：node src/games/snake-arena/sim.test.ts（Node 22+ 类型剥离）
 */
import assert from 'node:assert'
import {
  createSim,
  addSnake,
  removeSnake,
  setDirection,
  startRound,
  stepTick,
  leaderOf,
  GRID_W,
  ROUND_TICKS,
  RESPAWN_TICKS,
  type SimState,
} from './sim.ts'

let passed = 0
function check(cond: boolean, label: string) {
  assert.ok(cond, label)
  passed++
  console.log(`PASS  ${label}`)
}

function twoPlayerSim(): SimState {
  const sim = createSim()
  addSnake(sim, 'a', 'Alice')
  addSnake(sim, 'b', 'Bob')
  startRound(sim)
  return sim
}

// ---- 基础 ----
{
  const sim = twoPlayerSim()
  check(sim.phase === 'running', 'startRound enters running')
  check(sim.snakes.length === 2, 'two snakes on roster')
  check(sim.snakes.every((s) => s.body.length === 2), 'snakes spawn with 2 segments')
  check(sim.foods.length === 3, '3 foods on field')
  check(sim.snakes[0].color !== sim.snakes[1].color, 'distinct colors')
}

// ---- 移动 ----
{
  const sim = twoPlayerSim()
  // 固定摆位，避免随机出生点在边缘导致撞墙
  sim.snakes[0].body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]
  sim.snakes[0].dir = { x: 1, y: 0 }
  sim.snakes[1].body = [{ x: 5, y: 15 }, { x: 4, y: 15 }]
  sim.snakes[1].dir = { x: 1, y: 0 }
  const ax = sim.snakes[0].body[0].x
  stepTick(sim)
  check(sim.snakes[0].body[0].x === ax + 1, 'snake moves right by 1 per tick')
  check(sim.tick === 1, 'tick advances')
}

// ---- 反向被拒、合法转向被接受 ----
{
  const sim = twoPlayerSim()
  check(!setDirection(sim, 'a', 'left'), 'reverse rejected (dir right)')
  check(setDirection(sim, 'a', 'up'), 'perpendicular turn accepted')
  stepTick(sim)
  check(sim.snakes[0].dir.y === -1 && sim.snakes[0].dir.x === 0, 'turn applied next tick')
}

// ---- 吃食物加分加长 ----
{
  const sim = twoPlayerSim()
  sim.snakes[0].body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]
  sim.snakes[0].dir = { x: 1, y: 0 }
  sim.snakes[1].body = [{ x: 5, y: 15 }, { x: 4, y: 15 }]
  sim.snakes[1].dir = { x: 1, y: 0 }
  // 把食物精确放在头前一格
  sim.foods = [{ x: 6, y: 5 }]
  const lenBefore = sim.snakes[0].body.length
  stepTick(sim)
  check(sim.snakes[0].score === 1, 'eating food scores +1')
  check(sim.snakes[0].body.length === lenBefore + 1, 'eating food grows snake')
  check(sim.foods.length === 3, 'food respawns to target count')
}

// ---- 撞墙死亡与重生 ----
{
  const sim = createSim()
  addSnake(sim, 'a', 'Alice')
  startRound(sim)
  // 把蛇挪到最右列，强制向右撞墙
  const s = sim.snakes[0]
  s.body = [{ x: GRID_W - 1, y: 5 }, { x: GRID_W - 2, y: 5 }]
  s.dir = { x: 1, y: 0 }
  s.pending = null
  stepTick(sim)
  check(!s.alive, 'wall collision kills')
  check(s.body.length === 0, 'dead snake has no body')
  for (let i = 0; i < RESPAWN_TICKS; i++) stepTick(sim)
  check(s.alive, 'snake respawns after countdown')
  check(s.body.length === 2, 'respawned with 2 segments')
  check(s.score === 0, 'score field intact after respawn (was 0 here)')
}

// ---- 分数在重生间保留、startRound 清零 ----
{
  const sim = twoPlayerSim()
  sim.snakes[0].score = 7
  const s = sim.snakes[0]
  s.body = [{ x: 0, y: 0 }, { x: 1, y: 0 }]
  s.dir = { x: -1, y: 0 }
  s.pending = null
  stepTick(sim) // 撞左墙
  for (let i = 0; i < RESPAWN_TICKS; i++) stepTick(sim)
  const respawned = sim.snakes.find((x) => x.id === 'a')!
  check(respawned.score === 7, 'score kept across respawn')
  startRound(sim)
  check(sim.snakes.find((x) => x.id === 'a')!.score === 0, 'startRound resets scores')
}

// ---- 撞别人身体死亡 ----
{
  const sim = twoPlayerSim()
  const a = sim.snakes[0]
  const b = sim.snakes[1]
  // a 在 (5,5) 朝右，下一格 (6,5) 是 b 的尾段；b 头 (7,5) 朝右，下一格 (8,5) 为空
  a.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }]
  a.dir = { x: 1, y: 0 }
  a.pending = null
  b.body = [{ x: 7, y: 5 }, { x: 6, y: 5 }]
  b.dir = { x: 1, y: 0 }
  b.pending = null
  stepTick(sim)
  check(!a.alive, 'running into another snake kills')
  check(b.alive, 'the other snake survives')
}

// ---- 终局 ----
{
  const sim = twoPlayerSim()
  sim.tick = ROUND_TICKS - 1
  stepTick(sim)
  check(sim.phase === 'ended', 'round ends at ROUND_TICKS')
  stepTick(sim)
  check(sim.tick === ROUND_TICKS, 'sim frozen after end')
}

// ---- leaderOf 与 roster 变更 ----
{
  const sim = twoPlayerSim()
  sim.snakes[1].score = 3
  check(leaderOf(sim)?.id === 'b', 'leaderOf picks top score')
  removeSnake(sim, 'a')
  check(sim.snakes.length === 1, 'removeSnake drops player')
  addSnake(sim, 'a', 'Alice') // 中途重进
  check(sim.snakes.length === 2 && sim.snakes[1].score === 0, 'rejoin spawns fresh snake')
  addSnake(sim, 'a', 'Alice')
  check(sim.snakes.length === 2, 'duplicate join is idempotent')
}

console.log(`\nSIM-ALL-PASS (${passed} checks)`)

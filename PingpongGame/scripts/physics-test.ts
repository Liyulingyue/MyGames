/**
 * 物理单元测试：验证 launchTo 生成的球真的能过网并落在对方半区的台面内。
 *
 * 运行： node --experimental-strip-types scripts/physics-test.ts
 */

import { launchTo, minNetClearSpeed, stepBall } from '../src/core/physics.ts'
import type { CollisionEvent } from '../src/core/physics.ts'
import { BALL, PADDLE, TABLE } from '../src/core/constants.ts'
import type { Ball } from '../src/core/types.ts'

interface Result {
  crossedNet: boolean
  netCrossingY: number | null
  landedZ: number | null
  landedSide: 'player' | 'opponent' | 'none'
  hitNet: boolean
  inTable: boolean
}

function simulate(
  from: { x: number; y: number; z: number },
  targetX: number,
  targetZ: number,
  speed: number,
): Result {
  const ball: Ball = {
    pos: { ...from },
    vel: launchTo(from, targetX, targetZ, speed),
    spin: 0,
  }
  const events: CollisionEvent[] = []
  const dt = 1 / 300
  let crossedNet = false
  let netCrossingY: number | null = null
  let hitNet = false
  let landedZ: number | null = null
  let landedSide: Result['landedSide'] = 'none'
  let inTable = false
  let prevZ = ball.pos.z

  for (let i = 0; i < 300 * 4; i++) {
    stepBall(ball, dt, events)
    if (!crossedNet && prevZ > 0 !== ball.pos.z > 0) {
      crossedNet = true
      netCrossingY = ball.pos.y
    }
    prevZ = ball.pos.z

    for (const e of events) {
      if (e.kind === 'net') hitNet = true
      if (e.kind === 'table' && landedZ === null) {
        landedZ = ball.pos.z
        landedSide = ball.pos.z < 0 ? 'player' : 'opponent'
        inTable = Math.abs(ball.pos.x) <= TABLE.halfWidth && Math.abs(ball.pos.z) <= TABLE.halfLength
      }
    }
    if (landedZ !== null) break
  }

  return { crossedNet, netCrossingY, landedZ, landedSide, hitNet, inTable }
}

const netTop = TABLE.netHeight + BALL.radius
let failures = 0
let checked = 0
const problems: string[] = []

function check(label: string, fromZ: number, expect: 'player' | 'opponent', cases: number[][]) {
  for (const [speed, fromY, targetX, targetZ] of cases) {
    const r = simulate({ x: 0, y: fromY, z: fromZ }, targetX, targetZ, speed)
    checked++
    const ok = r.crossedNet && !r.hitNet && r.landedSide === expect && r.inTable
    if (!ok) {
      failures++
      problems.push(
        `  ✗ ${label} speed=${speed} fromY=${fromY} target=(${targetX},${targetZ}) ` +
          `netY=${r.netCrossingY?.toFixed(3)} hitNet=${r.hitNet} ` +
          `landed=${r.landedSide}@${r.landedZ?.toFixed(2)} inTable=${r.inTable}`,
      )
    }
  }
}

console.log('=== 玩家回球（z=-1.28 打到对方半场） ===')
{
  const cases: number[][] = []
  for (const speed of [5.0, 5.5, 6.0, 6.2]) {
    for (const fromY of [0.05, 0.15, 0.3, 0.45, 0.6]) {
      for (const targetZ of [0.45, 0.75, 1.05]) {
        for (const targetX of [-0.6, -0.3, 0, 0.3, 0.6]) {
          cases.push([speed, fromY, targetX, targetZ])
        }
      }
    }
  }
  check('玩家', PADDLE.homeZ, 'opponent', cases)
}

console.log('=== 对手回球（z=+1.28 打到玩家半场） ===')
{
  const cases: number[][] = []
  for (const speed of [4.8, 5.2, 5.6, 6.2, 6.6]) {
    for (const fromY of [0.05, 0.15, 0.3, 0.45]) {
      for (const targetZ of [-1.0, -0.75, -0.5]) {
        for (const targetX of [-0.6, -0.3, 0, 0.3, 0.6]) {
          cases.push([speed, fromY, targetX, targetZ])
        }
      }
    }
  }
  check('对手', PADDLE.opponentZ, 'player', cases)
}

console.log('=== 低球速（球速倍率 0.3）依然能合法过网 ===')
{
  // 回归：把球速倍率调到很低时，解析解给出的初速远低于"能过网的物理下限"，
  // 弹道又平又矮 → 球会直接撞在网子上（玩家反馈"速度一低双方都频繁碰网"）。
  // launchTo 内部用 minNetClearSpeed 兜底，这里验证兜底之后球依旧合法。
  const cases = [0.3, 0.5, 0.8, 1, 1.2]
  for (const scale of cases) {
    for (const [fromZ, expect] of [
      [PADDLE.homeZ, 'opponent'],
      [PADDLE.opponentZ, 'player'],
    ] as const) {
      const targetZ = fromZ < 0 ? 0.75 : -0.75
      const r = simulate({ x: 0, y: 0.2, z: fromZ }, 0, targetZ, 5.5 * scale)
      checked++
      const ok = r.crossedNet && !r.hitNet && r.landedSide === expect && r.inTable
      if (!ok) {
        failures++
        problems.push(
          `  ✗ 低球速 scale=${scale} fromZ=${fromZ} ` +
            `netY=${r.netCrossingY?.toFixed(3)} hitNet=${r.hitNet} ` +
            `landed=${r.landedSide}@${r.landedZ?.toFixed(2)} inTable=${r.inTable}`,
        )
      }
    }
  }

  // 兜底速度本身必须够用：不低于 minNetClearSpeed
  const floor = minNetClearSpeed({ x: 0, y: 0.2, z: PADDLE.homeZ })
  const requested = 5.5 * 0.3
  if (floor <= requested) {
    failures++
    problems.push(`  ✗ 低球速兜底值 ${floor.toFixed(2)} 不高于请求速度 ${requested.toFixed(2)}`)
  }
}

if (problems.length) {
  console.log('\n失败用例：')
  for (const p of problems.slice(0, 40)) console.log(p)
  if (problems.length > 40) console.log(`  ... 还有 ${problems.length - 40} 条`)
}
console.log(`\n检查 ${checked} 种击球组合，失败 ${failures} 种`)
console.log(`（过网判定线 y > ${netTop.toFixed(4)}）`)
process.exit(failures > 0 ? 1 : 0)

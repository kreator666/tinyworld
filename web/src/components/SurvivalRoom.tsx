import { useEffect, useRef } from 'react'
import type { Equipped } from '../types'
import { getPixelDoll, drawPixelDoll } from '../game/pixelate'
import type { SurvivalActionKind, SurvivalPetStatus } from '../lib/survivalApi'

// ============================================================
// 生存模式房间:像素宠物住在像素风房间里,直接点画布里的物品互动
// - 五个热点:食盆(喂食)/ 扫帚水桶(打扫)/ 电脑桌(打工)/ 药箱(治疗)/ 宠物窝(装饰)
// - 行为状态机:idle 随机走动 → 点击物品 goto(步行到物品旁,lerp 2-3s)
//   → act(循环动作动画,等后端 action 接口返回)→ finale(成功撒花/失败冒 '?')→ 回 idle
// - 状态可视化:weak = 变暗 + 偶尔坐下低头;dormant = 趴窝睡 Zzz;dead = 躺地灰度 + 幽灵飘出
// - 冷却中的物品画灰色罩 + 倒计时;悬停显示名称 tooltip
// ============================================================

export type HotspotKind = 'feed' | 'clean' | 'work' | 'heal' | 'bed'

export interface SurvivalOutcome {
  kind: SurvivalActionKind
  ok: boolean
  seq: number
}

interface SurvivalRoomProps {
  equipped: Equipped
  petName: string
  hasPet: boolean
  status: SurvivalPetStatus
  cooldowns: { feed: number; clean: number; work: number }
  busy: boolean
  outcome: SurvivalOutcome | null
  labels: Record<HotspotKind, string>
  onAction: (kind: SurvivalActionKind) => void
  onDormantClick: () => void
}

// 逻辑坐标(固定 3:2,容器用 aspect-[3/2] 锁定比例后等比缩放)
const W = 960
const H = 640
const FLOOR_Y = 380

// 像素风 16 色板(呼应 ink / neon-purple / cyan 主题)
const PAL = {
  ink: '#0b0e1a', wall: '#181d34', wallHi: '#222948', floor: '#221a3a', floorHi: '#2c2350',
  line: 'rgba(148,163,184,0.10)', purple: '#a78bfa', purpleDark: '#6d5bd0', cyan: '#22d3ee',
  pink: '#f472b6', yellow: '#facc15', green: '#4ade80', red: '#f87171', white: '#e2e8f0',
  grey: '#64748b', brown: '#a16207', wood: '#7c5a3a', dark: '#10142a', night: '#0a0f24',
}

const PET_D = 120 // 宠物 sprite 绘制高度
const WALK_SPEED = 210 // 逻辑 px/s
const ACT_PARTICLE_EVERY = 0.28 // 动作粒子发射间隔
const CONFETTI_COLORS = ['#f472b6', '#facc15', '#4ade80', '#60a5fa', '#a78bfa', '#fb923c']

interface Hotspot {
  kind: HotspotKind
  rect: [number, number, number, number] // 命中/高亮框
  stand: { x: number; y: number } // 宠物站立点
}

const HOTSPOTS: Record<HotspotKind, Hotspot> = {
  feed: { kind: 'feed', rect: [116, 468, 136, 78], stand: { x: 268, y: 508 } },
  clean: { kind: 'clean', rect: [712, 404, 176, 144], stand: { x: 690, y: 506 } },
  work: { kind: 'work', rect: [548, 328, 210, 188], stand: { x: 656, y: 512 } },
  heal: { kind: 'heal', rect: [268, 232, 124, 100], stand: { x: 330, y: 450 } },
  bed: { kind: 'bed', rect: [420, 496, 156, 86], stand: { x: 500, y: 540 } },
}
// 绘制顺序(先墙饰后前景)
const HOTSPOT_ORDER: HotspotKind[] = ['heal', 'work', 'feed', 'clean', 'bed']

const WALK_X: [number, number] = [140, 820]
const WALK_Y: [number, number] = [445, 552]

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  ttl: number
  color: string
  size: number
  text?: string
}

interface Bubble {
  text: string
  born: number
  ttl: number
}

type PetMode = 'idle' | 'goto' | 'act' | 'finale'

interface PetState {
  x: number
  y: number
  tx: number
  ty: number
  face: 1 | -1
  phase: number
  mode: PetMode
  idleT: number
  hop: number
  targetKind: HotspotKind | null
  actKind: SurvivalActionKind | null
  actT: number
  actParticleT: number
  finaleT: number
  finaleOk: boolean
  sitT: number
  zzzT: number
  ghostT: number
  outcome: SurvivalOutcome | null
  lastSeq: number
  bubble: Bubble | null
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

export default function SurvivalRoom({
  equipped,
  petName,
  hasPet,
  status,
  cooldowns,
  busy,
  outcome,
  labels,
  onAction,
  onDormantClick,
}: SurvivalRoomProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const clockRef = useRef(0)
  const particlesRef = useRef<Particle[]>([])
  const spriteRef = useRef<{ key: string; canvas: HTMLCanvasElement | null }>({ key: '', canvas: null })
  const spriteKeyRef = useRef('')
  const petRef = useRef<PetState>({
    x: 480, y: 500, tx: 480, ty: 500, face: 1, phase: 0, mode: 'idle', idleT: 1,
    hop: 0, targetKind: null, actKind: null, actT: 0, actParticleT: 0, finaleT: 0,
    finaleOk: true, sitT: 0, zzzT: 0, ghostT: 0, outcome: null, lastSeq: 0, bubble: null,
  })
  const hoverRef = useRef<{ kind: HotspotKind; x: number; y: number } | null>(null)
  const statusRef = useRef<SurvivalPetStatus>(status)
  const hasPetRef = useRef(hasPet)
  const cooldownsRef = useRef(cooldowns)
  const busyRef = useRef(busy)
  const labelsRef = useRef(labels)
  const petNameRef = useRef(petName)
  const onActionRef = useRef(onAction)
  const onDormantRef = useRef(onDormantClick)

  // props ref 化:RAF 主循环里读最新值,避免闭包过期
  useEffect(() => { statusRef.current = status }, [status])
  useEffect(() => { hasPetRef.current = hasPet }, [hasPet])
  useEffect(() => { cooldownsRef.current = cooldowns }, [cooldowns])
  useEffect(() => { busyRef.current = busy }, [busy])
  useEffect(() => { labelsRef.current = labels }, [labels])
  useEffect(() => { petNameRef.current = petName }, [petName])
  useEffect(() => { onActionRef.current = onAction }, [onAction])
  useEffect(() => { onDormantRef.current = onDormantClick }, [onDormantClick])

  // 像素宠物:装备变化才重新像素化(head/body 决定像素小人,accessory/pet 不参与)
  useEffect(() => {
    const key = `${equipped.head}|${equipped.body}`
    spriteKeyRef.current = key
    spriteRef.current = { key, canvas: null }
    getPixelDoll(equipped).then((canvas) => {
      if (spriteKeyRef.current === key) spriteRef.current.canvas = canvas
    })
  }, [equipped])

  // 后端 action 结果到达:存进状态机,act 阶段结束后收尾(成功撒花/失败冒 '?')
  useEffect(() => {
    if (!outcome || outcome.seq === petRef.current.lastSeq) return
    petRef.current.lastSeq = outcome.seq
    petRef.current.outcome = outcome
  }, [outcome])

  // 状态切换:dormant/dead → 宠物回到窝里(趴窝/躺地由绘制层处理);
  // 复活(alive/weak)后恢复随机走动,避免 idleT=999 永远站桩
  const prevStatusRef = useRef<SurvivalPetStatus>(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    const pet = petRef.current
    if (status === 'dormant' || status === 'dead') {
      const bed = HOTSPOTS.bed.stand
      pet.x = bed.x
      pet.y = bed.y
      pet.tx = bed.x
      pet.ty = bed.y
      pet.mode = 'idle'
      pet.targetKind = null
      pet.actKind = null
      pet.idleT = 999
    } else if ((prev === 'dormant' || prev === 'dead') && pet.mode === 'idle') {
      pet.idleT = 0.6
    }
  }, [status])

  // 尺寸跟踪:容器 CSS 尺寸 + 设备像素比,画布按逻辑坐标等比映射
  useEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (!box || !canvas) return
    const apply = () => {
      const rect = box.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      sizeRef.current = { w: rect.width, h: rect.height }
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  const toLogical = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / Math.max(rect.width, 1)) * W,
      y: ((e.clientY - rect.top) / Math.max(rect.height, 1)) * H,
    }
  }

  const hotspotAt = (x: number, y: number): Hotspot | null => {
    for (const kind of HOTSPOT_ORDER) {
      const [hx, hy, hw, hh] = HOTSPOTS[kind].rect
      if (x >= hx && x <= hx + hw && y >= hy && y <= hy + hh) return HOTSPOTS[kind]
    }
    return null
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toLogical(e)
    const hs = hotspotAt(p.x, p.y)
    hoverRef.current = hs ? { kind: hs.kind, x: p.x, y: p.y } : null
    const clickable = !!hs && hasPetRef.current && statusRef.current !== 'dead' &&
      statusRef.current !== 'dormant' && !busyRef.current && petRef.current.mode === 'idle'
    e.currentTarget.style.cursor = clickable ? 'pointer' : 'default'
  }

  const onPointerLeave = () => {
    hoverRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }

  // 点击热点:非床类物品触发动作(先走再演);床是纯装饰,点一下弹跳
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toLogical(e)
    const hs = hotspotAt(p.x, p.y)
    if (!hs) return
    const pet = petRef.current
    if (hs.kind === 'bed') {
      if (hasPetRef.current) pet.hop = 0.5
      return
    }
    if (!hasPetRef.current || statusRef.current === 'dead') return
    if (statusRef.current === 'dormant') {
      onDormantRef.current()
      return
    }
    if (busyRef.current || pet.mode !== 'idle') return // 动作期间锁交互
    if (hs.kind !== 'heal') {
      const remain = cooldownsRef.current[hs.kind] - Date.now() / 1000
      if (remain > 0) return // 冷却中(画布上有灰色罩),不触发
    }
    pet.mode = 'goto'
    pet.targetKind = hs.kind
    pet.tx = hs.stand.x
    pet.ty = hs.stand.y
    onActionRef.current(hs.kind)
  }

  // ============================================================
  // RAF 主循环
  // ============================================================
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let raf = 0
    let last = performance.now()

    const spawnConfetti = (x: number, y: number) => {
      for (let i = 0; i < 28; i++) {
        particlesRef.current.push({
          x: x + rand(-14, 14), y: y + rand(-8, 8),
          vx: rand(-80, 80), vy: rand(-190, -60),
          life: rand(0.7, 1.3), ttl: 1.3,
          color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
          size: rand(2.5, 4.5),
        })
      }
    }

    // 各动作的阶段粒子:喂食=食物碎屑 打扫=灰尘变星星 打工=键盘敲击 治疗=十字光环
    const spawnActParticles = (pet: PetState) => {
      const hs = pet.actKind ? HOTSPOTS[pet.actKind] : null
      if (!hs) return
      const [hx, hy, hw, hh] = hs.rect
      const cx = hx + hw / 2
      const cy = hy + hh / 2
      const push = (p: Partial<Particle>) =>
        particlesRef.current.push({ life: 0.8, ttl: 0.8, color: PAL.white, size: 3, vx: 0, vy: 0, x: cx, y: cy, ...p })
      if (pet.actKind === 'feed') {
        push({ x: cx + rand(-16, 16), y: cy - 6, vx: rand(-20, 20), vy: rand(-90, -40), color: PAL.brown, size: rand(2, 4), life: 0.7, ttl: 0.7 })
      } else if (pet.actKind === 'clean') {
        // 灰尘上扬,过半场后变成星星
        const star = pet.actT > 1.1
        push({
          x: cx + rand(-30, 30), y: cy + rand(-6, 10),
          vx: rand(-26, 26), vy: rand(-50, -16),
          color: star ? PAL.yellow : PAL.grey, size: star ? rand(3, 5) : rand(2, 4),
          life: 0.9, ttl: 0.9,
        })
      } else if (pet.actKind === 'work') {
        push({ x: cx + rand(-6, 40), y: cy - 60 + rand(-8, 8), vx: rand(-8, 8), vy: rand(-40, -14), color: PAL.cyan, size: rand(2, 3.5), life: 0.5, ttl: 0.5 })
      } else if (pet.actKind === 'heal') {
        push({ x: pet.x + rand(-20, 20), y: pet.y - PET_D * 0.7, vx: 0, vy: rand(-46, -20), color: PAL.green, size: rand(3, 5), text: '+', life: 1, ttl: 1 })
      }
    }

    const update = (dt: number) => {
      clockRef.current += dt
      const t = clockRef.current
      const pet = petRef.current
      const st = statusRef.current
      const hasPet = hasPetRef.current

      // 粒子:重力 + 寿命(text 粒子是 Zzz/幽灵,向上飘不施加重力)
      const ps = particlesRef.current
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]
        p.life -= dt
        if (p.life <= 0) {
          ps.splice(i, 1)
          continue
        }
        if (!p.text) p.vy += 300 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
      }

      if (pet.hop > 0) pet.hop = Math.max(0, pet.hop - dt)
      if (pet.bubble && t - pet.bubble.born > pet.bubble.ttl) pet.bubble = null
      if (!hasPet) return

      if (st === 'dormant') {
        pet.zzzT -= dt
        if (pet.zzzT <= 0) {
          pet.zzzT = 1.4
          particlesRef.current.push({
            x: HOTSPOTS.bed.stand.x + 30, y: HOTSPOTS.bed.stand.y - 40,
            vx: 14, vy: -34, life: 2.2, ttl: 2.2, color: PAL.white, size: 18, text: 'Z',
          })
        }
        return
      }
      if (st === 'dead') {
        pet.ghostT -= dt
        if (pet.ghostT <= 0) {
          pet.ghostT = 2.6
          particlesRef.current.push({
            x: pet.x, y: pet.y - PET_D * 0.4,
            vx: 6, vy: -30, life: 2.4, ttl: 2.4, color: 'rgba(226,232,240,0.8)', size: 26, text: '👻',
          })
        }
        return
      }

      switch (pet.mode) {
        case 'idle': {
          pet.sitT += dt
          pet.idleT -= dt
          if (pet.idleT <= 0) {
            pet.tx = rand(WALK_X[0], WALK_X[1])
            pet.ty = rand(WALK_Y[0], WALK_Y[1])
            pet.targetKind = null
            pet.mode = 'goto'
          }
          break
        }
        case 'goto': {
          const dx = pet.tx - pet.x
          const dy = pet.ty - pet.y
          const dist = Math.hypot(dx, dy)
          const step = WALK_SPEED * dt
          if (dist <= step || dist < 1) {
            pet.x = pet.tx
            pet.y = pet.ty
            if (pet.targetKind && pet.targetKind !== 'bed') {
              pet.mode = 'act'
              pet.actKind = pet.targetKind
              pet.actT = 0
              pet.actParticleT = 0
            } else {
              pet.mode = 'idle'
              pet.idleT = rand(1.2, 3.8)
              pet.targetKind = null
            }
          } else {
            pet.x += (dx / dist) * step
            pet.y += (dy / dist) * step
            if (Math.abs(dx) > 1) pet.face = dx > 0 ? 1 : -1
            pet.phase += dt * 10
          }
          break
        }
        case 'act': {
          pet.actT += dt
          pet.actParticleT -= dt
          if (pet.actParticleT <= 0) {
            pet.actParticleT = ACT_PARTICLE_EVERY
            spawnActParticles(pet)
          }
          // 后端返回(成功/失败)后收尾;未返回则保持动作循环(接口同步执行 10-30s)
          if (pet.outcome && pet.outcome.kind === pet.actKind) {
            pet.finaleOk = pet.outcome.ok
            pet.outcome = null
            pet.mode = 'finale'
            pet.finaleT = 0
            if (pet.finaleOk) {
              spawnConfetti(pet.x, pet.y - PET_D * 0.8)
            } else {
              pet.bubble = { text: '?', born: t, ttl: 1.6 }
            }
          }
          break
        }
        case 'finale': {
          pet.finaleT += dt
          if (pet.finaleT > 1.1) {
            pet.mode = 'idle'
            pet.idleT = rand(1, 3)
            pet.actKind = null
            pet.targetKind = null
          }
          break
        }
      }
    }

    // ---------------- 绘制 ----------------
    const drawWall = (c: CanvasRenderingContext2D, t: number) => {
      const grad = c.createLinearGradient(0, 0, 0, FLOOR_Y)
      grad.addColorStop(0, PAL.wallHi)
      grad.addColorStop(1, PAL.wall)
      c.fillStyle = grad
      c.fillRect(0, 0, W, FLOOR_Y)
      // 顶光
      const glow = c.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.6)
      glow.addColorStop(0, 'rgba(139,92,246,0.16)')
      glow.addColorStop(1, 'rgba(139,92,246,0)')
      c.fillStyle = glow
      c.fillRect(0, 0, W, FLOOR_Y)

      // 窗户:夜空 + 月亮 + 星星
      c.fillStyle = PAL.night
      c.strokeStyle = 'rgba(167,139,250,0.5)'
      c.lineWidth = 3
      c.beginPath()
      c.roundRect(60, 96, 150, 140, 6)
      c.fill()
      c.stroke()
      c.save()
      c.beginPath()
      c.roundRect(63, 99, 144, 134, 4)
      c.clip()
      c.fillStyle = '#facc15'
      c.beginPath()
      c.arc(170, 140, 18, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = 'rgba(250,204,21,0.25)'
      c.beginPath()
      c.arc(170, 140, 28, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = PAL.white
      for (let i = 0; i < 12; i++) {
        const sx = 70 + ((i * 53) % 130)
        const sy = 106 + ((i * 37) % 120)
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.4 + i))
        c.globalAlpha = tw
        c.fillRect(sx, sy, 2, 2)
      }
      c.globalAlpha = 1
      c.restore()
      // 窗框十字
      c.strokeStyle = 'rgba(167,139,250,0.5)'
      c.lineWidth = 3
      c.beginPath()
      c.moveTo(135, 96)
      c.lineTo(135, 236)
      c.moveTo(60, 166)
      c.lineTo(210, 166)
      c.stroke()

      // 海报:霓虹边框 + 像素斜纹
      c.fillStyle = PAL.dark
      c.strokeStyle = 'rgba(34,211,238,0.45)'
      c.lineWidth = 2
      c.beginPath()
      c.roundRect(700, 100, 128, 96, 4)
      c.fill()
      c.stroke()
      c.fillStyle = 'rgba(167,139,250,0.65)'
      for (let i = 0; i < 5; i++) c.fillRect(714, 116 + i * 15, 72 + ((i * 31) % 40), 6)
      c.fillStyle = PAL.cyan
      c.font = 'bold 16px monospace'
      c.textAlign = 'left'
      c.textBaseline = 'alphabetic'
      c.fillText('AGENT', 714, 112)

      // 踢脚线
      c.fillStyle = 'rgba(148,163,184,0.14)'
      c.fillRect(0, FLOOR_Y - 6, W, 6)
    }

    const drawFloor = (c: CanvasRenderingContext2D) => {
      const grad = c.createLinearGradient(0, FLOOR_Y, 0, H)
      grad.addColorStop(0, PAL.floorHi)
      grad.addColorStop(1, PAL.floor)
      c.fillStyle = grad
      c.fillRect(0, FLOOR_Y, W, H - FLOOR_Y)
      // 木地板缝
      c.strokeStyle = PAL.line
      c.lineWidth = 1
      c.beginPath()
      for (let y = FLOOR_Y + 24; y < H; y += 26) {
        c.moveTo(0, y)
        c.lineTo(W, y)
      }
      for (let row = 0; row < 8; row++) {
        const y0 = FLOOR_Y + row * 26
        for (let x = (row % 2) * 46; x < W; x += 92) {
          c.moveTo(x, y0)
          c.lineTo(x, Math.min(y0 + 26, H))
        }
      }
      c.stroke()
      // 地毯
      c.fillStyle = 'rgba(109,91,208,0.30)'
      c.beginPath()
      c.ellipse(480, 528, 190, 52, 0, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = 'rgba(167,139,250,0.35)'
      c.lineWidth = 2
      c.beginPath()
      c.ellipse(480, 528, 168, 44, 0, 0, Math.PI * 2)
      c.stroke()
    }

    const drawItem = (c: CanvasRenderingContext2D, kind: HotspotKind, t: number) => {
      const hover = hoverRef.current?.kind === kind
      const hs = HOTSPOTS[kind]
      const [hx, hy, hw, hh] = hs.rect
      const pet = petRef.current
      const st = statusRef.current
      const acting = pet.mode === 'act' && pet.actKind === kind
      if (hover) {
        c.fillStyle = 'rgba(34,211,238,0.08)'
        c.strokeStyle = 'rgba(34,211,238,0.55)'
        c.lineWidth = 2
        c.beginPath()
        c.roundRect(hx, hy, hw, hh, 8)
        c.fill()
        c.stroke()
      }

      if (kind === 'feed') {
        // 食盆:碗沿 + 碗身 + 宠物粮
        const bx = hx + hw / 2
        const by = hy + hh - 18
        c.fillStyle = PAL.purpleDark
        c.beginPath()
        c.ellipse(bx, by, 44, 14, 0, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = PAL.purple
        c.beginPath()
        c.ellipse(bx, by - 6, 40, 12, 0, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = PAL.ink
        c.beginPath()
        c.ellipse(bx, by - 6, 30, 8, 0, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = PAL.brown
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2
          c.fillRect(bx + Math.cos(a) * 16 - 2.5, by - 10 + Math.sin(a) * 4, 5, 5)
        }
      } else if (kind === 'clean') {
        // 水桶
        const kx = hx + 34
        const ky = hy + hh - 44
        c.fillStyle = '#3b6ea5'
        c.beginPath()
        c.roundRect(kx, ky, 44, 40, 4)
        c.fill()
        c.fillStyle = PAL.cyan
        c.beginPath()
        c.ellipse(kx + 22, ky + 4, 20, 6, 0, 0, Math.PI * 2)
        c.fill()
        c.strokeStyle = PAL.grey
        c.lineWidth = 3
        c.beginPath()
        c.arc(kx + 22, ky + 2, 22, Math.PI, 0)
        c.stroke()
        // 扫帚:靠墙斜立,打扫时来回摆动
        const sway = acting ? Math.sin(pet.actT * 7) * 0.22 : 0
        const broomX = hx + hw - 36
        c.save()
        c.translate(broomX, hy + hh - 8)
        c.rotate(-0.28 + sway)
        c.fillStyle = PAL.wood
        c.fillRect(-3, -118, 6, 96)
        c.fillStyle = '#d9a441'
        c.beginPath()
        c.moveTo(-13, -26)
        c.lineTo(13, -26)
        c.lineTo(9, 0)
        c.lineTo(-9, 0)
        c.closePath()
        c.fill()
        c.fillStyle = '#b97f2a'
        c.fillRect(-11, -10, 22, 5)
        c.restore()
      } else if (kind === 'work') {
        // 电脑桌:桌面 + 显示器 + 键盘 + 主机
        const dx0 = hx + 12
        const dy0 = hy + 84
        const dw = hw - 24
        c.fillStyle = PAL.wood
        c.fillRect(dx0, dy0, dw, 12) // 桌面
        c.fillStyle = '#5d4327'
        c.fillRect(dx0 + 6, dy0 + 12, 10, hh - 96) // 桌腿
        c.fillRect(dx0 + dw - 16, dy0 + 12, 10, hh - 96)
        // 显示器(挂桌面后方)
        const mx = dx0 + dw / 2 - 50
        const my = hy + 12
        c.fillStyle = PAL.ink
        c.beginPath()
        c.roundRect(mx, my, 100, 62, 4)
        c.fill()
        // 屏幕:打工时闪烁,平时幽暗待机
        const flicker = acting && Math.sin(t * 14) > -0.3
        c.fillStyle = flicker ? 'rgba(34,211,238,0.85)' : 'rgba(34,211,238,0.18)'
        c.beginPath()
        c.roundRect(mx + 6, my + 6, 88, 50, 2)
        c.fill()
        if (flicker) {
          c.fillStyle = PAL.ink
          c.font = '10px monospace'
          c.textAlign = 'left'
          for (let i = 0; i < 4; i++) c.fillText('>' + '▮'.repeat(1 + ((i * 7 + Math.floor(t * 6)) % 8)), mx + 12, my + 20 + i * 11)
        }
        c.fillStyle = PAL.grey
        c.fillRect(mx + 44, my + 62, 12, 12) // 支架
        c.fillRect(mx + 28, my + 72, 44, 5)
        // 键盘 + 主机
        c.fillStyle = '#334155'
        c.beginPath()
        c.roundRect(dx0 + dw / 2 - 34, dy0 - 8, 68, 9, 2)
        c.fill()
        c.fillStyle = PAL.dark
        c.beginPath()
        c.roundRect(dx0 + dw - 26, dy0 - 44, 22, 44, 2)
        c.fill()
        c.fillStyle = acting ? PAL.green : 'rgba(74,222,128,0.35)'
        c.fillRect(dx0 + dw - 21, dy0 - 38, 4, 4)
      } else if (kind === 'heal') {
        // 药箱:搁板 + 白箱红十字;虚弱时呼吸发光
        const shelfY = hy + hh - 22
        c.fillStyle = PAL.wood
        c.fillRect(hx - 6, shelfY, hw + 12, 8)
        const bx = hx + hw / 2 - 30
        const by = shelfY - 46
        if (st === 'weak') {
          const pulse = 0.35 + 0.3 * Math.abs(Math.sin(t * 3))
          c.fillStyle = `rgba(74,222,128,${pulse})`
          c.beginPath()
          c.arc(hx + hw / 2, by + 24, 52, 0, Math.PI * 2)
          c.fill()
        }
        c.fillStyle = PAL.white
        c.beginPath()
        c.roundRect(bx, by, 60, 42, 5)
        c.fill()
        c.fillStyle = PAL.red
        c.fillRect(bx + 24, by + 9, 12, 24)
        c.fillRect(bx + 15, by + 15, 30, 12)
        c.fillStyle = PAL.grey
        c.fillRect(bx + 20, by - 5, 20, 7)
      } else if (kind === 'bed') {
        // 宠物窝:外圈 + 垫子 + 枕头
        const bx = hx + 8
        const by = hy + 18
        const bw = hw - 16
        const bh = hh - 26
        c.fillStyle = PAL.purpleDark
        c.beginPath()
        c.ellipse(bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = PAL.pink
        c.beginPath()
        c.ellipse(bx + bw / 2, by + bh / 2, bw / 2 - 10, bh / 2 - 8, 0, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = '#fbcfe8'
        c.beginPath()
        c.ellipse(bx + 26, by + bh / 2 - 4, 18, 12, -0.3, 0, Math.PI * 2)
        c.fill()
      }
    }

    const drawCooldowns = (c: CanvasRenderingContext2D) => {
      const now = Date.now() / 1000
      const cds = cooldownsRef.current
      for (const kind of ['feed', 'clean', 'work'] as const) {
        const remain = cds[kind] - now
        if (remain <= 0) continue
        const hs = HOTSPOTS[kind]
        const [hx, hy, hw, hh] = hs.rect
        c.fillStyle = 'rgba(10,12,26,0.62)'
        c.beginPath()
        c.roundRect(hx, hy, hw, hh, 8)
        c.fill()
        c.fillStyle = PAL.grey
        c.font = 'bold 18px monospace'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(`${Math.ceil(remain)}s`, hx + hw / 2, hy + hh / 2)
      }
    }

    const drawTooltip = (c: CanvasRenderingContext2D) => {
      const hover = hoverRef.current
      if (!hover) return
      const label = labelsRef.current[hover.kind]
      c.font = '12px sans-serif'
      const tw = c.measureText(label).width + 16
      const tx = Math.min(Math.max(hover.x + 14, tw / 2 + 4), W - tw / 2 - 4)
      const ty = Math.max(6, hover.y - 30)
      c.fillStyle = 'rgba(15,17,35,0.92)'
      c.strokeStyle = 'rgba(34,211,238,0.55)'
      c.lineWidth = 1
      c.beginPath()
      c.roundRect(tx - tw / 2, ty, tw, 22, 6)
      c.fill()
      c.stroke()
      c.fillStyle = PAL.white
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(label, tx, ty + 12)
    }

    const drawPet = (c: CanvasRenderingContext2D, t: number) => {
      const pet = petRef.current
      const st = statusRef.current
      const sprite = spriteRef.current.canvas
      // 影子
      c.fillStyle = 'rgba(0,0,0,0.35)'
      c.beginPath()
      c.ellipse(pet.x, pet.y + 3, PET_D * 0.32, Math.max(PET_D * 0.05, 4), 0, 0, Math.PI * 2)
      c.fill()

      let offY = 0
      if (pet.hop > 0) offY = -Math.sin((1 - pet.hop / 0.5) * Math.PI) * PET_D * 0.14
      else if (pet.mode === 'goto') offY = -Math.abs(Math.sin(pet.phase)) * PET_D * 0.03
      else if (pet.mode === 'act' && pet.actKind === 'feed') offY = Math.abs(Math.sin(pet.actT * 5)) * PET_D * 0.1 // 低头啄食(下移用正值)
      else if (pet.mode !== 'act') offY += Math.sin(t * 2 + pet.phase) * PET_D * 0.012 // 待机呼吸

      const sitting = st === 'weak' && pet.mode === 'idle' && pet.sitT % 9 > 6
      const working = pet.mode === 'act' && pet.actKind === 'work'
      const lying = st === 'dead' || st === 'dormant'

      // 状态滤镜:weak 变暗 / dead 灰度
      c.filter = st === 'dead' ? 'grayscale(1) brightness(0.7)'
        : st === 'weak' ? 'brightness(0.6) saturate(0.65)'
        : st === 'dormant' ? 'brightness(0.75)' : 'none'

      if (sprite) {
        if (lying) {
          // 趴窝/躺地:横置缩小
          c.save()
          c.translate(pet.x, pet.y - PET_D * 0.18 + offY)
          c.rotate(-Math.PI / 2)
          drawPixelDoll(c, sprite, -PET_D * 0.42, -PET_D * 0.42, PET_D * 0.84, PET_D * 0.84, pet.face < 0)
          c.restore()
        } else if (sitting) {
          // 坐下低头:纵向压扁
          c.save()
          c.translate(pet.x, pet.y + offY)
          c.scale(1, 0.8)
          drawPixelDoll(c, sprite, -PET_D / 2, -PET_D, PET_D, PET_D, pet.face < 0)
          c.restore()
          c.fillStyle = 'rgba(148,163,184,0.8)'
          c.font = '12px sans-serif'
          c.textAlign = 'center'
          c.fillText('…', pet.x, pet.y - PET_D * 0.86)
        } else if (working) {
          // 坐着打字:压扁 + 小幅抖动
          c.save()
          c.translate(pet.x + Math.sin(pet.actT * 18) * 1.2, pet.y + offY)
          c.scale(1, 0.85)
          drawPixelDoll(c, sprite, -PET_D / 2, -PET_D, PET_D, PET_D, pet.face < 0)
          c.restore()
        } else if (pet.mode === 'act' && pet.actKind === 'clean') {
          // 扫地:身体小角度摇摆
          c.save()
          c.translate(pet.x, pet.y + offY)
          c.rotate(Math.sin(pet.actT * 7) * 0.12)
          drawPixelDoll(c, sprite, -PET_D / 2, -PET_D, PET_D, PET_D, pet.face < 0)
          c.restore()
        } else {
          drawPixelDoll(c, sprite, pet.x - PET_D / 2, pet.y + offY - PET_D, PET_D, PET_D, pet.face < 0)
        }
      } else {
        c.filter = 'none'
        c.fillStyle = 'rgba(148,163,184,0.5)'
        c.fillRect(pet.x - 8, pet.y - 24, 16, 16)
      }
      c.filter = 'none'

      // 头顶名牌
      const name = petNameRef.current
      if (name && st !== 'dead') {
        c.font = '11px sans-serif'
        const nw = c.measureText(name).width + 12
        const ny = Math.max(4, pet.y + offY - PET_D - (lying ? 0 : 18))
        c.fillStyle = 'rgba(8,51,68,0.85)'
        c.strokeStyle = 'rgba(34,211,238,0.6)'
        c.lineWidth = 1
        c.beginPath()
        c.roundRect(Math.min(Math.max(pet.x, nw / 2 + 4), W - nw / 2 - 4) - nw / 2, ny, nw, 15, 7)
        c.fill()
        c.stroke()
        c.fillStyle = '#a5f3fc'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(name, Math.min(Math.max(pet.x, nw / 2 + 4), W - nw / 2 - 4), ny + 8.5)
      }

      // '?' 气泡(动作失败)
      if (pet.bubble) {
        const age = t - pet.bubble.born
        const alpha = Math.min(1, age / 0.15, Math.max(0, (pet.bubble.ttl - age) / 0.3))
        if (alpha > 0) {
          c.globalAlpha = alpha
          const by = pet.y + offY - PET_D - 30
          c.fillStyle = 'rgba(15,17,35,0.92)'
          c.strokeStyle = 'rgba(248,113,113,0.6)'
          c.lineWidth = 1
          c.beginPath()
          c.arc(pet.x, by, 12, 0, Math.PI * 2)
          c.fill()
          c.stroke()
          c.fillStyle = PAL.red
          c.font = 'bold 15px sans-serif'
          c.textAlign = 'center'
          c.textBaseline = 'middle'
          c.fillText(pet.bubble.text, pet.x, by + 1)
          c.globalAlpha = 1
        }
      }
    }

    const draw = () => {
      const { w, h } = sizeRef.current
      if (!w || !h) return
      ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const t = clockRef.current
      drawWall(ctx, t)
      drawFloor(ctx)
      // 物品与宠物按深度(y)穿插:比宠物"更远"(更靠上)的先画,宠物盖住它;
      // 比宠物"更近"(更靠下)的后画,盖住宠物下半身,形成伪纵深
      const pet = petRef.current
      const petDepth = hasPetRef.current ? pet.y : Infinity
      for (const kind of HOTSPOT_ORDER) {
        if (HOTSPOTS[kind].rect[1] + HOTSPOTS[kind].rect[3] < petDepth) drawItem(ctx, kind, t)
      }
      if (hasPetRef.current) drawPet(ctx, t)
      for (const kind of HOTSPOT_ORDER) {
        if (HOTSPOTS[kind].rect[1] + HOTSPOTS[kind].rect[3] >= petDepth) drawItem(ctx, kind, t)
      }
      // 粒子
      for (const p of particlesRef.current) {
        ctx.globalAlpha = Math.min(1, p.life / 0.3)
        if (p.text) {
          ctx.globalAlpha = Math.min(1, p.life / (p.ttl * 0.4))
          ctx.fillStyle = p.color
          ctx.font = `bold ${p.size}px sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(p.text, p.x, p.y)
        } else {
          ctx.fillStyle = p.color
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
        }
      }
      ctx.globalAlpha = 1
      drawCooldowns(ctx)
      drawTooltip(ctx)
    }

    let visible = true
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true
    })
    io.observe(canvas)

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      if (visible) {
        update(dt)
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={boxRef} className="relative w-full aspect-[3/2] overflow-hidden rounded-xl border border-white/10 bg-ink">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      />
    </div>
  )
}

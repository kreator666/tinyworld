import { useEffect, useRef } from 'react'
import type { Equipped } from '../types'
import { getPixelDoll, drawPixelDoll, PIXEL_SIZE } from '../game/pixelate'

// 像素小屋:电子宠物式的像素小人随机走动,点击弹跳 + 冒人设气泡
// A 形态只放自己一个居民;接口按居民列表设计,后续多人广场直接把多个 inhabitant
// 放进同一个画布即可,渲染/动画/命中检测均按多小人处理
// 可选 status 反映 Agent 状态(助手页用):thinking 焦虑踱步、waiting-sign 停下面向用户冒 !、
// signing 紧张小碎步、confirming 原地踮脚张望、happy 连跳两下 + 撒花;不传则为 idle 现状

export interface RoomInhabitant {
  id: string // 唯一 id(多人形态用 owner 地址)
  equipped: Equipped
  lines?: string[] // 人设气泡台词;缺省用默认台词池
}

export type AgentStatus = 'idle' | 'thinking' | 'waiting-sign' | 'signing' | 'confirming' | 'happy'

interface PixelRoomProps {
  inhabitants: RoomInhabitant[]
  ownerAddress?: string // 位置持久化 key
  className?: string
  status?: AgentStatus // 整个房间的状态(反映 Agent);缺省 idle
  dollHeight?: number // 小人显示高度 px(默认 128 = 64x2 整数倍,像素最锐利)
  heightClass?: string // 容器高度 Tailwind 类,默认 h-80 md:h-96
}

const WALK_SPEED = 55 // css px/s,idle 基准
const HOP_TIME = 0.5 // 点击弹跳时长
const BUBBLE_TIME = 3.6 // 人设气泡存活时长
const HAPPY_TIME = 3 // happy 状态持续时长(之后回落 idle)

const DEFAULT_LINES = [
  '你好呀,这是我的小屋~',
  '随便逛逛,别客气!',
  '今天也是元气满满的一天',
  '要不要和我聊聊?',
  '这里是我的秘密基地 ✨',
  '咕噜咕噜……随便走走真开心',
]

// 撒花粒子的配色(霓虹糖果色)
const CONFETTI_COLORS = ['#f472b6', '#facc15', '#4ade80', '#60a5fa', '#a78bfa', '#fb923c']

// 停顿类状态:小人不走动(走到目标后原地待命)
const HALT_STATUSES: AgentStatus[] = ['waiting-sign', 'confirming']

interface Walker {
  id: string
  equippedKey: string
  lines: string[]
  x: number // 比例坐标 0~1(持久化用)
  y: number
  tx: number
  ty: number
  state: 'idle' | 'walk'
  idleT: number // 待机剩余时间
  face: 1 | -1
  phase: number // 走路起伏相位
  sprite: HTMLCanvasElement | null
  hop: number // 弹跳剩余时间
  bubble: { text: string; born: number; ttl: number } | null // born = 动画时钟(秒)
  thinkT: number // thinking:'…' 气泡计时
  markT: number // waiting-sign:'!' 气泡闪烁计时
  hopAt: number[] // happy:计划中的弹跳时刻
}

interface Confetti {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: string
}

// walker 的装备失效 key:head/body 编号变化才需要重新像素化(accessory/pet 不参与像素小人)
function keyOf(equipped: Equipped): string {
  return `${equipped.head}|${equipped.body}`
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

export default function PixelRoom({
  inhabitants,
  ownerAddress,
  className = '',
  status = 'idle',
  dollHeight = PIXEL_SIZE * 2,
  heightClass = 'h-80 md:h-96',
}: PixelRoomProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const walkersRef = useRef<Map<string, Walker>>(new Map())
  const confettiRef = useRef<Confetti[]>([])
  const sizeRef = useRef({ w: 0, h: 0 })
  const clockRef = useRef(0)
  const dollRef = useRef(dollHeight)
  const statusRef = useRef<AgentStatus>('idle') // 初始视为 idle,挂载即为 happy 时也能触发庆祝
  const happyStartRef = useRef(-1)

  const storageKey = `pixel-room:${(ownerAddress ?? 'anon').toLowerCase()}`

  // 小人显示尺寸联动(默认 128px;改 dollHeight 全部内部尺寸跟着变)
  useEffect(() => {
    dollRef.current = Math.max(dollHeight, 32)
  }, [dollHeight])

  // 状态变化:只改 walker 参数与附加动作,平滑过渡(不瞬移);
  // 进入 happy 时为每个 walker 排两次弹跳
  useEffect(() => {
    const prev = statusRef.current
    statusRef.current = status
    if (status === 'happy' && prev !== 'happy') {
      happyStartRef.current = clockRef.current
      const t = clockRef.current
      walkersRef.current.forEach((wk) => {
        wk.hopAt = [t + 0.08, t + 0.68]
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // 读取持久化位置(比例坐标);无记录返回 null 由调用方随机落点
  const loadPositions = (): Record<string, { x: number; y: number }> => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    } catch {
      return {}
    }
  }

  const savePositions = () => {
    const out: Record<string, { x: number; y: number }> = {}
    walkersRef.current.forEach((w, id) => {
      out[id] = { x: +w.x.toFixed(4), y: +w.y.toFixed(4) }
    })
    try {
      localStorage.setItem(storageKey, JSON.stringify(out))
    } catch {
      // localStorage 不可用时静默跳过
    }
  }

  // 居民列表 / 装备变化:新建 walker(保留已有位置)、刷新台词、按需重新像素化
  useEffect(() => {
    const saved = loadPositions()
    const seen = new Set<string>()

    inhabitants.forEach((inh) => {
      seen.add(inh.id)
      let w = walkersRef.current.get(inh.id)
      const ek = keyOf(inh.equipped)
      if (!w) {
        const pos = saved[inh.id]
        // equippedKey 置空,让下面的换装分支在首次创建时也触发像素化加载
        w = {
          id: inh.id,
          equippedKey: '',
          lines: inh.lines ?? [],
          x: pos?.x ?? rand(0.15, 0.85),
          y: pos?.y ?? rand(0.55, 0.9),
          tx: 0,
          ty: 0,
          state: 'idle',
          idleT: rand(0.5, 2),
          face: 1,
          phase: 0,
          sprite: null,
          hop: 0,
          bubble: null,
          thinkT: rand(2, 5),
          markT: 0.6,
          hopAt: [],
        }
        walkersRef.current.set(inh.id, w)
      }
      w.lines = inh.lines ?? []
      if (w.equippedKey !== ek) {
        w.equippedKey = ek
        w.sprite = null // 换装:先隐去,像素化完成后恢复(缓存命中则即时)
        getPixelDoll(inh.equipped).then((canvas) => {
          // 以 walker 仍在列表且装备未再变为准(inhabitants 每次渲染是新数组,effect 会重入)
          if (walkersRef.current.get(w.id) !== w || w.equippedKey !== ek) return
          w.sprite = canvas
        })
      }
    })

    // 列表里已不存在的居民移除(多人形态离场)
    walkersRef.current.forEach((_, id) => {
      if (!seen.has(id)) walkersRef.current.delete(id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inhabitants, storageKey])

  // 尺寸跟踪:容器 CSS 尺寸 + 设备像素比,保证像素画清晰
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

  // 点击命中:换算 CSS 坐标,判断落在哪个小人矩形内(从最上层即最后绘制者开始)
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const { w, h } = sizeRef.current
    if (!w || !h) return
    const D = dollRef.current
    const list = [...walkersRef.current.values()]
    for (let i = list.length - 1; i >= 0; i--) {
      const wk = list[i]
      const px = wk.x * w
      const feet = wk.y * h
      if (mx >= px - D / 2 && mx <= px + D / 2 && my >= feet - D && my <= feet + 4) {
        wk.hop = HOP_TIME
        const pool = wk.lines.length > 0 ? wk.lines : DEFAULT_LINES
        wk.bubble = { text: pool[Math.floor(Math.random() * pool.length)], born: clockRef.current, ttl: BUBBLE_TIME }
        break // 只响应最上层一个
      }
    }
  }

  // RAF 主循环:dt 限幅 + 状态机(待机 → 随机目标走动 → 待机)+ 程序化起伏 + Agent 状态行为
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let raf = 0
    let last = performance.now()

    // 走动目标点的纵向活动区间(按小人高度与画布高度推导,防止头顶越出/脚离地)
    const yBounds = (h: number) => {
      const D = dollRef.current
      return { yMin: Math.min((D + 10) / Math.max(h, 1), 0.85), yMax: 0.97 }
    }

    const pickTarget = (wk: Walker) => {
      const { w, h } = sizeRef.current
      const D = dollRef.current
      const margin = D / 2 / Math.max(w, 1) + 0.02
      const { yMin, yMax } = yBounds(h)
      const s = statusRef.current
      if (s === 'thinking' || s === 'signing') {
        // 焦虑/紧张:只在附近小步挪动(thinking 范围稍大)
        const rangeX = s === 'thinking' ? 0.12 : 0.07
        wk.tx = clamp(wk.x + rand(-rangeX, rangeX), margin, 1 - margin)
        wk.ty = clamp(wk.y + rand(-0.05, 0.05), yMin, yMax)
      } else {
        wk.tx = rand(margin, 1 - margin)
        wk.ty = rand(yMin, yMax)
      }
      wk.state = 'walk'
    }

    // happy:在某 walker 头顶撒一把彩色粒子
    const spawnConfetti = (wk: Walker) => {
      const { w, h } = sizeRef.current
      const D = dollRef.current
      const cx = wk.x * w
      const cy = wk.y * h - D * 0.75
      for (let i = 0; i < 26; i++) {
        confettiRef.current.push({
          x: cx + rand(-D * 0.2, D * 0.2),
          y: cy + rand(-D * 0.1, D * 0.1),
          vx: rand(-70, 70),
          vy: rand(-160, -50),
          life: rand(0.7, 1.3),
          color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        })
      }
    }

    const update = (dt: number) => {
      clockRef.current += dt
      const t = clockRef.current
      const { w, h } = sizeRef.current
      const s = statusRef.current
      const D = dollRef.current
      const { yMin, yMax } = yBounds(h)
      const halted = HALT_STATUSES.includes(s)
      // happy 超时后内部回落 idle(调用方通常也会把 status 改回去,双保险)
      const effStatus = s === 'happy' && happyStartRef.current >= 0 && t - happyStartRef.current > HAPPY_TIME ? 'idle' : s
      if (s === 'happy' && effStatus === 'idle') statusRef.current = 'idle'

      // 撒花粒子:重力 + 寿命
      const confetti = confettiRef.current
      for (let i = confetti.length - 1; i >= 0; i--) {
        const p = confetti[i]
        p.life -= dt
        if (p.life <= 0) {
          confetti.splice(i, 1)
          continue
        }
        p.vy += 340 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
      }

      walkersRef.current.forEach((wk) => {
        if (wk.hop > 0) wk.hop = Math.max(0, wk.hop - dt)
        if (wk.bubble && t - wk.bubble.born > wk.bubble.ttl) wk.bubble = null
        wk.y = clamp(wk.y, yMin, yMax) // 小人高度变化后旧持久化位置可能越界,顺手钳制

        // happy:到点弹跳 + 撒花
        while (wk.hopAt.length > 0 && t >= wk.hopAt[0]) {
          wk.hopAt.shift()
          wk.hop = HOP_TIME
          spawnConfetti(wk)
        }

        // 状态附加行为
        if (effStatus === 'thinking') {
          wk.thinkT -= dt
          if (wk.thinkT <= 0 && !wk.bubble) {
            wk.bubble = { text: '…', born: t, ttl: 1.6 }
            wk.thinkT = rand(3, 6)
          }
        } else if (effStatus === 'waiting-sign') {
          // 面向屏幕下方中央(用户所在一侧),并周期性闪 '!' 气泡
          if (w > 0) wk.face = wk.x * w < w / 2 ? 1 : -1
          wk.markT -= dt
          if (wk.markT <= 0 && (!wk.bubble || wk.bubble.text === '!')) {
            wk.bubble = { text: '!', born: t, ttl: 1.4 }
            wk.markT = 3.2
          }
        }

        if (wk.state === 'idle') {
          // 停顿类状态原地待命;其余到点选新目标
          if (!halted && effStatus !== 'happy') {
            wk.idleT -= dt
            if (wk.idleT <= 0) pickTarget(wk)
          }
        } else if (w > 0 && h > 0) {
          // 恒定速度移动(按状态调速,CSS 像素换算到比例坐标),各小人互不干扰
          const speedK = effStatus === 'thinking' ? 1.5 : effStatus === 'signing' ? 2.2 : 1
          const dx = wk.tx - wk.x
          const dy = wk.ty - wk.y
          const dist = Math.hypot(dx * w, dy * h)
          const step = (WALK_SPEED * speedK * dt) / Math.max(dist, 0.0001)
          if (step >= 1 || dist < 2) {
            wk.x = wk.tx
            wk.y = wk.ty
            wk.state = 'idle'
            // 停顿类状态走到后不再出发;signing 快速衔接下一段小碎步
            wk.idleT = halted ? 999 : effStatus === 'signing' ? rand(0.1, 0.35) : rand(1.2, 4)
            if (!halted) savePositions() // 落位时持久化一次
          } else {
            wk.x += dx * step
            wk.y += dy * step
            if (Math.abs(dx * w) > 1) wk.face = dx > 0 ? 1 : -1
            wk.phase += dt * 12 * speedK
          }
        }
      })
    }

    // 背景:地面渐变 + 网格 + 顶部氛围光(容器样式由 Tailwind 负责)
    const drawBackground = (c: CanvasRenderingContext2D, w: number, h: number) => {
      const glow = c.createRadialGradient(w / 2, 0, 0, w / 2, 0, w * 0.7)
      glow.addColorStop(0, 'rgba(139,92,246,0.18)')
      glow.addColorStop(1, 'rgba(139,92,246,0)')
      c.fillStyle = glow
      c.fillRect(0, 0, w, h)
      const floor = c.createLinearGradient(0, h * 0.35, 0, h)
      floor.addColorStop(0, 'rgba(49,46,129,0.10)')
      floor.addColorStop(1, 'rgba(2,6,23,0.55)')
      c.fillStyle = floor
      c.fillRect(0, h * 0.35, w, h * 0.65)
      c.strokeStyle = 'rgba(148,163,184,0.08)'
      c.lineWidth = 1
      c.beginPath()
      for (let gx = 0; gx <= w; gx += 28) {
        c.moveTo(gx, h * 0.35)
        c.lineTo(gx, h)
      }
      for (let gy = h * 0.35; gy <= h; gy += 20) {
        c.moveTo(0, gy)
        c.lineTo(w, gy)
      }
      c.stroke()
    }

    // 气泡:圆角矩形 + 尾巴,文字自动换行,淡入淡出;'!'/'…' 等短标记画小圆泡
    const drawBubble = (c: CanvasRenderingContext2D, wk: Walker, px: number, headY: number, t: number) => {
      const b = wk.bubble
      if (!b) return
      const age = t - b.born
      const alpha = Math.min(1, age / 0.2, Math.max(0, (b.ttl - age) / 0.4))
      if (alpha <= 0) return
      c.save()
      c.globalAlpha = alpha
      const isMark = b.text.length <= 2 && /^[!?…]+$/.test(b.text)
      if (isMark) {
        // 标记气泡:小圆 + 感叹号/省略号
        const r = 11
        const by = Math.max(6 + r, headY - r - 8)
        c.fillStyle = 'rgba(15,17,35,0.92)'
        c.strokeStyle = 'rgba(167,139,250,0.55)'
        c.lineWidth = 1
        c.beginPath()
        c.arc(px, by, r, 0, Math.PI * 2)
        c.fill()
        c.stroke()
        c.beginPath()
        c.moveTo(px - 4, by + r - 2)
        c.lineTo(px + 4, by + r - 2)
        c.lineTo(px, by + r + 5)
        c.closePath()
        c.fill()
        c.fillStyle = '#facc15'
        c.font = 'bold 14px sans-serif'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(b.text, px, by + 1)
        c.restore()
        return
      }
      c.font = '12px sans-serif'
      // 按测量宽度换行(逐字符截断,中文场景够用)
      const maxW = 150
      const lines: string[] = []
      let cur = ''
      for (const ch of b.text) {
        if (c.measureText(cur + ch).width > maxW && cur) {
          lines.push(cur)
          cur = ch
        } else {
          cur += ch
        }
      }
      if (cur) lines.push(cur)
      const lh = 16
      const bw = Math.min(maxW + 18, Math.max(...lines.map((l) => c.measureText(l).width)) + 18)
      const bh = lines.length * lh + 12
      let bx = Math.min(Math.max(px, bw / 2 + 6), sizeRef.current.w - bw / 2 - 6)
      const by = Math.max(6, headY - bh - 10)
      bx = Math.min(Math.max(bx, bw / 2 + 6), sizeRef.current.w - bw / 2 - 6)
      c.fillStyle = 'rgba(15,17,35,0.92)'
      c.strokeStyle = 'rgba(167,139,250,0.55)'
      c.lineWidth = 1
      c.beginPath()
      c.roundRect(bx - bw / 2, by, bw, bh, 8)
      c.fill()
      c.stroke()
      // 尾巴指向小人头顶
      c.beginPath()
      c.moveTo(px - 5, by + bh)
      c.lineTo(px + 5, by + bh)
      c.lineTo(px, by + bh + 7)
      c.closePath()
      c.fill()
      c.fillStyle = '#e2e8f0'
      c.textAlign = 'center'
      c.textBaseline = 'top'
      lines.forEach((l, i) => c.fillText(l, bx, by + 7 + i * lh))
      c.restore()
    }

    const draw = () => {
      const { w, h } = sizeRef.current
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!w || !h) return
      const t = clockRef.current
      const s = statusRef.current
      const D = dollRef.current
      drawBackground(ctx, w, h)
      // 按 y 排序绘制,偏下(近)的小人后画盖住前面的,有一点伪纵深
      const list = [...walkersRef.current.values()].sort((a, b) => a.y - b.y)
      for (const wk of list) {
        const px = wk.x * w
        const feet = wk.y * h
        let offY = 0
        if (wk.hop > 0) offY = -Math.sin((1 - wk.hop / HOP_TIME) * Math.PI) * D * 0.14 // 点击/庆祝弹跳
        if (s === 'confirming') {
          // 踮脚张望:快速小幅上下浮动
          offY -= Math.abs(Math.sin(t * 9 + wk.phase)) * D * 0.035
        } else if (wk.state === 'walk') {
          offY -= Math.abs(Math.sin(wk.phase)) * D * 0.03 // 走动起伏
        } else {
          offY += Math.sin(t * 2 + wk.phase) * D * 0.012 // 待机呼吸
        }
        // 脚下阴影
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.beginPath()
        ctx.ellipse(px, feet + 3, D * 0.32, Math.max(D * 0.04, 3), 0, 0, Math.PI * 2)
        ctx.fill()
        if (wk.sprite) {
          drawPixelDoll(ctx, wk.sprite, px - D / 2, feet + offY - D, D, D, wk.face < 0)
        } else {
          // 像素化加载中:占位小方块
          ctx.fillStyle = 'rgba(148,163,184,0.5)'
          ctx.fillRect(px - D * 0.09, feet + offY - D * 0.18, D * 0.18, D * 0.18)
        }
        drawBubble(ctx, wk, px, feet + offY - D, t)
      }
      // 撒花粒子(画在最上层)
      for (const p of confettiRef.current) {
        ctx.globalAlpha = Math.min(1, p.life / 0.3)
        ctx.fillStyle = p.color
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3)
      }
      ctx.globalAlpha = 1
    }

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      update(dt)
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      savePositions() // 卸载时兜底保存一次
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={boxRef}
      className={`relative overflow-hidden rounded-xl border border-white/10 bg-gradient-to-b from-indigo-950/40 via-slate-900/40 to-slate-950/60 ${heightClass} ${className}`}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full cursor-pointer"
        onPointerDown={onPointerDown}
      />
    </div>
  )
}

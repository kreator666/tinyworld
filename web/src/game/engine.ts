import type { DollSprites } from './sprite'

// ============================================================
// DID 大冒险:2D 卷轴动作游戏引擎(Canvas 2D,框架无关)
// 内部固定分辨率 960×540,世界宽 3600,相机跟随
// ============================================================

export interface HudState {
  hp: number
  score: number
  gems: number
  kills: number
  time: number // 秒
}

export type GameStatus = 'ready' | 'playing' | 'paused' | 'win' | 'dead'

export interface GameHooks {
  onHud?: (h: HudState) => void
  onStatus?: (s: GameStatus) => void
}

// ---------- 常量 ----------
const W = 960
const H = 540
const LEVEL_W = 3600
const GROUND_Y = 460 // 地面顶边
const GRAV = 2400
const MOVE = 260
const JUMP = 830
const MAX_FALL = 1100
const COYOTE = 0.1 // 土狼时间:离开平台后仍可短暂起跳
const JUMP_BUF = 0.12 // 跳跃预输入缓冲
const ATTACK_CD = 0.35
const ATTACK_TIME = 0.16
const INVULN = 1.2
const START_HP = 5
const SPRITE_SCALE = 0.62 // sprite 逻辑尺寸 240(480 画布 2 倍精度) → 约 149px 高的游戏 sprite

// ---------- 调色板(与站点 neon 主题一致) ----------
const PURPLE = '#8b5cf6'
const INDIGO = '#6366f1'
const CYAN = '#22d3ee'

// ---------- 关卡数据 ----------
// 地面段 [x1, x2](实心,从 GROUND_Y 到底部)
const GROUND: [number, number][] = [
  [0, 900],
  [1000, 1800],
  [1900, 2600],
  [2740, LEVEL_W],
]
// 浮空平台 [x, y, w](单向:从下方可穿过)
const FLOATS: [number, number, number][] = [
  [480, 370, 120],
  [700, 300, 110],
  [1050, 360, 130],
  [1300, 290, 110],
  [1550, 370, 120],
  [1950, 350, 120],
  [2150, 280, 110],
  [2400, 360, 120],
  [2800, 350, 130],
  [3050, 280, 110],
  [3250, 370, 120],
]
const GEMS: [number, number][] = [
  [540, 330], [755, 260], [1115, 320], [1355, 250], [1610, 330],
  [2010, 310], [2205, 240], [2460, 320], [2865, 310], [3105, 240], [3310, 330],
  [950, 400], [1850, 400], [2670, 400],
]
// 史莱姆 [巡逻minX, 巡逻maxX]
const SLIMES: [number, number][] = [
  [320, 820],
  [1080, 1560],
  [1980, 2520],
  [2820, 3260],
]
// 无人机 [巡逻minX, 巡逻maxX, 基准高度]
const DRONES: [number, number, number][] = [
  [1150, 1500, 250],
  [2050, 2450, 230],
  [2850, 3350, 240],
]
const PORTAL = { x: 3456, y: 338, w: 68, h: 122 }

// ---------- 类型 ----------
interface Platform {
  x: number
  y: number
  w: number
  h: number
  oneWay: boolean
}

interface Enemy {
  kind: 'slime' | 'drone'
  x: number
  y: number
  w: number
  h: number
  vx: number
  minX: number
  maxX: number
  baseY: number
  t: number
  hp: number
  flash: number
  dead: boolean
  hitSeq: number // 已被哪一次挥砍命中(防止一刀多判)
  face: 1 | -1
}

interface Gem {
  x: number
  y: number
  got: boolean
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  color: string
  grav: number
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

const wrap = (v: number, m: number) => ((v % m) + m) % m

// ============================================================
export class Game {
  private ctx: CanvasRenderingContext2D
  private sprites: DollSprites
  private hooks: GameHooks
  private raf = 0
  private last = 0
  private t = 0 // 全局时间(动画用)
  private elapsed = 0 // 游戏计时(HUD)
  status: GameStatus = 'ready'

  private keys = new Set<string>()
  private cam = 0

  // 玩家
  private p = {
    x: 120,
    y: GROUND_Y - 92,
    w: 34,
    h: 92,
    vx: 0,
    vy: 0,
    face: 1 as 1 | -1,
    grounded: false,
    coyote: 0,
    jbuf: 0,
    attackT: 0,
    attackCd: 0,
    attackSeq: 0,
    invuln: 0,
    runT: 0,
    landT: 0,
    safeX: 120,
    safeY: GROUND_Y - 92,
  }

  private hp = START_HP
  private score = 0
  private gemCount = 0
  private kills = 0

  private platforms: Platform[] = []
  private enemies: Enemy[] = []
  private gems: Gem[] = []
  private particles: Particle[] = []

  // 宠物跟随者
  private pet = { x: 60, y: GROUND_Y - 40 }

  // 远景城市(视差,环带平铺)
  private buildings: { x: number; w: number; h: number; seed: number }[] = []
  private stars: { x: number; y: number; r: number; tw: number }[] = []

  private lastHud: HudState = { hp: -1, score: -1, gems: -1, kills: -1, time: -1 }

  constructor(
    private canvas: HTMLCanvasElement,
    sprites: DollSprites,
    hooks: GameHooks,
  ) {
    this.sprites = sprites
    this.hooks = hooks
    canvas.width = W
    canvas.height = H
    this.ctx = canvas.getContext('2d')!
    this.buildLevel()
    this.buildBackdrop()
  }

  private buildLevel() {
    this.platforms = [
      ...GROUND.map(([x1, x2]): Platform => ({ x: x1, y: GROUND_Y, w: x2 - x1, h: H - GROUND_Y + 60, oneWay: false })),
      ...FLOATS.map(([x, y, w]): Platform => ({ x, y, w, h: 14, oneWay: true })),
    ]
    this.enemies = [
      ...SLIMES.map(([minX, maxX], i): Enemy => ({
        kind: 'slime', x: minX, y: GROUND_Y - 36, w: 46, h: 36,
        vx: 55, minX, maxX, baseY: GROUND_Y - 36, t: i * 1.7, hp: 2, flash: 0, dead: false, hitSeq: 0, face: 1,
      })),
      ...DRONES.map(([minX, maxX, baseY], i): Enemy => ({
        kind: 'drone', x: minX, y: baseY, w: 42, h: 30,
        vx: 75, minX, maxX, baseY, t: i * 2.3, hp: 1, flash: 0, dead: false, hitSeq: 0, face: 1,
      })),
    ]
    this.gems = GEMS.map(([x, y]) => ({ x, y, got: false }))
  }

  private buildBackdrop() {
    // 伪随机(种子固定,画面稳定)
    const rand = (seed: number) => {
      const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453
      return v - Math.floor(v)
    }
    for (let i = 0; i < 42; i++) {
      this.buildings.push({ x: i * 64 + rand(i) * 30, w: 44 + rand(i + 100) * 46, h: 60 + rand(i + 200) * 150, seed: i })
    }
    for (let i = 0; i < 110; i++) {
      this.stars.push({ x: rand(i + 300) * W, y: rand(i + 500) * 330, r: 0.5 + rand(i + 700) * 1.4, tw: rand(i + 900) * 6.28 })
    }
  }

  // ---------- 生命周期 ----------
  start() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.emitHud()
    this.hooks.onStatus?.(this.status)
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }

  begin() {
    if (this.status !== 'ready') return
    this.setStatus('playing')
  }

  togglePause() {
    if (this.status === 'playing') this.setStatus('paused')
    else if (this.status === 'paused') this.setStatus('playing')
  }

  private setStatus(s: GameStatus) {
    this.status = s
    this.hooks.onStatus?.(s)
    if (s === 'win') this.burst(PORTAL.x + 34, PORTAL.y + 40, 70, [PURPLE, CYAN, '#ffffff', '#f472b6'])
  }

  // ---------- 输入 ----------
  private onKeyDown = (e: KeyboardEvent) => {
    const gameKeys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyJ', 'KeyK', 'KeyX', 'KeyP', 'Enter', 'Escape']
    if (gameKeys.includes(e.code)) e.preventDefault()
    if (e.repeat) return
    this.keys.add(e.code)

    if (this.status === 'ready' && (e.code === 'Enter' || e.code === 'Space')) {
      this.begin()
      return
    }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      this.togglePause()
      return
    }
    if (this.status === 'playing' && ['Space', 'ArrowUp', 'KeyW'].includes(e.code)) {
      this.p.jbuf = JUMP_BUF
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
    // 松开跳跃键截断上升:可变跳跃高度
    if (this.status === 'playing' && ['Space', 'ArrowUp', 'KeyW'].includes(e.code) && this.p.vy < 0) {
      this.p.vy *= 0.45
    }
  }

  // ---------- 主循环 ----------
  private loop = (now: number) => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30)
    this.last = now
    this.t += dt
    if (this.status === 'playing') {
      this.elapsed += dt
      this.update(dt)
    }
    this.updateParticles(dt)
    this.draw()
    this.raf = requestAnimationFrame(this.loop)
  }

  private update(dt: number) {
    const p = this.p

    // 计时器
    p.coyote = Math.max(0, p.coyote - dt)
    p.jbuf = Math.max(0, p.jbuf - dt)
    p.attackT = Math.max(0, p.attackT - dt)
    p.attackCd = Math.max(0, p.attackCd - dt)
    p.invuln = Math.max(0, p.invuln - dt)
    p.landT = Math.max(0, p.landT - dt)

    // 攻击
    const attackHeld = this.keys.has('KeyJ') || this.keys.has('KeyK') || this.keys.has('KeyX')
    if (attackHeld && p.attackCd <= 0) {
      p.attackT = ATTACK_TIME
      p.attackCd = ATTACK_CD
      p.attackSeq++
    }

    // 水平移动
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA')
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD')
    p.vx = (right ? MOVE : 0) - (left ? MOVE : 0)
    if (p.vx !== 0) p.face = p.vx > 0 ? 1 : -1
    p.x += p.vx * dt
    p.x = Math.max(0, Math.min(LEVEL_W - p.w, p.x))
    // 水平撞实心地面段边缘(坑位侧壁)
    for (const pl of this.platforms) {
      if (pl.oneWay) continue
      if (overlap(p, pl)) {
        if (p.vx > 0) p.x = pl.x - p.w
        else if (p.vx < 0) p.x = pl.x + pl.w
      }
    }

    // 跳跃(缓冲 + 土狼时间)
    if (p.jbuf > 0 && (p.grounded || p.coyote > 0)) {
      p.vy = -JUMP
      p.jbuf = 0
      p.coyote = 0
      p.grounded = false
    }

    // 垂直移动 + 碰撞
    p.vy = Math.min(p.vy + GRAV * dt, MAX_FALL)
    const prevBottom = p.y + p.h
    p.y += p.vy * dt
    const wasGrounded = p.grounded
    p.grounded = false
    for (const pl of this.platforms) {
      if (!overlap(p, pl)) continue
      if (pl.oneWay) {
        // 单向平台:仅下落且上一帧脚在台面之上时落脚
        if (p.vy >= 0 && prevBottom <= pl.y + 1) {
          p.y = pl.y - p.h
          p.vy = 0
          p.grounded = true
        }
      } else if (p.vy >= 0 && prevBottom <= pl.y + 1) {
        p.y = pl.y - p.h
        p.vy = 0
        p.grounded = true
      } else if (p.vy < 0) {
        p.y = pl.y + pl.h
        p.vy = 0
      }
    }
    if (p.grounded) {
      p.coyote = COYOTE
      if (!wasGrounded) {
        p.landT = 0.14
        this.dust(p.x + p.w / 2, p.y + p.h)
        p.safeX = p.x
        p.safeY = p.y
      }
      if (p.vx !== 0) p.runT += dt
    }

    // 掉落坑
    if (p.y > 660) {
      this.hurtPlayer(1, 0)
      p.x = p.safeX
      p.y = p.safeY - 2
      p.vx = 0
      p.vy = 0
    }

    // 挥砍判定
    if (p.attackT > 0) {
      const slash = { x: p.face > 0 ? p.x + p.w : p.x - 78, y: p.y + 8, w: 78, h: 66 }
      for (const e of this.enemies) {
        if (e.dead || e.hitSeq === p.attackSeq || !overlap(slash, e)) continue
        e.hitSeq = p.attackSeq
        e.hp--
        e.flash = 0.15
        e.x += p.face * 14
        if (e.hp <= 0) {
          e.dead = true
          this.kills++
          this.score += e.kind === 'slime' ? 200 : 150
          this.burst(e.x + e.w / 2, e.y + e.h / 2, 14, e.kind === 'slime' ? [PURPLE, '#c4b5fd'] : [CYAN, '#a5f3fc'])
        } else {
          this.burst(e.x + e.w / 2, e.y + e.h / 2, 5, ['#ffffff'])
        }
        // 空中命中小幅上弹(跳跃攻击手感)
        if (!p.grounded) p.vy = Math.min(p.vy, -240)
      }
    }

    // 敌人
    for (const e of this.enemies) {
      if (e.dead) continue
      e.t += dt
      e.flash = Math.max(0, e.flash - dt)
      e.x += e.vx * dt
      if (e.x < e.minX) {
        e.x = e.minX
        e.vx = Math.abs(e.vx)
      } else if (e.x + e.w > e.maxX) {
        e.x = e.maxX - e.w
        e.vx = -Math.abs(e.vx)
      }
      e.face = e.vx >= 0 ? 1 : -1
      if (e.kind === 'drone') e.y = e.baseY + Math.sin(e.t * 2.2) * 34

      // 接触伤害
      if (p.invuln <= 0 && overlap(p, e)) {
        this.hurtPlayer(1, p.x + p.w / 2 < e.x + e.w / 2 ? -1 : 1)
      }
    }

    // 拾取宝石
    for (const g of this.gems) {
      if (g.got) continue
      const dx = p.x + p.w / 2 - g.x
      const dy = p.y + p.h / 2 - g.y
      if (dx * dx + dy * dy < 42 * 42) {
        g.got = true
        this.gemCount++
        this.score += 100
        this.burst(g.x, g.y, 7, [CYAN, '#a5f3fc'])
      }
    }

    // 终点
    if (overlap(p, PORTAL)) {
      this.score += Math.max(0, 3000 - Math.floor(this.elapsed) * 10) // 速通奖励
      this.setStatus('win')
    }

    // 相机跟随
    const target = Math.max(0, Math.min(LEVEL_W - W, p.x + p.w / 2 - W * 0.42))
    this.cam += (target - this.cam) * Math.min(1, dt * 6)

    // 宠物滞后跟随
    const petTx = p.x + p.w / 2 - p.face * 56
    this.pet.x += (petTx - this.pet.x) * Math.min(1, dt * 4)
    this.pet.y += (p.y + p.h - 40 - this.pet.y) * Math.min(1, dt * 5)

    // 传送门环境粒子
    if (Math.random() < dt * 6) {
      this.particles.push({
        x: PORTAL.x + 10 + Math.random() * 48, y: PORTAL.y + PORTAL.h - 10,
        vx: (Math.random() - 0.5) * 12, vy: -30 - Math.random() * 40,
        life: 1.2, max: 1.2, size: 2, color: CYAN, grav: -20,
      })
    }

    this.emitHud()
  }

  private hurtPlayer(dmg: number, dir: number) {
    if (this.status !== 'playing') return
    this.hp -= dmg
    this.p.invuln = INVULN
    if (dir !== 0) {
      this.p.vy = -300
      this.p.x += dir * 26
    }
    this.burst(this.p.x + this.p.w / 2, this.p.y + 30, 8, ['#f87171'])
    if (this.hp <= 0) {
      this.hp = 0
      this.setStatus('dead')
    }
    this.emitHud()
  }

  // ---------- 粒子 ----------
  private burst(x: number, y: number, n: number, colors: string[]) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 60 + Math.random() * 220
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: 0.5 + Math.random() * 0.5, max: 1, size: 2 + Math.random() * 3,
        color: colors[Math.floor(Math.random() * colors.length)], grav: 500,
      })
    }
  }

  private dust(x: number, y: number) {
    for (let i = 0; i < 5; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 24, y: y - 2,
        vx: (Math.random() - 0.5) * 70, vy: -20 - Math.random() * 30,
        life: 0.35, max: 0.35, size: 2 + Math.random() * 2, color: '#64748b', grav: 160,
      })
    }
  }

  private updateParticles(dt: number) {
    for (const pt of this.particles) {
      pt.life -= dt
      pt.x += pt.vx * dt
      pt.y += pt.vy * dt
      pt.vy += pt.grav * dt
    }
    this.particles = this.particles.filter((pt) => pt.life > 0)
  }

  private emitHud() {
    const h: HudState = { hp: this.hp, score: this.score, gems: this.gemCount, kills: this.kills, time: Math.floor(this.elapsed) }
    const l = this.lastHud
    if (h.hp !== l.hp || h.score !== l.score || h.gems !== l.gems || h.kills !== l.kills || h.time !== l.time) {
      this.lastHud = h
      this.hooks.onHud?.(h)
    }
  }

  // ============================================================
  // 绘制
  // ============================================================
  private draw() {
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    this.drawSky(c)
    this.drawCity(c)
    this.drawWorld(c)
    this.drawParticles(c)
  }

  private drawSky(c: CanvasRenderingContext2D) {
    const g = c.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#0a0a18')
    g.addColorStop(0.7, '#12122a')
    g.addColorStop(1, '#181832')
    c.fillStyle = g
    c.fillRect(0, 0, W, H)

    // 星星(视差 0.08,闪烁)
    for (const s of this.stars) {
      const sx = wrap(s.x - this.cam * 0.08, W)
      c.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(this.t * 1.5 + s.tw))
      c.fillStyle = '#e2e8f0'
      c.fillRect(sx, s.y, s.r, s.r)
    }
    c.globalAlpha = 1

    // 远景霓虹星球
    const px = 780
    const py = 110
    const rg = c.createRadialGradient(px, py, 8, px, py, 90)
    rg.addColorStop(0, 'rgba(139,92,246,0.55)')
    rg.addColorStop(1, 'rgba(139,92,246,0)')
    c.fillStyle = rg
    c.fillRect(px - 90, py - 90, 180, 180)
    c.save()
    c.translate(px, py)
    c.rotate(-0.4)
    c.strokeStyle = 'rgba(34,211,238,0.5)'
    c.lineWidth = 2
    c.beginPath()
    c.ellipse(0, 0, 62, 16, 0, 0, Math.PI * 2)
    c.stroke()
    c.restore()
  }

  private drawCity(c: CanvasRenderingContext2D) {
    // 城市剪影(视差 0.28,环带平铺)
    const span = 42 * 64 + 60
    for (const b of this.buildings) {
      const bx = wrap(b.x - this.cam * 0.28, span) - 60
      if (bx > W + 60) continue
      c.fillStyle = '#0d0d22'
      c.fillRect(bx, GROUND_Y - b.h, b.w, b.h)
      // 亮窗
      const cols = Math.floor(b.w / 14)
      const rows = Math.floor(b.h / 20)
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const lit = Math.sin(b.seed * 91.7 + i * 37.3 + j * 17.9) > 0.35
          if (!lit) continue
          c.fillStyle = (i + j + b.seed) % 3 === 0 ? 'rgba(34,211,238,0.5)' : 'rgba(139,92,246,0.45)'
          c.fillRect(bx + 5 + i * 14, GROUND_Y - b.h + 8 + j * 20, 5, 7)
        }
      }
    }
    // 地平线辉光
    const g = c.createLinearGradient(0, GROUND_Y - 60, 0, GROUND_Y)
    g.addColorStop(0, 'rgba(99,102,241,0)')
    g.addColorStop(1, 'rgba(99,102,241,0.14)')
    c.fillStyle = g
    c.fillRect(0, GROUND_Y - 60, W, 60)
  }

  private drawWorld(c: CanvasRenderingContext2D) {
    c.save()
    c.translate(-Math.round(this.cam), 0)

    this.drawGround(c)
    this.drawPlatforms(c)
    this.drawGems(c)
    this.drawPortal(c)
    for (const e of this.enemies) if (!e.dead) this.drawEnemy(c, e)
    this.drawPet(c)
    this.drawPlayer(c)
    this.drawSlash(c)

    c.restore()
  }

  private drawGround(c: CanvasRenderingContext2D) {
    for (const [x1, x2] of GROUND) {
      c.fillStyle = '#10101f'
      c.fillRect(x1, GROUND_Y, x2 - x1, H - GROUND_Y)
      // 顶边霓虹线(紫→青渐变)
      const g = c.createLinearGradient(x1, 0, x2, 0)
      g.addColorStop(0, PURPLE)
      g.addColorStop(1, CYAN)
      c.strokeStyle = g
      c.lineWidth = 3
      c.shadowColor = PURPLE
      c.shadowBlur = 10
      c.beginPath()
      c.moveTo(x1, GROUND_Y + 1.5)
      c.lineTo(x2, GROUND_Y + 1.5)
      c.stroke()
      c.shadowBlur = 0
      // 网格
      c.strokeStyle = 'rgba(139,92,246,0.1)'
      c.lineWidth = 1
      for (let gx = x1 + 40; gx < x2; gx += 40) {
        c.beginPath()
        c.moveTo(gx, GROUND_Y + 8)
        c.lineTo(gx, H)
        c.stroke()
      }
    }
  }

  private drawPlatforms(c: CanvasRenderingContext2D) {
    for (const [x, y, w] of FLOATS) {
      c.fillStyle = '#151528'
      c.beginPath()
      c.roundRect(x, y, w, 14, 5)
      c.fill()
      c.strokeStyle = CYAN
      c.lineWidth = 2
      c.shadowColor = CYAN
      c.shadowBlur = 8
      c.beginPath()
      c.moveTo(x + 3, y + 1)
      c.lineTo(x + w - 3, y + 1)
      c.stroke()
      c.shadowBlur = 0
      // 底部悬浮光点
      c.fillStyle = 'rgba(34,211,238,0.35)'
      c.fillRect(x + w / 2 - 8, y + 18, 16, 3)
    }
  }

  private drawGems(c: CanvasRenderingContext2D) {
    for (const g of this.gems) {
      if (g.got) continue
      const bob = Math.sin(this.t * 3 + g.x) * 4
      c.save()
      c.translate(g.x, g.y + bob)
      c.rotate(Math.sin(this.t * 2 + g.x) * 0.35)
      c.shadowColor = CYAN
      c.shadowBlur = 14
      c.fillStyle = CYAN
      c.beginPath()
      c.moveTo(0, -10)
      c.lineTo(7.5, 0)
      c.lineTo(0, 10)
      c.lineTo(-7.5, 0)
      c.closePath()
      c.fill()
      c.shadowBlur = 0
      c.fillStyle = 'rgba(255,255,255,0.75)'
      c.beginPath()
      c.moveTo(0, -5)
      c.lineTo(3.2, 0)
      c.lineTo(0, 5)
      c.lineTo(-3.2, 0)
      c.closePath()
      c.fill()
      c.restore()
    }
  }

  private drawPortal(c: CanvasRenderingContext2D) {
    const cx = PORTAL.x + PORTAL.w / 2
    const cy = PORTAL.y + PORTAL.h / 2
    // 背后辉光
    const rg = c.createRadialGradient(cx, cy, 6, cx, cy, 90)
    rg.addColorStop(0, 'rgba(139,92,246,0.5)')
    rg.addColorStop(1, 'rgba(139,92,246,0)')
    c.fillStyle = rg
    c.fillRect(cx - 90, cy - 90, 180, 180)
    // 外环
    c.strokeStyle = PURPLE
    c.lineWidth = 5
    c.shadowColor = PURPLE
    c.shadowBlur = 16
    c.beginPath()
    c.ellipse(cx, cy, 32, 60, 0, 0, Math.PI * 2)
    c.stroke()
    // 内环(旋转虚线)
    c.strokeStyle = CYAN
    c.lineWidth = 2.5
    c.setLineDash([14, 10])
    c.lineDashOffset = -this.t * 40
    c.beginPath()
    c.ellipse(cx, cy, 22, 46, 0, 0, Math.PI * 2)
    c.stroke()
    c.setLineDash([])
    c.shadowBlur = 0
    // 中心流光
    c.fillStyle = `rgba(34,211,238,${0.25 + 0.15 * Math.sin(this.t * 4)})`
    c.beginPath()
    c.ellipse(cx, cy, 14, 36, 0, 0, Math.PI * 2)
    c.fill()
    // 提示文字
    c.fillStyle = CYAN
    c.font = 'bold 16px system-ui, sans-serif'
    c.textAlign = 'center'
    c.fillText('终点 GOAL', cx, PORTAL.y - 16 + Math.sin(this.t * 2.5) * 4)
    c.textAlign = 'left'
  }

  private drawEnemy(c: CanvasRenderingContext2D, e: Enemy) {
    c.save()
    if (e.flash > 0) c.filter = 'brightness(2.5)'
    if (e.kind === 'slime') {
      const squish = 1 + Math.sin(e.t * 6) * 0.08
      const cx = e.x + e.w / 2
      const by = e.y + e.h
      c.translate(cx, by)
      c.scale(squish, 1 / squish)
      // 身体
      const g = c.createRadialGradient(0, -20, 4, 0, -14, 30)
      g.addColorStop(0, '#a78bfa')
      g.addColorStop(1, PURPLE)
      c.fillStyle = g
      c.beginPath()
      c.ellipse(0, -17, 23, 17, 0, 0, Math.PI * 2)
      c.fill()
      // 眼睛(朝向移动方向)
      c.fillStyle = '#fff'
      c.beginPath()
      c.arc(-8 + e.face * 3, -20, 4.5, 0, Math.PI * 2)
      c.arc(6 + e.face * 3, -20, 4.5, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#1e1b4b'
      c.beginPath()
      c.arc(-8 + e.face * 5, -20, 2, 0, Math.PI * 2)
      c.arc(6 + e.face * 5, -20, 2, 0, Math.PI * 2)
      c.fill()
    } else {
      const cx = e.x + e.w / 2
      const cy = e.y + e.h / 2
      c.translate(cx, cy)
      // 旋翼
      c.strokeStyle = 'rgba(226,232,240,0.7)'
      c.lineWidth = 2.5
      const ra = this.t * 25
      c.beginPath()
      c.moveTo(Math.cos(ra) * 16, -20 + Math.sin(ra) * 2)
      c.lineTo(-Math.cos(ra) * 16, -20 - Math.sin(ra) * 2)
      c.stroke()
      // 机身
      c.fillStyle = '#3a3a52'
      c.beginPath()
      c.roundRect(-21, -13, 42, 26, 9)
      c.fill()
      c.strokeStyle = INDIGO
      c.lineWidth = 1.5
      c.stroke()
      // 发光眼
      c.fillStyle = Math.sin(this.t * 6) > 0 ? '#f87171' : CYAN
      c.shadowColor = c.fillStyle
      c.shadowBlur = 8
      c.beginPath()
      c.roundRect(e.face > 0 ? 2 : -12, -5, 10, 8, 3)
      c.fill()
      c.shadowBlur = 0
    }
    c.restore()
  }

  private drawPlayer(c: CanvasRenderingContext2D) {
    const p = this.p
    // 受击无敌闪烁:隔帧不画
    if (p.invuln > 0 && Math.floor(p.invuln * 14) % 2 === 0 && this.status === 'playing') return

    const cx = p.x + p.w / 2
    const feet = p.y + p.h
    c.save()
    c.translate(cx, feet)

    // 程序化动画:跑步起伏 / 空中倾斜 / 落地挤压 / 攻击前冲
    let sx = 1
    let sy = 1
    let rot = 0
    if (p.landT > 0) {
      const k = p.landT / 0.14
      sx += 0.16 * k
      sy -= 0.16 * k
    } else if (p.grounded && p.vx !== 0) {
      const b = Math.sin(p.runT * 16) * 0.045
      sy += b
      sx -= b * 0.6
    }
    if (!p.grounded) rot = Math.max(-900, Math.min(900, p.vy)) / 900 * 0.14 * p.face
    if (p.attackT > 0) rot += p.face * 0.12 * (1 - p.attackT / ATTACK_TIME)
    c.rotate(rot)
    c.scale(p.face * sx, sy)

    const dw = 240 * SPRITE_SCALE
    const dh = 240 * SPRITE_SCALE
    if (this.sprites.doll) {
      c.drawImage(this.sprites.doll, -120 * SPRITE_SCALE, -218 * SPRITE_SCALE, dw, dh)
    } else {
      this.drawFallbackDoll(c)
    }
    c.restore()
  }

  // sprite 加载失败时的兜底小人
  private drawFallbackDoll(c: CanvasRenderingContext2D) {
    c.fillStyle = PURPLE
    c.beginPath()
    c.roundRect(-17, -80, 34, 80, 14)
    c.fill()
    c.fillStyle = '#ffd9c0'
    c.beginPath()
    c.arc(0, -92, 16, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#1e1b4b'
    c.beginPath()
    c.arc(4, -94, 2.4, 0, Math.PI * 2)
    c.arc(11, -94, 2.4, 0, Math.PI * 2)
    c.fill()
  }

  private drawPet(c: CanvasRenderingContext2D) {
    if (!this.sprites.pet) return
    const bob = Math.sin(this.t * 4) * 5
    const s = 0.42
    c.save()
    c.translate(this.pet.x, this.pet.y + 30 + bob)
    c.scale(this.p.face, 1)
    c.drawImage(this.sprites.pet, -120 * s, -218 * s, 240 * s, 240 * s)
    c.restore()
  }

  private drawSlash(c: CanvasRenderingContext2D) {
    const p = this.p
    if (p.attackT <= 0) return
    const prog = 1 - p.attackT / ATTACK_TIME // 0→1
    const cx = p.x + p.w / 2 + p.face * 40
    const cy = p.y + 34
    c.save()
    c.translate(cx, cy)
    c.scale(p.face, 1)
    c.globalAlpha = 1 - prog
    c.strokeStyle = CYAN
    c.lineWidth = 9 - prog * 5
    c.shadowColor = CYAN
    c.shadowBlur = 14
    c.beginPath()
    c.arc(0, 0, 42, -1.25 + prog * 0.6, 0.75 + prog * 0.6)
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,0.9)'
    c.lineWidth = 3
    c.beginPath()
    c.arc(0, 0, 34, -1.1 + prog * 0.6, 0.6 + prog * 0.6)
    c.stroke()
    c.restore()
  }

  private drawParticles(c: CanvasRenderingContext2D) {
    c.save()
    c.translate(-Math.round(this.cam), 0)
    for (const pt of this.particles) {
      c.globalAlpha = Math.max(0, pt.life / pt.max)
      c.fillStyle = pt.color
      c.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size)
    }
    c.restore()
    c.globalAlpha = 1
  }
}

import { useEffect, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Equipped, NFTCategory } from '../types'
import { getPartByLocalId } from '../data/equipmentCatalog'
import {
  BASE_CANVAS,
  BASE_IMAGE,
  SLOT_ANCHORS,
  SLOT_CANVAS,
  type AvatarGender,
  type AvatarSlotKey,
} from '../data/avatarConfig'
import { useAvatarStore } from '../store/avatarStore'

// Q 版纸娃娃(PixiJS): 基底 + 4 插槽装备, 容器树与坐标系见 prototype/v2/design.md §3/§4
// 逻辑坐标: 基底画布 512x1024, 原点 = 脚底中心, y 向上为负

const CATEGORY_TO_SLOT: Record<NFTCategory, AvatarSlotKey> = {
  head: 'head',
  body: 'body',
  accessory: 'acc',
  pet: 'pet',
}

// Z 层级(design.md §3): base=0 → body=1 → head=2 → accessory=3 → pet=4
const SLOT_Z: Record<AvatarSlotKey | 'base', number> = {
  base: 0,
  body: 1,
  head: 2,
  acc: 3,
  pet: 4,
}

interface DollStage {
  app: PIXI.Application
  root: PIXI.Container
  slots: Record<AvatarSlotKey, PIXI.Container>
  base: PIXI.Sprite
}

export default function PaperDoll({
  equipped,
  size = 'md',
  interactive = false,
  gender,
}: {
  equipped: Equipped
  size?: 'sm' | 'md' | 'lg'
  interactive?: boolean // 是否显示缩放/翻转/性别控制
  gender?: AvatarGender // 不传时读取 avatarStore
}) {
  const storeGender = useAvatarStore((s) => s.gender)
  const setGender = useAvatarStore((s) => s.setGender)
  const effectiveGender = gender ?? storeGender

  const [zoom, setZoom] = useState(1)
  const [flip, setFlip] = useState(false)

  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<DollStage | null>(null)
  const zoomRef = useRef(zoom)
  const flipRef = useRef(flip)
  const equipSeq = useRef(0)

  const box = size === 'lg' ? 'w-64 h-64' : size === 'sm' ? 'w-24 h-24' : 'w-44 h-44'

  // 逻辑画布 -> 屏幕: 按高度适配, 脚底贴底, 水平居中
  const layout = () => {
    const stage = stageRef.current
    if (!stage) return
    const { screen } = stage.app
    const scale = (screen.height / BASE_CANVAS.height) * 0.96 * zoomRef.current
    stage.root.scale.set(flipRef.current ? -scale : scale, scale)
    stage.root.position.set(screen.width / 2, screen.height * 0.98)
  }

  // 初始化 Pixi(每实例一个 Application)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    let destroyed = false
    let initialized = false
    let ticker: ((t: PIXI.Ticker) => void) | null = null

    const app = new PIXI.Application()
    app
      .init({ backgroundAlpha: 0, antialias: true, resizeTo: el })
      .then(() => {
        if (destroyed) {
          app.destroy(true, { children: true })
          return
        }
        initialized = true
        el.appendChild(app.canvas)
        app.canvas.style.position = 'absolute'
        app.canvas.style.inset = '0'
        app.canvas.style.pointerEvents = 'none'

        const root = new PIXI.Container()
        root.sortableChildren = true
        app.stage.addChild(root)

        const base = new PIXI.Sprite(PIXI.Texture.EMPTY)
        base.anchor.set(0.5, 1)
        base.position.set(0, 0)
        base.zIndex = SLOT_Z.base
        root.addChild(base)

        const slots = {} as Record<AvatarSlotKey, PIXI.Container>
        ;(['body', 'head', 'acc', 'pet'] as AvatarSlotKey[]).forEach((key) => {
          const c = new PIXI.Container()
          c.zIndex = SLOT_Z[key]
          slots[key] = c
          root.addChild(c)
        })

        stageRef.current = { app, root, slots, base }
        app.renderer.on('resize', layout)
        // 浮动动画(替代原 CSS animate-float)
        ticker = (t) => {
          const s = stageRef.current
          if (!s) return
          const { screen } = s.app
          s.root.position.y = screen.height * 0.98 + Math.sin(t.lastTime / 600) * 4
        }
        app.ticker.add(ticker)
        layout()
        // 触发一次装备/基底刷新
        equipSeq.current++
        refreshRef.current?.()
      })
      .catch(() => {
        // WebGL 不可用时静默降级为空白底色
      })

    return () => {
      destroyed = true
      stageRef.current = null
      if (!initialized) return // init 未完成时由 .then 分支负责销毁
      if (ticker) app.ticker.remove(ticker)
      app.destroy(true, { children: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 基底贴图 + 装备插槽刷新
  const refreshRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const refresh = () => {
      const stage = stageRef.current
      if (!stage) return
      const seq = ++equipSeq.current
      const anchors = SLOT_ANCHORS[effectiveGender]

      // 基底
      PIXI.Assets.load<PIXI.Texture>(BASE_IMAGE[effectiveGender])
        .then((tex) => {
          if (equipSeq.current !== seq || !stageRef.current) return
          stage.base.texture = tex
          stage.base.width = BASE_CANVAS.width
          stage.base.height = BASE_CANVAS.height
        })
        .catch(() => {})

      // 装备插槽
      ;(Object.keys(CATEGORY_TO_SLOT) as NFTCategory[]).forEach((category) => {
        const slotKey = CATEGORY_TO_SLOT[category]
        const container = stage.slots[slotKey]
        container.removeChildren()
        const localId = equipped[category]
        if (!localId) return
        const part = getPartByLocalId(localId)
        if (!part) return
        const cfg = SLOT_CANVAS[slotKey]
        const anchor = anchors[slotKey]
        PIXI.Assets.load<PIXI.Texture>(part.imageUrl)
          .then((tex) => {
            if (equipSeq.current !== seq || !stageRef.current) return
            container.removeChildren()
            const sprite = new PIXI.Sprite(tex)
            sprite.anchor.set(cfg.anchorX, cfg.anchorY)
            sprite.position.set(anchor.offsetX, anchor.offsetY)
            container.addChild(sprite)
          })
          .catch(() => {
            if (equipSeq.current !== seq || !stageRef.current) return
            // 贴图加载失败降级为 emoji 占位
            container.removeChildren()
            const text = new PIXI.Text({ text: part.emoji, style: { fontSize: 96 } })
            text.anchor.set(0.5)
            text.position.set(anchor.offsetX, anchor.offsetY - 120)
            container.addChild(text)
          })
      })
    }
    refreshRef.current = refresh
    refresh()
  }, [equipped, effectiveGender])

  // 缩放/翻转
  useEffect(() => {
    zoomRef.current = zoom
    flipRef.current = flip
    layout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, flip])

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        ref={boxRef}
        className={`relative ${box} rounded-2xl bg-gradient-to-b from-indigo-950/60 via-slate-900/60 to-slate-950/80 overflow-hidden border border-white/10`}
      >
        {/* 背景氛围光 */}
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-40 h-40 rounded-full bg-neon-purple/15 blur-2xl pointer-events-none" />
        <span className="absolute top-2 right-2 tag !text-[10px] border-neon-cyan/40 text-neon-cyan z-10">NFT</span>
      </div>

      {interactive && (
        <div className="flex items-center gap-2 text-xs">
          <button className="btn-ghost !px-2 !py-1" onClick={() => setFlip((f) => !f)} title="左右翻转">⇋</button>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(1)))}>−</button>
          <span className="text-slate-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button className="btn-ghost !px-2 !py-1" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(1)))}>+</button>
          <button
            className="btn-ghost !px-2 !py-1"
            onClick={() => setGender(effectiveGender === 'male' ? 'female' : 'male')}
            title="切换性别"
          >
            {effectiveGender === 'male' ? '♂' : '♀'}
          </button>
        </div>
      )}
    </div>
  )
}

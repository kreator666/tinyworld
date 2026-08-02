import { useEffect, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Equipped, NFTCategory } from '../types'
import { getPartByLocalId } from '../data/equipmentCatalog'
import {
  BASE_CANVAS,
  BASE_IMAGE,
  DEFAULT_BODY_INDEX,
  SLOT_ANCHORS,
  SLOT_CANVAS,
  type AvatarSlotKey,
} from '../data/avatarConfig'

// Q 版纸娃娃(PixiJS, 穿戴切片制式): 基底 + 4 插槽装备
// 所有切片与基底共用 512x1024 画布原点位叠放; body 插槽 = 套装(leg + torso 两张)
// 切片仅有男性版本, 固定使用男性基底

const CATEGORY_TO_SLOT: Record<NFTCategory, AvatarSlotKey> = {
  head: 'head',
  body: 'body',
  accessory: 'acc',
  pet: 'pet',
}

// Z 层级: base=0 → leg=1 → body=2 → head=3 → acc=4 → pet=5
const SLOT_Z: Record<AvatarSlotKey | 'base', number> = {
  base: 0,
  leg: 1,
  body: 2,
  head: 3,
  acc: 4,
  pet: 5,
}

// body 套装的腿切片路径(与 torso 同编号)
const legImageUrl = (index: string) => `/assets/equipment/leg/${index}.png`

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
}: {
  equipped: Equipped
  size?: 'sm' | 'md' | 'lg'
  interactive?: boolean // 是否显示缩放/翻转控制
}) {
  const [zoom, setZoom] = useState(1)
  const [flip, setFlip] = useState(false)

  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<DollStage | null>(null)
  const zoomRef = useRef(zoom)
  const flipRef = useRef(flip)
  const equipSeq = useRef(0)

  // 容器与素材画布同为 1:2, 角色完整占满显示区
  const box = size === 'lg' ? 'w-64 aspect-[1/2]' : size === 'sm' ? 'w-24 aspect-[1/2]' : 'w-44 aspect-[1/2]'

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
        ;(['leg', 'body', 'head', 'acc', 'pet'] as AvatarSlotKey[]).forEach((key) => {
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
      const anchors = SLOT_ANCHORS.male

      // 加载一张贴图到指定插槽容器
      const loadInto = (slotKey: AvatarSlotKey, imageUrl: string, emoji?: string) => {
        const container = stage.slots[slotKey]
        const cfg = SLOT_CANVAS[slotKey]
        const anchor = anchors[slotKey]
        PIXI.Assets.load<PIXI.Texture>(imageUrl)
          .then((tex) => {
            if (equipSeq.current !== seq || !stageRef.current) return
            container.removeChildren()
            const sprite = new PIXI.Sprite(tex)
            sprite.anchor.set(cfg.anchorX, cfg.anchorY)
            sprite.position.set(anchor.offsetX, anchor.offsetY)
            container.addChild(sprite)
          })
          .catch(() => {
            if (equipSeq.current !== seq || !stageRef.current || !emoji) return
            // 贴图加载失败降级为 emoji 占位
            container.removeChildren()
            const text = new PIXI.Text({ text: emoji, style: { fontSize: 96 } })
            text.anchor.set(0.5)
            text.position.set(anchor.offsetX, anchor.offsetY - 480)
            container.addChild(text)
          })
      }

      // 基底(切片仅有男性版本)
      PIXI.Assets.load<PIXI.Texture>(BASE_IMAGE.male)
        .then((tex) => {
          if (equipSeq.current !== seq || !stageRef.current) return
          stage.base.texture = tex
          stage.base.width = BASE_CANVAS.width
          stage.base.height = BASE_CANVAS.height
        })
        .catch(() => {})

      // 清空全部插槽
      ;(['leg', 'body', 'head', 'acc', 'pet'] as AvatarSlotKey[]).forEach((key) => {
        stage.slots[key].removeChildren()
      })

      // body 套装: leg + torso 同编号两张; 空槽时显示默认套装(纯显示)
      const bodyId = equipped.body ?? `body-${DEFAULT_BODY_INDEX}`
      const bodyPart = getPartByLocalId(bodyId)
      const bodyIndex = bodyId.split('-')[1] ?? String(DEFAULT_BODY_INDEX)
      loadInto('leg', legImageUrl(bodyIndex))
      if (bodyPart) loadInto('body', bodyPart.imageUrl, bodyPart.emoji)

      // 其余插槽
      ;(['head', 'accessory', 'pet'] as NFTCategory[]).forEach((category) => {
        const localId = equipped[category]
        if (!localId) return
        const part = getPartByLocalId(localId)
        if (!part) return
        loadInto(CATEGORY_TO_SLOT[category], part.imageUrl, part.emoji)
      })
    }
    refreshRef.current = refresh
    refresh()
  }, [equipped])

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
        </div>
      )}
    </div>
  )
}

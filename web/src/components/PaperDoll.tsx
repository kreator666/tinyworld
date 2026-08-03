import { useEffect, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Equipped } from '../types'
import { getCharacterById } from '../data/characterCatalog'
import { getPartByLocalId } from '../data/equipmentCatalog'

// v4 素材实时预览:head/body 可分别来自不同角色,accessory/pet 沿用装备切片
// 角色由 头.png + 身体.png 拼接,无 base,技术栈 PixiJS

interface StageRef {
  app: PIXI.Application
  root: PIXI.Container
  slots: {
    pet: PIXI.Container
    body: PIXI.Container
    acc: PIXI.Container
    head: PIXI.Container
  }
}

const ACC_DEFAULT_URL = '/assets/equipment/acc/1.png'
const PET_DEFAULT_URL = '/assets/equipment/pet/1.png'
const DEFAULT_CHARACTER_ID = 'character-1'

function localIdToCharacterId(localId: string | null): string {
  const index = localId?.split('-')[1]
  if (!index) return DEFAULT_CHARACTER_ID
  const id = `character-${index}`
  return getCharacterById(id) ? id : DEFAULT_CHARACTER_ID
}

export default function PaperDoll({
  equipped,
  size = 'md',
  interactive = false,
}: {
  equipped: Equipped
  size?: 'sm' | 'md' | 'lg'
  interactive?: boolean
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<StageRef | null>(null)

  const [zoom, setZoom] = useState(1)
  const [flip, setFlip] = useState(false)

  const box = size === 'lg' ? 'w-64 aspect-[1/2]' : size === 'sm' ? 'w-24 aspect-[1/2]' : 'w-44 aspect-[1/2]'

  // 初始化 Pixi 舞台
  useEffect(() => {
    const el = boxRef.current
    if (!el) return

    let cancelled = false
    let app: PIXI.Application | null = null

    const setup = async () => {
      try {
        app = new PIXI.Application()
        await app.init({ backgroundAlpha: 0, antialias: true, resizeTo: el })
        if (cancelled || !app) return

        el.appendChild(app.canvas)
        app.canvas.style.position = 'absolute'
        app.canvas.style.inset = '0'
        app.canvas.style.pointerEvents = 'none'

        const root = new PIXI.Container()
        app.stage.addChild(root)

        const slots = {
          pet: new PIXI.Container(),
          body: new PIXI.Container(),
          acc: new PIXI.Container(),
          head: new PIXI.Container(),
        }
        // Z 序: acc -> body -> head -> pet（配饰在最底层）
        root.addChild(slots.acc)
        root.addChild(slots.body)
        root.addChild(slots.head)
        root.addChild(slots.pet)

        stageRef.current = { app, root, slots }

        app.renderer.on('resize', () => {
          const s = stageRef.current
          if (!s) return
          const k = defaultScaleRef.current * zoomRef.current
          s.root.scale.set(flipRef.current ? -k : k, k)
          s.root.position.set(s.app.screen.width / 2, s.app.screen.height * 0.98)
        })

        app.ticker.add((t) => {
          const s = stageRef.current
          if (!s) return
          s.root.position.y = s.app.screen.height * 0.98 + Math.sin(t.lastTime / 600) * 4
        })
      } catch (e) {
        console.error('PaperDoll setup failed:', e)
      }
    }

    setup()

    return () => {
      cancelled = true
      stageRef.current = null
      const a = app
      app = null
      if (a) {
        try {
          a.destroy(true, { children: true })
        } catch (e) {
          console.warn('PaperDoll destroy:', e)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const defaultScaleRef = useRef(1)
  const zoomRef = useRef(zoom)
  const flipRef = useRef(flip)
  const totalHRef = useRef(1024)

  // 刷新角色/装备
  useEffect(() => {
    const refresh = async () => {
      const s = stageRef.current
      if (!s) return

      const load = async (url: string) => {
        try {
          return await PIXI.Assets.load<PIXI.Texture>(url)
        } catch (e) {
          console.warn('PaperDoll load failed:', url, e)
          return null
        }
      }

      const headChar = getCharacterById(localIdToCharacterId(equipped.head))
      const bodyChar = getCharacterById(localIdToCharacterId(equipped.body))
      if (!headChar || !bodyChar) return

      const [bodyTex, headTex] = await Promise.all([load(bodyChar.bodyUrl), load(headChar.headUrl)])
      if (!bodyTex || !headTex) return

      s.slots.body.removeChildren()
      s.slots.head.removeChildren()

      const bodySp = new PIXI.Sprite(bodyTex)
      bodySp.anchor.set(0.5, 1)
      s.slots.body.addChild(bodySp)

      const headSp = new PIXI.Sprite(headTex)
      headSp.anchor.set(0.5, 1)
      s.slots.head.addChild(headSp)

      const bodyH = bodyTex.height
      const headH = headTex.height
      const overlap = 1
      const totalH = bodyH + headH - overlap
      const headOffset = -(bodyH - overlap)
      totalHRef.current = totalH

      headSp.position.set(0, headOffset)

      // 根据容器大小计算默认缩放
      const { screen } = s.app
      defaultScaleRef.current = (screen.height / totalH) * 0.92

      // 更新 pet
      const petPart = equipped.pet ? getPartByLocalId(equipped.pet) : null
      const petTex = await (petPart ? load(petPart.imageUrl) : load(PET_DEFAULT_URL))

      s.slots.pet.removeChildren()
      if (petTex) {
        const pet = new PIXI.Sprite(petTex)
        pet.anchor.set(0.5, 1)
        const ratio = totalH / 1024
        pet.position.set(180 * ratio, 0)
        pet.visible = !!equipped.pet
        s.slots.pet.addChild(pet)
      }

      const k = defaultScaleRef.current * zoomRef.current
      s.root.scale.set(flipRef.current ? -k : k, k)
      s.root.position.set(s.app.screen.width / 2, s.app.screen.height * 0.98)
    }

    refresh()
  }, [equipped.head, equipped.body, equipped.pet])

  // 单独刷新配饰背景(确保点击配饰时背景立即切换)
  useEffect(() => {
    const updateAccessory = async () => {
      const s = stageRef.current
      if (!s) return

      const load = async (url: string) => {
        try {
          return await PIXI.Assets.load<PIXI.Texture>(url)
        } catch (e) {
          console.warn('PaperDoll accessory load failed:', url, e)
          return null
        }
      }

      const accPart = equipped.accessory ? getPartByLocalId(equipped.accessory) : null
      const imageUrl = accPart ? accPart.imageUrl : ACC_DEFAULT_URL
      const accTex = await load(imageUrl)

      // 计算总高度:优先用 full refresh 缓存,否则从当前 body/head 读取
      let totalH = totalHRef.current
      if (!totalH && s.slots.body.children[0] && s.slots.head.children[0]) {
        totalH = s.slots.body.children[0].height + s.slots.head.children[0].height - 1
      }
      if (!totalH) totalH = 1024

      s.slots.acc.removeChildren()
      if (accTex) {
        const acc = new PIXI.Sprite(accTex)
        acc.anchor.set(0.5, 1)
        const ratio = totalH / 1024
        acc.position.set(0, 0)
        acc.scale.set(ratio)
        acc.visible = !!equipped.accessory
        s.slots.acc.addChild(acc)
      }

      // 重新应用根容器缩放/位置(防止第一次没有 body/head 时错位)
      const k = defaultScaleRef.current * zoomRef.current
      s.root.scale.set(flipRef.current ? -k : k, k)
      s.root.position.set(s.app.screen.width / 2, s.app.screen.height * 0.98)
    }

    updateAccessory()
  }, [equipped.accessory, equipped.head, equipped.body])
  useEffect(() => {
    zoomRef.current = zoom
    flipRef.current = flip
    const s = stageRef.current
    if (!s) return
    const k = defaultScaleRef.current * zoom
    s.root.scale.set(flip ? -k : k, k)
  }, [zoom, flip])

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        ref={boxRef}
        className={`relative ${box} rounded-2xl overflow-hidden border border-white/10 bg-gradient-to-b from-indigo-950/60 via-slate-900/60 to-slate-950/80`}
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

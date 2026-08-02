import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { Game, type GameStatus, type HudState } from '../game/engine'
import { buildDollSprites, type DollSprites } from '../game/sprite'
import PaperDoll from '../components/PaperDoll'
import type { Equipped } from '../types'

// 未铸造 DID 时的演示形象(与首页装饰纸娃娃一致)
const demoEquipped: Equipped = { head: 'head-3', body: 'body-1', accessory: 'acc-1', pet: 'pet-1' }
const MAX_HP = 5

const controls = [
  { keys: 'A / D 或 ← →', action: '移动' },
  { keys: 'Space / W / ↑', action: '跳跃(长按跳更高)' },
  { keys: 'J / X', action: '挥剑攻击' },
  { keys: 'P / Esc', action: '暂停' },
]

const initHud: HudState = { hp: MAX_HP, score: 0, gems: 0, kills: 0, time: 0 }

// 游戏页:Canvas 引擎 + React 覆盖层(HUD / 开始 / 暂停 / 结算)
export default function GamePage() {
  const did = useAppStore((s) => s.did)
  const equipped = did?.equipped ?? demoEquipped

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const spritesRef = useRef<DollSprites | null>(null)

  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<GameStatus>('ready')
  const [hud, setHud] = useState<HudState>(initHud)
  const [runId, setRunId] = useState(0)

  // 加载纸娃娃 sprite(每局共用,重开不重复加载)
  useEffect(() => {
    let cancelled = false
    buildDollSprites(equipped)
      .catch(() => ({ doll: null, pet: null }) as DollSprites)
      .then((s) => {
        if (cancelled) return
        spritesRef.current = s
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 创建 / 重建引擎(重新开始时 runId 变化触发)
  useEffect(() => {
    if (!loaded || !canvasRef.current || !spritesRef.current) return
    const game = new Game(canvasRef.current, spritesRef.current, {
      onHud: setHud,
      onStatus: setStatus,
    })
    gameRef.current = game
    game.start()
    return () => {
      game.destroy()
      gameRef.current = null
    }
  }, [loaded, runId])

  const restart = () => {
    setHud(initHud)
    setRunId((i) => i + 1)
  }

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6">
      {/* 顶部栏 */}
      <div className="mb-4 flex items-center justify-between">
        <Link to="/" className="btn-ghost !px-3 !py-1.5 text-xs">← 返回首页</Link>
        <span className="text-sm text-slate-400">
          出战形象:<span className="text-neon-cyan font-medium">{did ? did.name : '演示纸娃娃(未铸造 DID)'}</span>
        </span>
      </div>

      {/* 游戏画布 + 覆盖层 */}
      <div className="relative rounded-2xl overflow-hidden border border-white/10 shadow-neon-purple bg-ink">
        <canvas ref={canvasRef} className="block w-full h-auto" />

        {/* HUD */}
        {(status === 'playing' || status === 'paused') && (
          <div className="absolute top-0 inset-x-0 p-3 flex items-start justify-between text-sm pointer-events-none">
            <div className="glass !rounded-xl px-3 py-1.5 tracking-wider">
              {Array.from({ length: MAX_HP }, (_, i) => (
                <span key={i}>{i < hud.hp ? '❤️' : '🖤'}</span>
              ))}
            </div>
            <div className="glass !rounded-xl px-3 py-1.5 flex gap-4 font-mono">
              <span className="text-neon-cyan">💎 {hud.gems}</span>
              <span className="text-neon-purple">⚔ {hud.kills}</span>
              <span>⏱ {hud.time}s</span>
              <span className="text-amber-300">分数 {hud.score}</span>
            </div>
          </div>
        )}

        {/* 开始界面 */}
        {status === 'ready' && (
          <div className="absolute inset-0 bg-ink/85 backdrop-blur-sm grid place-items-center">
            <div className="flex items-center gap-8 px-6">
              <div className="hidden md:block shrink-0">
                <PaperDoll equipped={equipped} size="md" />
              </div>
              <div className="max-w-sm">
                <h2 className="text-3xl font-bold bg-neon-grad bg-clip-text text-transparent">DID 大冒险</h2>
                <p className="mt-2 text-sm text-slate-400">
                  操控你的纸娃娃穿越霓虹荒原,击败敌人、收集宝石,抵达终点传送门!
                </p>
                <div className="mt-4 space-y-1.5 text-sm">
                  {controls.map((c) => (
                    <div key={c.keys} className="flex items-center gap-3">
                      <kbd className="tag border-neon-purple/40 text-neon-cyan font-mono">{c.keys}</kbd>
                      <span className="text-slate-300">{c.action}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => gameRef.current?.begin()}
                  disabled={!loaded}
                  className="btn-primary mt-6 text-lg !px-8 !py-3 animate-pulse-ring"
                >
                  {loaded ? '🎮 开始游戏' : '形象加载中…'}
                </button>
                <p className="mt-3 text-xs text-slate-500">也可以按 Enter 开始</p>
              </div>
            </div>
          </div>
        )}

        {/* 暂停 */}
        {status === 'paused' && (
          <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm grid place-items-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold">⏸ 已暂停</h2>
              <div className="mt-6 flex gap-3 justify-center">
                <button onClick={() => gameRef.current?.togglePause()} className="btn-primary">继续(P)</button>
                <button onClick={restart} className="btn-ghost">重新开始</button>
                <Link to="/" className="btn-ghost">返回首页</Link>
              </div>
            </div>
          </div>
        )}

        {/* 胜利结算 */}
        {status === 'win' && (
          <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm grid place-items-center">
            <div className="text-center glass neon-border px-10 py-8">
              <h2 className="text-3xl font-bold bg-neon-grad bg-clip-text text-transparent">🎉 通关!</h2>
              <div className="mt-5 space-y-1.5 text-sm font-mono text-slate-300">
                <p>💎 宝石 × {hud.gems}</p>
                <p>⚔ 击杀 × {hud.kills}</p>
                <p>⏱ 用时 {hud.time}s(含速通奖励)</p>
                <p className="text-lg text-amber-300 pt-2">总分 {hud.score}</p>
              </div>
              <div className="mt-6 flex gap-3 justify-center">
                <button onClick={restart} className="btn-primary">再来一局</button>
                <Link to="/" className="btn-ghost">返回首页</Link>
              </div>
            </div>
          </div>
        )}

        {/* 失败结算 */}
        {status === 'dead' && (
          <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm grid place-items-center">
            <div className="text-center glass px-10 py-8 border border-red-500/30">
              <h2 className="text-3xl font-bold text-red-400">💀 游戏结束</h2>
              <p className="mt-4 text-sm font-mono text-slate-300">
                💎 {hud.gems} · ⚔ {hud.kills} · 分数 {hud.score}
              </p>
              <div className="mt-6 flex gap-3 justify-center">
                <button onClick={restart} className="btn-primary">重新开始</button>
                <Link to="/" className="btn-ghost">返回首页</Link>
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500 text-center">
        键盘操作 · 在铸造工坊打造 DID 身份后,将使用你的专属形象出战
      </p>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { Game, type GameStatus, type HudState } from '../game/engine'
import { buildDollSprites, type DollSprites } from '../game/sprite'
import PaperDoll from '../components/PaperDoll'
import type { Equipped } from '../types'
import { useI18n } from '../i18n'

// 未铸造 DID 时的演示形象(与首页装饰纸娃娃一致)
const demoEquipped: Equipped = { head: 'head-3', body: 'body-1', accessory: 'acc-1', pet: 'pet-1' }
const MAX_HP = 5

const controls = [
  { keysKey: 'gamepage.controls.moveKeys', actionKey: 'gamepage.controls.move' },
  { keysKey: 'gamepage.controls.jumpKeys', actionKey: 'gamepage.controls.jump' },
  { keysKey: 'gamepage.controls.attackKeys', actionKey: 'gamepage.controls.attack' },
  { keysKey: 'gamepage.controls.pauseKeys', actionKey: 'gamepage.controls.pause' },
]

const initHud: HudState = { hp: MAX_HP, score: 0, gems: 0, kills: 0, time: 0 }

// 游戏页:Canvas 引擎 + React 覆盖层(HUD / 开始 / 暂停 / 结算)
export default function GamePage() {
  const { t } = useI18n()
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
        <Link to="/" className="btn-ghost !px-3 !py-1.5 text-xs">{t('gamepage.backHome')}</Link>
        <span className="text-sm text-slate-400">
          {t('gamepage.fighter')}<span className="text-neon-cyan font-medium">{did ? did.name : t('gamepage.demoDoll')}</span>
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
              <span className="text-amber-300">{t('gamepage.hud.score', { score: hud.score })}</span>
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
                <h2 className="text-3xl font-bold bg-neon-grad bg-clip-text text-transparent">{t('gamepage.title')}</h2>
                <p className="mt-2 text-sm text-slate-400">
                  {t('gamepage.intro')}
                </p>
                <div className="mt-4 space-y-1.5 text-sm">
                  {controls.map((c) => (
                    <div key={c.keysKey} className="flex items-center gap-3">
                      <kbd className="tag border-neon-purple/40 text-neon-cyan font-mono">{t(c.keysKey)}</kbd>
                      <span className="text-slate-300">{t(c.actionKey)}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => gameRef.current?.begin()}
                  disabled={!loaded}
                  className="btn-primary mt-6 text-lg !px-8 !py-3 animate-pulse-ring"
                >
                  {loaded ? t('gamepage.start') : t('gamepage.loadingDoll')}
                </button>
                <p className="mt-3 text-xs text-slate-500">{t('gamepage.enterHint')}</p>
              </div>
            </div>
          </div>
        )}

        {/* 暂停 */}
        {status === 'paused' && (
          <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm grid place-items-center">
            <div className="text-center">
              <h2 className="text-2xl font-bold">⏸ {t('gamepage.paused')}</h2>
              <div className="mt-6 flex gap-3 justify-center">
                <button onClick={() => gameRef.current?.togglePause()} className="btn-primary">{t('gamepage.resume')}</button>
                <button onClick={restart} className="btn-ghost">{t('gamepage.restart')}</button>
                <Link to="/" className="btn-ghost">{t('gamepage.home')}</Link>
              </div>
            </div>
          </div>
        )}

        {/* 胜利结算 */}
        {status === 'win' && (
          <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm grid place-items-center">
            <div className="text-center glass neon-border px-10 py-8">
              <h2 className="text-3xl font-bold bg-neon-grad bg-clip-text text-transparent">🎉 {t('gamepage.win')}</h2>
              <div className="mt-5 space-y-1.5 text-sm font-mono text-slate-300">
                <p>{t('gamepage.result.gems', { n: hud.gems })}</p>
                <p>{t('gamepage.result.kills', { n: hud.kills })}</p>
                <p>{t('gamepage.result.time', { n: hud.time })}</p>
                <p className="text-lg text-amber-300 pt-2">{t('gamepage.result.total', { score: hud.score })}</p>
              </div>
              <div className="mt-6 flex gap-3 justify-center">
                <button onClick={restart} className="btn-primary">{t('gamepage.again')}</button>
                <Link to="/" className="btn-ghost">{t('gamepage.home')}</Link>
              </div>
            </div>
          </div>
        )}

        {/* 失败结算 */}
        {status === 'dead' && (
          <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm grid place-items-center">
            <div className="text-center glass px-10 py-8 border border-red-500/30">
              <h2 className="text-3xl font-bold text-red-400">💀 {t('gamepage.gameOver')}</h2>
              <p className="mt-4 text-sm font-mono text-slate-300">
                {t('gamepage.result.gemsShort', { n: hud.gems })} · {t('gamepage.result.killsShort', { n: hud.kills })} · {t('gamepage.hud.score', { score: hud.score })}
              </p>
              <div className="mt-6 flex gap-3 justify-center">
                <button onClick={restart} className="btn-primary">{t('gamepage.restart')}</button>
                <Link to="/" className="btn-ghost">{t('gamepage.home')}</Link>
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-500 text-center">
        {t('gamepage.footer')}
      </p>
    </div>
  )
}

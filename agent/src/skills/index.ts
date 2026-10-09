import { registerSkill } from './registry'
import { socialGreeter } from './social-greeter'
import { defiQuote } from './defi-quote'
import { defiSwap } from './defi-swap'
import { defiSwapSol } from './defi-swap-solana'
import { defiSwapRaydium } from './defi-swap-raydium'
import { defiSwapOrca } from './defi-swap-orca'
import { defiLending } from './defi-lending'
import { ownerTuning } from './owner-tuning'

// 内置技能在这里登记;新增技能只需加一行 registerSkill
registerSkill(socialGreeter)
registerSkill(defiQuote)
registerSkill(defiSwap)
registerSkill(defiSwapSol)
registerSkill(defiSwapRaydium)
registerSkill(defiSwapOrca)
registerSkill(defiLending)
registerSkill(ownerTuning)

export * from './registry'

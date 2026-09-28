import { registerSkill } from './registry'
import { socialGreeter } from './social-greeter'
import { defiQuote } from './defi-quote'
import { defiSwap } from './defi-swap'
import { defiLending } from './defi-lending'

// 内置技能在这里登记;新增技能只需加一行 registerSkill
registerSkill(socialGreeter)
registerSkill(defiQuote)
registerSkill(defiSwap)
registerSkill(defiLending)

export * from './registry'

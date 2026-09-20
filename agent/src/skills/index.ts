import { registerSkill } from './registry'
import { socialGreeter } from './social-greeter'
import { defiQuote } from './defi-quote'

// 内置技能在这里登记;新增技能只需加一行 registerSkill
registerSkill(socialGreeter)
registerSkill(defiQuote)

export * from './registry'

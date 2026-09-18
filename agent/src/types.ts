// 全局类型定义(与 web/src/types.ts 保持一致,前后端各自维护一份,字段变更需同步)

export interface AIProfile {
  template: string // 人设模板
  personality: string // 自定义性格
  tone: string // 语气风格
  replySpeed: 'instant' | 'human' // 回复速度
  topics: string[] // 聊天偏好
  blacklist: string // 规避话题
  socialMode: 'greet' | 'share' | 'passive' // 社交行为
  autoGreet: boolean // 自动接待访客
  autoReply: boolean // 自动回复私信
  memory: boolean // 记忆功能
  emergency: boolean // 紧急接管
}

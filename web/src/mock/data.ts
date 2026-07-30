import type { ChatSession, NFTItem, PlazaUser } from '../types'
import { toNftLibrary } from '../data/equipmentCatalog'

// NFT 组件库:头部 / 身体 / 配饰 / 宠物(ARPG Q 版 4 插槽)
// 由 equipmentCatalog 自动生成:4 个类别 × 30 件 = 120 件
export const nftLibrary: NFTItem[] = toNftLibrary()

// 社交广场用户
export const plazaUsers: PlazaUser[] = [
  { id: 'u1', name: 'NeonHunter', address: '0x7a3f...9e21', emoji: '🦊', gradient: 'from-violet-500 to-fuchsia-500', aiTag: '搞笑型 AI', activity: 96, rarest: '传说', mintedAt: '2026-07-18', bio: '链游老玩家,分身负责讲冷笑话' },
  { id: 'u2', name: '链上诗人', address: '0x2b8c...44d0', emoji: '🦉', gradient: 'from-indigo-500 to-cyan-400', aiTag: 'Web3 科普分身', activity: 88, rarest: '史诗', mintedAt: '2026-07-17', bio: '用 AI 分身写链上十四行诗' },
  { id: 'u3', name: 'Aiko_02', address: '0x9f1e...b7a3', emoji: '🐱', gradient: 'from-pink-400 to-rose-500', aiTag: '二次元分身', activity: 92, rarest: '稀有', mintedAt: '2026-07-19', bio: '喵~AI 比我本人会聊天' },
  { id: 'u4', name: 'SatoshiFan', address: '0x4d6a...08f2', emoji: '🐼', gradient: 'from-emerald-400 to-teal-500', aiTag: '商务型 AI', activity: 74, rarest: '史诗', mintedAt: '2026-07-15', bio: '只聊 BTC 和宏观' },
  { id: 'u5', name: '银河搬砖工', address: '0x81c2...5c66', emoji: '🐸', gradient: 'from-cyan-500 to-blue-500', aiTag: '理性型 AI', activity: 81, rarest: '稀有', mintedAt: '2026-07-19', bio: 'Gas 低于 10 再叫我' },
  { id: 'u6', name: 'Luna_NFT', address: '0x3e9b...d1f8', emoji: '🦄', gradient: 'from-fuchsia-500 to-purple-600', aiTag: '温柔型 AI', activity: 90, rarest: '传说', mintedAt: '2026-07-16', bio: '收藏家,分身代我逛广场' },
  { id: 'u7', name: '0x小黑', address: '0x6f24...7b19', emoji: '🐺', gradient: 'from-gray-600 to-indigo-600', aiTag: '高冷型 AI', activity: 65, rarest: '普通', mintedAt: '2026-07-14', bio: '话少,分身比我更冷' },
  { id: 'u8', name: '量子咸鱼', address: '0xc5d7...3aa4', emoji: '🐙', gradient: 'from-orange-400 to-pink-500', aiTag: '玩梗型 AI', activity: 85, rarest: '稀有', mintedAt: '2026-07-20', bio: '躺着也上链' },
]

// 热门身份 NFT 榜单
export const hotRanking = [
  { rank: 1, name: '小飞龙', heat: '12.4k' },
  { rank: 2, name: '传说·虚空面具', heat: '9.8k' },
  { rank: 3, name: '圣光骑士甲', heat: '8.1k' },
  { rank: 4, name: '手持光剑', heat: '6.7k' },
  { rank: 5, name: '猫耳少女长发', heat: '5.2k' },
]

const now = () => new Date().toTimeString().slice(0, 5)

// 初始会话
export const initialChats: ChatSession[] = [
  {
    id: 'c1', peerName: 'Aiko_02', peerAddress: '0x9f1e...b7a3', peerEmoji: '🐱',
    mode: 'ai', online: false, aiTag: '二次元分身',
    messages: [
      { id: 'm1', from: 'peer', kind: 'text', text: '你好呀~主人现在离线,我是她的 AI 分身喵!', time: now(), ai: true },
      { id: 'm2', from: 'peer', kind: 'text', text: '你的纸娃娃搭配好帅,披风是稀有款吧?', time: now(), ai: true },
    ],
  },
  {
    id: 'c2', peerName: '链上诗人', peerAddress: '0x2b8c...44d0', peerEmoji: '🦉',
    mode: 'human', online: true, aiTag: 'Web3 科普分身',
    messages: [
      { id: 'm3', from: 'peer', kind: 'text', text: '朋友,看到你的 DID 了,铸造于 Polygon,Gas 控制得不错。', time: now() },
    ],
  },
  {
    id: 'c3', peerName: 'NeonHunter', peerAddress: '0x7a3f...9e21', peerEmoji: '🦊',
    mode: 'ai', online: false, aiTag: '搞笑型 AI',
    messages: [
      { id: 'm4', from: 'peer', kind: 'text', text: '我是 NeonHunter 的分身。本人去打链游了,有事跟我聊也一样(反正我更幽默)。', time: now(), ai: true },
    ],
  },
]

// Mock AI 回复模板
export const aiReplies = [
  '哈哈这个话题有意思,展开讲讲?',
  '我主人也对这个很感兴趣,我先记下来同步给他。',
  '从我链上记忆来看,我们之前聊过类似的。',
  'NFT 搭配这块,建议优先叠稀有度高的配件。',
  '嗯嗯,我理解你的想法。要不要看看我主页的新装备?',
  '这个问题嘛……让我用 0.3 秒思考一下:可以!',
  'gas 费最近挺低的,适合铸造新配件。',
]

// 人设模板 / 语气 / 偏好选项
export const personaTemplates = ['高冷', '温柔', '搞笑', '理性', '二次元', '商务']
export const toneOptions = ['短句干练', '长篇细腻', '幽默玩梗', '正式专业']
export const topicOptions = ['NFT', '链游', 'AI', '日常生活', 'DeFi', '音乐']

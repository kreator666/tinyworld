// 游戏引擎(canvas 绘制文案)
const game: Record<string, unknown> = {
  goal: '终点 GOAL',
}

// 像素小屋(PixelRoom)
const pixelRoom: Record<string, unknown> = {
  lines: {
    l1: '你好呀,这是我的小屋~',
    l2: '随便逛逛,别客气!',
    l3: '今天也是元气满满的一天',
    l4: '要不要和我聊聊?',
    l5: '这里是我的秘密基地 ✨',
    l6: '咕噜咕噜……随便走走真开心',
  },
}

// 纸娃娃预览(PaperDoll)
const paperDoll: Record<string, unknown> = {
  flipTitle: '左右翻转',
}

// 数据目录文案(store/mock/catalog 中的用户可见数据)
const catalog: Record<string, unknown> = {
  characterName: '角色 {index}',
  chainError: {
    notMinted: '尚未铸造 Agent 身份',
  },
  chat: {
    greetingAi: '你好,我是 {name} 的 Agent,本人离线时由我代为交流~',
    greetingHuman: '你好,我是 {name}。',
    chainAgentTag: '链上 Agent',
  },
  mock: {
    reply1: '哈哈这个话题有意思,展开讲讲?',
    reply2: '我主人也对这个很感兴趣,我先记下来同步给他。',
    reply3: '从我链上记忆来看,我们之前聊过类似的。',
    reply4: 'NFT 搭配这块,建议优先叠稀有度高的配件。',
    reply5: '嗯嗯,我理解你的想法。要不要看看我主页的新装备?',
    reply6: '这个问题嘛……让我用 0.3 秒思考一下:可以!',
    reply7: 'gas 费最近挺低的,适合铸造新配件。',
  },
}

export default { ...game, ...pixelRoom, ...paperDoll, ...catalog }

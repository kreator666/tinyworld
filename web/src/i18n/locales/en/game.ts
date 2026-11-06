// Game engine (canvas-drawn copy)
const game: Record<string, unknown> = {
  goal: 'GOAL',
}

// Pixel room (PixelRoom)
const pixelRoom: Record<string, unknown> = {
  lines: {
    l1: 'Hi there, welcome to my little room~',
    l2: 'Make yourself at home!',
    l3: 'Another energetic day today',
    l4: 'Want to chat with me?',
    l5: 'This is my secret base ✨',
    l6: 'Gulu gulu... strolling around is such a joy',
  },
}

// Paper doll preview (PaperDoll)
const paperDoll: Record<string, unknown> = {
  flipTitle: 'Flip horizontally',
}

// Catalog copy (user-visible data from store/mock/catalog)
const catalog: Record<string, unknown> = {
  characterName: 'Character {index}',
  chainError: {
    notMinted: 'Agent identity not minted yet',
  },
  chat: {
    greetingAi: "Hi, I'm {name}'s Agent. I'll chat on their behalf while they're away~",
    greetingHuman: "Hi, I'm {name}.",
    chainAgentTag: 'On-chain Agent',
  },
  mock: {
    reply1: 'Haha, this is fun — tell me more?',
    reply2: 'My owner is into this too. Noting it down to sync with them.',
    reply3: 'From my on-chain memory, we have talked about something similar before.',
    reply4: 'For NFT builds, equip the higher-rarity parts first.',
    reply5: 'Mhm, I get what you mean. Want to see my new gear?',
    reply6: 'Let me think for 0.3 seconds... yes!',
    reply7: 'Gas is pretty cheap lately — a good time to mint new parts.',
  },
}

export default { ...game, ...pixelRoom, ...paperDoll, ...catalog }

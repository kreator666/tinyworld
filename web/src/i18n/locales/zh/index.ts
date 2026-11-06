import shell from './shell'
import profile from './profile'
import arena from './arena'
import chat from './chat'
import chain from './chain'
import game from './game'

const zh: Record<string, unknown> = {
  ...shell,
  ...profile,
  ...arena,
  ...chat,
  ...chain,
  ...game,
}

export default zh

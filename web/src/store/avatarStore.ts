import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AvatarGender } from '../data/avatarConfig'

// 纸娃娃外观偏好(纯前端状态, 与链上数据无关)
interface AvatarState {
  gender: AvatarGender
  setGender: (gender: AvatarGender) => void
}

export const useAvatarStore = create<AvatarState>()(
  persist(
    (set) => ({
      gender: 'male',
      setGender: (gender) => set({ gender }),
    }),
    { name: 'tinyworld-avatar' },
  ),
)

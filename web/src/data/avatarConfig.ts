// 本文件由 web/scripts/build-avatar-assets.mjs 自动生成, 请勿手改
// 坐标系: 基底画布 512x1024, 原点 = 脚底中心, y 向上为负
// 各插槽素材画布锚点见 prototype/v2/design.md §2.3
export type AvatarGender = 'male' | 'female'
export type AvatarSlotKey = 'head' | 'body' | 'acc' | 'pet'

export interface SlotAnchor {
  offsetX: number
  offsetY: number
}

export const BASE_CANVAS = { width: 512, height: 1024 } as const

export const SLOT_CANVAS: Record<AvatarSlotKey, { width: number; height: number; anchorX: number; anchorY: number }> = {
  head: { width: 512, height: 512, anchorX: 0.5, anchorY: 1 },
  body: { width: 512, height: 1024, anchorX: 0.5, anchorY: 0 },
  acc: { width: 512, height: 512, anchorX: 0.5, anchorY: 0.5 },
  pet: { width: 512, height: 512, anchorX: 0.5, anchorY: 1 },
}

export const SLOT_ANCHORS: Record<AvatarGender, Record<AvatarSlotKey, SlotAnchor>> = {
  "male": {
    "head": {
      "offsetX": 0,
      "offsetY": -770
    },
    "body": {
      "offsetX": 0,
      "offsetY": -690
    },
    "acc": {
      "offsetX": -130,
      "offsetY": -430
    },
    "pet": {
      "offsetX": 120,
      "offsetY": 0
    }
  },
  "female": {
    "head": {
      "offsetX": 0,
      "offsetY": -770
    },
    "body": {
      "offsetX": 0,
      "offsetY": -690
    },
    "acc": {
      "offsetX": -130,
      "offsetY": -430
    },
    "pet": {
      "offsetX": 120,
      "offsetY": 0
    }
  }
}

export const BASE_IMAGE: Record<AvatarGender, string> = {
  male: '/assets/avatar/base_male.png',
  female: '/assets/avatar/base_female.png',
}

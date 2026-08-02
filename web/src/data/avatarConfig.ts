// 本文件由 web/scripts/build-avatar-assets.mjs 自动生成, 请勿手改
// 穿戴切片制式: 所有切片与基底共用 512x1024 画布, 原点位叠放, offset 全 0
// Z 序: base(0) -> leg(1) -> body(2) -> head(3) -> acc(4) -> pet(5)
// body 插槽 = 套装: torso(equipment/body/{n}.png) + leg(equipment/leg/{n}.png)
export type AvatarGender = 'male' | 'female'
export type AvatarSlotKey = 'leg' | 'body' | 'head' | 'acc' | 'pet'

export interface SlotAnchor {
  offsetX: number
  offsetY: number
}

export const BASE_CANVAS = { width: 512, height: 1024 } as const

// body 空槽时渲染的默认套装编号(纯显示层, 不影响链上数据)
export const DEFAULT_BODY_INDEX = 1

export const SLOT_CANVAS: Record<AvatarSlotKey, { width: number; height: number; anchorX: number; anchorY: number }> = {
  leg: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  body: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  head: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  acc: { width: 512, height: 1024, anchorX: 0.5, anchorY: 1 },
  pet: { width: 512, height: 512, anchorX: 0.5, anchorY: 1 },
}

export const SLOT_ANCHORS: Record<AvatarGender, Record<AvatarSlotKey, SlotAnchor>> = {
  male: {
    leg: { offsetX: 0, offsetY: 0 },
    body: { offsetX: 0, offsetY: 0 },
    head: { offsetX: 0, offsetY: 0 },
    acc: { offsetX: 0, offsetY: 0 },
    pet: { offsetX: 150, offsetY: 0 },
  },
  female: {
    leg: { offsetX: 0, offsetY: 0 },
    body: { offsetX: 0, offsetY: 0 },
    head: { offsetX: 0, offsetY: 0 },
    acc: { offsetX: 0, offsetY: 0 },
    pet: { offsetX: 150, offsetY: 0 },
  },
}

export const BASE_IMAGE: Record<AvatarGender, string> = {
  male: '/assets/avatar/base_male.png',
  female: '/assets/avatar/base_female.png',
}

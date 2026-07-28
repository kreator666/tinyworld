import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Equipped } from '../types'
import { dollParts } from '../components/dollParts'

// 把当前装备的 SVG 纸娃娃序列化成游戏可用的 Image sprite
// 与 PaperDoll 相同的分层顺序: pet → body → accessory → head,锚点=脚底中心 (120,218)

export interface DollSprites {
  doll: HTMLImageElement | null
  pet: HTMLImageElement | null
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('doll sprite 加载失败'))
    }
    img.src = url
  })
}

function layerMarkup(category: keyof Equipped, id: string | null): string {
  if (!id) return ''
  const part = dollParts[category][id]
  return part ? renderToStaticMarkup(createElement(part)) : ''
}

function wrapSvg(layers: string): string {
  // 显式 width/height: Firefox 加载无尺寸 SVG 图像需要
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">${layers}</svg>`
}

export async function buildDollSprites(equipped: Equipped): Promise<DollSprites> {
  // 人物本体不含宠物层:宠物由引擎作为独立跟随者绘制
  const dollSvg = wrapSvg(
    layerMarkup('body', equipped.body) +
      layerMarkup('accessory', equipped.accessory) +
      layerMarkup('head', equipped.head),
  )
  // 宠物单独一张:部件原本画在画布右后方(约 x=184),平移到中心便于独立跟随定位
  const petSvg = equipped.pet
    ? wrapSvg(`<g transform="translate(-64,0)">${layerMarkup('pet', equipped.pet)}</g>`)
    : null

  const [doll, pet] = await Promise.all([
    svgToImage(dollSvg).catch(() => null),
    petSvg ? svgToImage(petSvg).catch(() => null) : Promise.resolve(null),
  ])
  return { doll, pet }
}

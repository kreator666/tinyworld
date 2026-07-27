import type { ReactElement } from 'react'
import type { NFTCategory } from '../types'

// ============================================================
// Q 版 2.5 头身 ARPG 纸娃娃 SVG 部件库
// 画布规范: viewBox 0 0 240 240,统一锚点=脚底中心 (x=120, y=218)
// 渲染层级(从下到上): pet → body → accessory → head
// ============================================================

// ---------- 调色板 ----------
const SKIN = '#FFD9C0'
const SKIN_DARK = '#F0BFA0'
const HAIR_GOLD = '#F2D3A4'
const HAIR_GOLD_DARK = '#E4B87E'
const DRESS_PURPLE = '#8B7BC7'
const DRESS_PURPLE_DARK = '#6E5BA6'
const WHITE_CLOTH = '#F7F2FF'
const GOLD = '#E8B54A'
const BOOT_BROWN = '#6B4A3A'
const GEM_BLUE = '#5EC8E8'

// ---------- 共享部件 ----------

// Q 版通用脸(大眼 + 腮红)
function ChibiFace({ eye = '#4A3226' }: { eye?: string }) {
  return (
    <g>
      <ellipse cx="120" cy="94" rx="36" ry="32" fill={SKIN} />
      <circle cx="106" cy="96" r="7" fill={eye} />
      <circle cx="134" cy="96" r="7" fill={eye} />
      <circle cx="108.5" cy="93" r="2.4" fill="#fff" />
      <circle cx="136.5" cy="93" r="2.4" fill="#fff" />
      <ellipse cx="95" cy="106" rx="5.5" ry="3.2" fill="#FF9EB0" opacity="0.55" />
      <ellipse cx="145" cy="106" rx="5.5" ry="3.2" fill="#FF9EB0" opacity="0.55" />
      <path d="M116,108 Q120,111.5 124,108" stroke="#C26A5A" strokeWidth="2" fill="none" strokeLinecap="round" />
    </g>
  )
}

// 通用脖子
const Neck = <rect x="112" y="114" width="16" height="14" rx="5" fill={SKIN} />

// 通用手臂(垂在身体两侧)
function Arms({ sleeve, hand = SKIN }: { sleeve: string; hand?: string }) {
  return (
    <g>
      <path d="M90,134 Q82,152 79,168" stroke={sleeve} strokeWidth="12" strokeLinecap="round" fill="none" />
      <path d="M150,134 Q158,152 161,168" stroke={sleeve} strokeWidth="12" strokeLinecap="round" fill="none" />
      <circle cx="78" cy="172" r="6.5" fill={hand} />
      <circle cx="162" cy="172" r="6.5" fill={hand} />
    </g>
  )
}

// ============================================================
// 身体层 body
// ============================================================

// body-1 紫晶魔导裙(参考图主造型)
function BodyMageDress() {
  return (
    <g>
      {Neck}
      {/* 腿 */}
      <path d="M110,184 L109,206" stroke={SKIN} strokeWidth="12" strokeLinecap="round" />
      <path d="M130,184 L131,206" stroke={SKIN} strokeWidth="12" strokeLinecap="round" />
      {/* 靴子 */}
      <path d="M99,202 h21 v10 q0,6 -6,6 h-12 q-6,0 -6,-6 v-6 q0,-4 3,-4 Z" fill={BOOT_BROWN} />
      <path d="M120,202 h21 q3,0 3,4 v6 q0,6 -6,6 h-12 q-6,0 -6,-6 Z" fill={BOOT_BROWN} />
      <rect x="99" y="202" width="21" height="4" rx="2" fill={GOLD} opacity="0.7" />
      <rect x="120" y="202" width="21" height="4" rx="2" fill={GOLD} opacity="0.7" />
      {/* A 字裙 */}
      <path d="M96,156 L144,156 L161,194 Q120,206 79,194 Z" fill={DRESS_PURPLE} />
      <path d="M82,191 Q120,202 158,191" stroke={GOLD} strokeWidth="2.5" fill="none" opacity="0.8" />
      <path d="M110,162 L106,192 M130,162 L134,192" stroke={DRESS_PURPLE_DARK} strokeWidth="2" opacity="0.6" />
      {/* 白色上衣 */}
      <path d="M94,130 Q120,123 146,130 L144,157 Q120,163 96,157 Z" fill={WHITE_CLOTH} />
      <path d="M112,130 L120,140 L128,130" stroke={GOLD} strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* 泡泡袖 */}
      <ellipse cx="90" cy="137" rx="11" ry="9" fill={WHITE_CLOTH} />
      <ellipse cx="150" cy="137" rx="11" ry="9" fill={WHITE_CLOTH} />
      {Arms({ sleeve: SKIN })}
      {/* 腰带 + 宝石 */}
      <rect x="95" y="152" width="50" height="8" rx="4" fill={BOOT_BROWN} />
      <circle cx="120" cy="156" r="5" fill={GOLD} />
      <circle cx="120" cy="156" r="3" fill={GEM_BLUE} />
    </g>
  )
}

// body-2 游侠皮甲
function BodyRanger() {
  return (
    <g>
      {Neck}
      <path d="M110,182 L109,204" stroke="#8A6A4A" strokeWidth="12" strokeLinecap="round" />
      <path d="M130,182 L131,204" stroke="#8A6A4A" strokeWidth="12" strokeLinecap="round" />
      <path d="M99,200 h21 v10 q0,6 -6,6 h-12 q-6,0 -6,-6 v-6 q0,-4 3,-4 Z" fill="#4A3626" />
      <path d="M120,200 h21 q3,0 3,4 v6 q0,6 -6,6 h-12 q-6,0 -6,-6 Z" fill="#4A3626" />
      {/* 上衣 */}
      <path d="M94,130 Q120,123 146,130 L143,172 Q120,178 97,172 Z" fill="#4E7A4E" />
      {/* 皮甲背心 */}
      <path d="M104,128 Q120,124 136,128 L134,160 Q120,164 106,160 Z" fill="#7A5A38" />
      <path d="M120,128 L120,162" stroke="#5C4028" strokeWidth="2" />
      <circle cx="120" cy="138" r="2.5" fill={GOLD} />
      <circle cx="120" cy="148" r="2.5" fill={GOLD} />
      {/* 护肩 */}
      <ellipse cx="90" cy="134" rx="11" ry="8" fill="#7A5A38" />
      <ellipse cx="150" cy="134" rx="11" ry="8" fill="#7A5A38" />
      {Arms({ sleeve: '#4E7A4E' })}
      {/* 腰带 */}
      <rect x="97" y="166" width="46" height="7" rx="3.5" fill="#4A3626" />
      <rect x="116" y="166" width="8" height="7" rx="2" fill={GOLD} />
    </g>
  )
}

// body-3 暗夜忍者服
function BodyNinja() {
  return (
    <g>
      {Neck}
      <path d="M110,182 L109,204" stroke="#3A3A52" strokeWidth="12" strokeLinecap="round" />
      <path d="M130,182 L131,204" stroke="#3A3A52" strokeWidth="12" strokeLinecap="round" />
      <path d="M99,200 h21 v10 q0,6 -6,6 h-12 q-6,0 -6,-6 v-6 q0,-4 3,-4 Z" fill="#2A2A3E" />
      <path d="M120,200 h21 q3,0 3,4 v6 q0,6 -6,6 h-12 q-6,0 -6,-6 Z" fill="#2A2A3E" />
      {/* 紧身衣 */}
      <path d="M94,130 Q120,123 146,130 L143,178 Q120,184 97,178 Z" fill="#3A3A52" />
      {/* 胸前护甲 */}
      <path d="M106,130 Q120,126 134,130 L132,156 Q120,160 108,156 Z" fill="#5A4A7A" />
      <path d="M106,138 Q120,142 134,138 M107,147 Q120,151 133,147" stroke="#7A6AAA" strokeWidth="1.5" fill="none" />
      {Arms({ sleeve: '#3A3A52' })}
      {/* 腰绳 */}
      <path d="M96,164 Q120,170 144,164" stroke="#A83A4A" strokeWidth="5" fill="none" />
      <path d="M118,168 L116,180 M122,168 L124,180" stroke="#A83A4A" strokeWidth="3" strokeLinecap="round" />
    </g>
  )
}

// body-4 圣光骑士甲
function BodyKnight() {
  return (
    <g>
      <defs>
        <linearGradient id="grad-knight" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F2F4FA" />
          <stop offset="1" stopColor="#B8C0D4" />
        </linearGradient>
      </defs>
      {Neck}
      <path d="M110,182 L109,204" stroke="#C8CEDD" strokeWidth="12" strokeLinecap="round" />
      <path d="M130,182 L131,204" stroke="#C8CEDD" strokeWidth="12" strokeLinecap="round" />
      <path d="M99,200 h21 v10 q0,6 -6,6 h-12 q-6,0 -6,-6 v-6 q0,-4 3,-4 Z" fill="#9AA2B8" />
      <path d="M120,200 h21 q3,0 3,4 v6 q0,6 -6,6 h-12 q-6,0 -6,-6 Z" fill="#9AA2B8" />
      {/* 裙甲 */}
      <path d="M97,162 L143,162 L152,190 Q120,199 88,190 Z" fill="url(#grad-knight)" />
      <path d="M91,187 Q120,196 149,187" stroke={GOLD} strokeWidth="2" fill="none" />
      {/* 胸甲 */}
      <path d="M94,130 Q120,122 146,130 L143,163 Q120,169 97,163 Z" fill="url(#grad-knight)" />
      <path d="M120,130 L120,150 M112,134 L112,148 M128,134 L128,148" stroke={GOLD} strokeWidth="2" strokeLinecap="round" />
      <circle cx="120" cy="156" r="4.5" fill={GOLD} />
      <circle cx="120" cy="156" r="2.5" fill={GEM_BLUE} />
      {/* 护肩 */}
      <circle cx="89" cy="134" r="10" fill="url(#grad-knight)" stroke={GOLD} strokeWidth="1.5" />
      <circle cx="151" cy="134" r="10" fill="url(#grad-knight)" stroke={GOLD} strokeWidth="1.5" />
      {Arms({ sleeve: '#C8CEDD', hand: '#9AA2B8' })}
    </g>
  )
}

// ============================================================
// 头部层 head
// ============================================================

// head-1 星尘少年短发
function HeadStarboy() {
  return (
    <g>
      <ChibiFace eye="#3A2A4A" />
      {/* 紫色短发 */}
      <path
        d="M84,94 Q78,52 120,48 Q162,52 156,94 Q152,82 144,88 Q146,72 136,76 Q134,64 124,70 Q120,62 112,70 Q104,62 98,76 Q88,72 92,88 Q86,84 84,94 Z"
        fill="#7A5AE0"
      />
      <path d="M92,74 Q120,58 148,74" stroke="#9A7AF0" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* 星星发饰 */}
      <path d="M146,66 l2.2,4.6 4.6,2.2 -4.6,2.2 -2.2,4.6 -2.2,-4.6 -4.6,-2.2 4.6,-2.2 Z" fill="#FFE066" />
    </g>
  )
}

// head-2 赛博机甲头
function HeadMecha() {
  return (
    <g>
      <defs>
        <linearGradient id="grad-mecha" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8A94B8" />
          <stop offset="1" stopColor="#4A5478" />
        </linearGradient>
      </defs>
      <ChibiFace eye="#1A2030" />
      {/* 头盔 */}
      <path d="M84,94 Q78,46 120,42 Q162,46 156,94 L148,92 Q150,66 120,62 Q90,66 92,92 Z" fill="url(#grad-mecha)" />
      {/* 护颊 */}
      <path d="M84,90 L92,88 L92,110 Q86,106 84,98 Z" fill="#4A5478" />
      <path d="M156,90 L148,88 L148,110 Q154,106 156,98 Z" fill="#4A5478" />
      {/* 发光目镜 */}
      <path d="M96,92 Q120,86 144,92" stroke="#3AE8FF" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.9" />
      {/* 天线 */}
      <path d="M120,42 L120,30" stroke="#8A94B8" strokeWidth="3" strokeLinecap="round" />
      <circle cx="120" cy="28" r="4" fill="#3AE8FF" />
      <circle cx="120" cy="28" r="7" fill="#3AE8FF" opacity="0.25" />
    </g>
  )
}

// head-3 猫耳少女(参考图造型)
function HeadCatgirl() {
  return (
    <g>
      {/* 后发:浅金长发垂到肩下 */}
      <path d="M86,78 Q74,120 84,154 Q92,148 92,128 Q90,104 94,88 Z" fill={HAIR_GOLD} />
      <path d="M154,78 Q166,120 156,154 Q148,148 148,128 Q150,104 146,88 Z" fill={HAIR_GOLD} />
      {/* 猫耳 */}
      <path d="M92,56 L84,26 Q84,22 88,24 L112,42 Z" fill={HAIR_GOLD} />
      <path d="M148,56 L156,26 Q156,22 152,24 L128,42 Z" fill={HAIR_GOLD} />
      <path d="M93,49 L89,32 L103,42 Z" fill="#FFB6C1" />
      <path d="M147,49 L151,32 L137,42 Z" fill="#FFB6C1" />
      <ChibiFace eye="#7A4A2A" />
      {/* 前发刘海 */}
      <path
        d="M84,90 Q80,48 120,44 Q160,48 156,90 Q150,78 142,84 Q142,70 132,76 Q130,64 120,72 Q110,64 108,76 Q98,70 98,84 Q90,78 84,90 Z"
        fill={HAIR_GOLD}
      />
      <path d="M96,72 Q120,58 144,72" stroke={HAIR_GOLD_DARK} strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.7" />
      {/* 右侧小花发饰 */}
      <g transform="translate(148,74)">
        <circle r="3" fill="#FFE066" />
        <circle cx="0" cy="-5" r="3" fill="#FFF3B0" />
        <circle cx="4.8" cy="1.5" r="3" fill="#FFF3B0" />
        <circle cx="-4.8" cy="1.5" r="3" fill="#FFF3B0" />
        <circle cx="3" cy="5" r="3" fill="#FFF3B0" />
        <circle cx="-3" cy="5" r="3" fill="#FFF3B0" />
      </g>
    </g>
  )
}

// head-4 虚空面具
function HeadVoidMask() {
  return (
    <g>
      <defs>
        <radialGradient id="grad-void" cx="0.5" cy="0.4" r="0.8">
          <stop offset="0" stopColor="#3A2A5A" />
          <stop offset="1" stopColor="#1A1030" />
        </radialGradient>
      </defs>
      <ellipse cx="120" cy="94" rx="36" ry="32" fill="url(#grad-void)" />
      {/* 面具纹路 */}
      <path d="M120,64 L120,80 M104,70 L112,84 M136,70 L128,84" stroke="#8A5AFF" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
      <path d="M98,112 Q120,120 142,112" stroke="#8A5AFF" strokeWidth="2" fill="none" opacity="0.6" />
      {/* 发光眼 */}
      <ellipse cx="106" cy="96" rx="8" ry="6" fill="#3AE8FF" opacity="0.95" />
      <ellipse cx="134" cy="96" rx="8" ry="6" fill="#3AE8FF" opacity="0.95" />
      <ellipse cx="106" cy="96" rx="12" ry="9" fill="#3AE8FF" opacity="0.2" />
      <ellipse cx="134" cy="96" rx="12" ry="9" fill="#3AE8FF" opacity="0.2" />
      {/* 额间宝石 */}
      <path d="M120,74 l5,7 -5,7 -5,-7 Z" fill="#B98AFF" />
      {/* 暗紫碎发 */}
      <path d="M86,88 Q82,50 120,46 Q158,50 154,88 Q148,74 140,78 Q138,66 128,72 Q124,62 116,70 Q106,64 102,76 Q92,72 86,88 Z" fill="#241640" />
    </g>
  )
}

// ============================================================
// 配饰层 accessory(渲染于 body 之上、head 之下)
// ============================================================

// acc-1 旅人披风(参考图紫色披风,向后飘)
function AccCape() {
  return (
    <g>
      <defs>
        <linearGradient id="grad-cape" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6E5BA6" />
          <stop offset="1" stopColor="#4A3A78" />
        </linearGradient>
      </defs>
      <path d="M94,126 Q68,146 60,198 Q80,192 90,172 Q86,150 94,126 Z" fill="url(#grad-cape)" />
      <path d="M146,126 Q172,146 180,198 Q160,192 150,172 Q154,150 146,126 Z" fill="url(#grad-cape)" />
      <path d="M63,192 Q80,186 89,169 M177,192 Q160,186 151,169" stroke={GOLD} strokeWidth="2" fill="none" opacity="0.7" />
      <circle cx="94" cy="128" r="4" fill={GOLD} />
      <circle cx="146" cy="128" r="4" fill={GOLD} />
      <path d="M94,128 Q120,120 146,128" stroke={GOLD} strokeWidth="3" fill="none" />
    </g>
  )
}

// acc-2 秘法徽章
function AccBrooch() {
  return (
    <g>
      <circle cx="120" cy="140" r="9" fill={GEM_BLUE} opacity="0.25" />
      <circle cx="120" cy="140" r="6.5" fill={GOLD} />
      <circle cx="120" cy="140" r="4" fill={GEM_BLUE} />
      <circle cx="118.5" cy="138.5" r="1.3" fill="#fff" opacity="0.9" />
    </g>
  )
}

// acc-3 手持光剑
function AccSaber() {
  return (
    <g>
      <defs>
        <linearGradient id="grad-saber" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#BFF3FF" />
          <stop offset="1" stopColor="#3AE8FF" />
        </linearGradient>
      </defs>
      <g transform="rotate(-32 162 172)">
        <rect x="158" y="164" width="8" height="16" rx="3" fill="#4A4A5A" />
        <rect x="159.5" y="164" width="5" height="4" fill={GOLD} />
        {/* 光刃 */}
        <rect x="159" y="96" width="6" height="68" rx="3" fill="url(#grad-saber)" />
        <rect x="157" y="96" width="10" height="68" rx="5" fill="#3AE8FF" opacity="0.25" />
      </g>
    </g>
  )
}

// acc-4 光翼
function AccWings() {
  return (
    <g>
      <defs>
        <linearGradient id="grad-wing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DFF6FF" stopOpacity="0.95" />
          <stop offset="1" stopColor="#7AD8F0" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {/* 左翼 */}
      <path d="M92,124 Q56,114 40,82 Q70,90 90,106 Z" fill="url(#grad-wing)" />
      <path d="M92,132 Q62,130 46,110 Q72,112 90,120 Z" fill="url(#grad-wing)" opacity="0.8" />
      {/* 右翼 */}
      <path d="M148,124 Q184,114 200,82 Q170,90 150,106 Z" fill="url(#grad-wing)" />
      <path d="M148,132 Q178,130 194,110 Q168,112 150,120 Z" fill="url(#grad-wing)" opacity="0.8" />
    </g>
  )
}

// ============================================================
// 宠物层 pet(渲染在最底层,人物右后方)
// ============================================================

// pet-1 橘猫(参考图造型)
function PetCat() {
  return (
    <g>
      {/* 尾巴 */}
      <path d="M196,204 Q216,200 212,182" stroke="#E89B4A" strokeWidth="7" strokeLinecap="round" fill="none" />
      <path d="M212,182 Q214,178 211,176" stroke="#C87A2A" strokeWidth="7" strokeLinecap="round" fill="none" />
      {/* 身体 */}
      <ellipse cx="184" cy="202" rx="16" ry="14" fill="#F5B869" />
      <ellipse cx="184" cy="206" rx="9" ry="8" fill="#FCE3C0" />
      {/* 头 */}
      <circle cx="184" cy="184" r="12" fill="#F5B869" />
      {/* 耳 */}
      <path d="M174,178 L172,166 L182,173 Z" fill="#F5B869" />
      <path d="M194,178 L196,166 L186,173 Z" fill="#F5B869" />
      <path d="M175,175 L174,169 L179,172 Z" fill="#FFB6C1" />
      <path d="M193,175 L194,169 L189,172 Z" fill="#FFB6C1" />
      {/* 条纹 */}
      <path d="M178,172 Q184,170 190,172 M176,178 Q184,176 192,178" stroke="#E89B4A" strokeWidth="2" fill="none" />
      {/* 五官 */}
      <circle cx="179" cy="185" r="2.2" fill="#3A2A28" />
      <circle cx="189" cy="185" r="2.2" fill="#3A2A28" />
      <path d="M182,190 Q184,192 186,190" stroke="#C26A5A" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M184,188.5 v1.5" stroke="#C26A5A" strokeWidth="1.5" strokeLinecap="round" />
      {/* 胡须 */}
      <path d="M172,188 L166,187 M172,191 L166,192 M196,188 L202,187 M196,191 L202,192" stroke="#D9C8B8" strokeWidth="1" strokeLinecap="round" />
      {/* 前爪 */}
      <ellipse cx="178" cy="214" rx="4" ry="3" fill="#FCE3C0" />
      <ellipse cx="190" cy="214" rx="4" ry="3" fill="#FCE3C0" />
    </g>
  )
}

// pet-2 柴犬
function PetShiba() {
  return (
    <g>
      {/* 卷尾 */}
      <path d="M196,200 Q208,192 202,184 Q198,180 194,184" stroke="#C88A4A" strokeWidth="7" strokeLinecap="round" fill="none" />
      <ellipse cx="184" cy="202" rx="16" ry="14" fill="#D89A5A" />
      <ellipse cx="184" cy="206" rx="9" ry="8" fill="#FCEFE0" />
      <circle cx="184" cy="184" r="12" fill="#D89A5A" />
      {/* 尖耳 */}
      <path d="M174,178 L172,164 L183,172 Z" fill="#D89A5A" />
      <path d="M194,178 L196,164 L185,172 Z" fill="#D89A5A" />
      {/* 白脸纹 */}
      <ellipse cx="184" cy="189" rx="7" ry="5" fill="#FCEFE0" />
      <ellipse cx="177" cy="178" rx="2" ry="1.4" fill="#FCEFE0" />
      <ellipse cx="191" cy="178" rx="2" ry="1.4" fill="#FCEFE0" />
      <circle cx="179" cy="184" r="2.2" fill="#3A2A28" />
      <circle cx="189" cy="184" r="2.2" fill="#3A2A28" />
      <ellipse cx="184" cy="189" rx="2.4" ry="1.8" fill="#3A2A28" />
      <path d="M184,191 Q184,193 182,194 M184,191 Q184,193 186,194" stroke="#3A2A28" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <ellipse cx="178" cy="214" rx="4" ry="3" fill="#FCEFE0" />
      <ellipse cx="190" cy="214" rx="4" ry="3" fill="#FCEFE0" />
    </g>
  )
}

// pet-3 小飞龙
function PetDrake() {
  return (
    <g>
      <defs>
        <linearGradient id="grad-drake" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9A7AE0" />
          <stop offset="1" stopColor="#6A4AB0" />
        </linearGradient>
      </defs>
      {/* 翅膀 */}
      <path d="M194,198 Q212,188 214,172 Q200,178 191,190 Z" fill="#7A5AC0" />
      {/* 尾巴 */}
      <path d="M196,205 Q214,206 216,194" stroke="#6A4AB0" strokeWidth="6" strokeLinecap="round" fill="none" />
      <path d="M216,194 l5,-4 -1,6 Z" fill="#B98AFF" />
      {/* 身体 */}
      <ellipse cx="184" cy="201" rx="15" ry="14" fill="url(#grad-drake)" />
      <ellipse cx="184" cy="205" rx="8" ry="8" fill="#D8C8F5" />
      {/* 头 */}
      <circle cx="184" cy="183" r="12" fill="url(#grad-drake)" />
      {/* 龙角 */}
      <path d="M176,174 L172,164 L179,170 Z" fill="#B98AFF" />
      <path d="M192,174 L196,164 L189,170 Z" fill="#B98AFF" />
      {/* 吻部 */}
      <ellipse cx="184" cy="188" rx="6" ry="4" fill="#D8C8F5" />
      <circle cx="179" cy="183" r="3" fill="#2A1A3A" />
      <circle cx="189" cy="183" r="3" fill="#2A1A3A" />
      <circle cx="180" cy="181.8" r="1.1" fill="#fff" />
      <circle cx="190" cy="181.8" r="1.1" fill="#fff" />
      {/* 肚皮鳞片 */}
      <path d="M179,202 h10 M180,207 h8" stroke="#B8A4E0" strokeWidth="1.5" strokeLinecap="round" />
    </g>
  )
}

// pet-4 团雀
function PetPiwi() {
  return (
    <g>
      {/* 圆滚滚身体 */}
      <circle cx="184" cy="198" r="17" fill="#8AC8E8" />
      <ellipse cx="184" cy="204" rx="10" ry="8" fill="#E8F4FA" />
      {/* 呆毛 */}
      <path d="M184,181 Q182,174 178,172 M184,181 Q186,174 190,172" stroke="#5AA8C8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* 翅膀 */}
      <ellipse cx="170" cy="200" rx="6" ry="9" fill="#5AA8C8" transform="rotate(20 170 200)" />
      <ellipse cx="198" cy="200" rx="6" ry="9" fill="#5AA8C8" transform="rotate(-20 198 200)" />
      {/* 五官 */}
      <circle cx="178" cy="194" r="2.4" fill="#2A3A44" />
      <circle cx="190" cy="194" r="2.4" fill="#2A3A44" />
      <circle cx="179" cy="193" r="0.9" fill="#fff" />
      <circle cx="191" cy="193" r="0.9" fill="#fff" />
      <path d="M184,197 l-3,2.5 3,2.5 3,-2.5 Z" fill="#F0A84A" />
      {/* 脚 */}
      <path d="M178,215 v3 M181,215 v3 M187,215 v3 M190,215 v3" stroke="#F0A84A" strokeWidth="2" strokeLinecap="round" />
    </g>
  )
}

// ============================================================
// 部件注册表
// ============================================================

export const dollParts: Record<NFTCategory, Record<string, () => ReactElement>> = {
  head: {
    'head-1': HeadStarboy,
    'head-2': HeadMecha,
    'head-3': HeadCatgirl,
    'head-4': HeadVoidMask,
  },
  body: {
    'body-1': BodyMageDress,
    'body-2': BodyRanger,
    'body-3': BodyNinja,
    'body-4': BodyKnight,
  },
  accessory: {
    'acc-1': AccCape,
    'acc-2': AccBrooch,
    'acc-3': AccSaber,
    'acc-4': AccWings,
  },
  pet: {
    'pet-1': PetCat,
    'pet-2': PetShiba,
    'pet-3': PetDrake,
    'pet-4': PetPiwi,
  },
}

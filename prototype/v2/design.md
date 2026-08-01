# 2D正面正交纸娃娃换装系统工程落地设计文档
## 文档信息
- 项目风格：Q版海岛探险平涂卡通
- 素材制式：纯正面正交无透视、透明PNG、统一锚点基准
- 适配引擎：PixiJS(Web)、Unity2D、Cocos Creator 2D、Egret2D
- 核心插槽：基底角色、头部、身体服饰、手持饰品武器、宠物
- 用途：美术素材规范、程序逻辑实现、配置表设计、性能优化、问题排查

## 目录
1. 前置资产说明
2. 素材标准化规范（目录、尺寸、锚点、预处理）
3. 插槽分层与渲染层级定义
4. 引擎容器结构设计
5. 核心业务逻辑伪代码
6. 配置表结构（JSON）
7. 核心功能实现方案
8. 角色动画拓展方案
9. 引擎性能优化策略
10. 可视化编辑器调试方案
11. 常见BUG修复与兼容方案
12. PixiJS旧Demo改造适配方案
13. 项目交付物清单

---

## 1. 前置资产说明
### 1.1 基础角色基底
- `male_base_front.png`：男性正面基底全身立绘
- `female_base_front.png`：女性正面基底全身立绘
约束：固定脚底基线、肩宽、头高、手臂位置，无任何配饰、背包、道具，纯角色本体。

### 1.2 分层换装素材总量
1. 头部装备插槽：30张独立头饰PNG
2. 身体服饰插槽：30件上衣/马甲/披肩/腰带（无后背背包、侧向挂件）
3. 手持饰品武器插槽：30件探险道具、弯刀、渔叉、提灯等
4. 宠物插槽：30只奇幻/海洋/机械Q版宠物

### 1.3 素材统一美术约束
全部素材强制使用规则：
- 视角：纯正面正交平视，禁止斜角、侧身、三点透视
- 画风：柔和轮廓线、浅马卡龙平涂、无阴影、无厚涂
- 背景：透明Alpha通道PNG
- 禁止文字、水印、边框、多余装饰

---

## 2. 素材标准化规范
### 2.1 引擎资源目录结构
SpriteAvatar/
├─ Base/
│ ├─ male_base_front.png
│ └─ female_base_front.png
├─ SlotHead/
│ ├─ head_01.png ~ head_30.png
├─ SlotBody/
│ ├─ body_01.png ~ body_30.png
├─ SlotAccessory/
│ ├─ acc_01.png ~ acc_30.png
├─ SlotPet/
│ ├─ pet_01.png ~ pet_30.png
└─ AvatarConfig.json # 装备偏移、缩放、性别适配配置表


### 2.2 画布尺寸硬性规定
| 素材分类 | 画布尺寸 | 使用目的 |
| ---- | ---- | ---- |
| 角色基底 | 512×1024 | 全身主体，头顶预留15%空白给头饰 |
| 头部装备 | 512×512 | 帽子、发饰适配头部区域 |
| 身体服饰 | 512×1024 | 贴合躯干整体范围 |
| 手持饰品/武器 | 512×512 | 手部挂载道具 |
| 宠物素材 | 512×512 | 角色腰侧跟随宠物 |

### 2.3 全局锚点对齐规则（防穿模核心）
| 素材类型 | 素材锚点设置 | 对齐基准（角色基底） |
| ---- | ---- | ---- |
| 角色基底 | 底部中心点（脚底基线） | 全局父节点定位基准，所有配件以此换算坐标 |
| 头部装备 | 素材底部中心点 | 贴合角色头顶最高点 |
| 身体服饰 | 素材顶部中心点 | 贴合角色双肩连接线 |
| 手持道具 | 素材几何中心点 | 贴合左右手骨骼挂载点 |
| 宠物 | 素材顶部中心点 | 挂载角色左右腰侧点位 |

### 2.4 素材预处理流程（复用Node+Sharp裁切工具）
1. 图集分割：使用Sharp将大图资产网格裁切为独立PNG文件；
2. 空白裁剪：去除图片四周冗余透明像素，减少GPU渲染面积；
3. 素材矫正：斜透视素材使用转正提示词重绘修正；
4. 图集打包：同插槽素材合并为TexturePacker大图，降低DrawCall。

---

## 3. 插槽分层与渲染层级定义
渲染Z值从小到大=渲染从底层至顶层，严格禁止层级颠倒造成穿模
| 插槽名称 | 标识Key | Z层级 | 功能说明 | 可操作 |
| ---- | ---- | ---- | ---- | ---- |
| 角色基底 | base | 0 | 人物本体，性别切换替换贴图 | 不可删除 |
| 身体服饰插槽 | body | 1 | 上衣、马甲、披肩、腰带、下装 | 穿戴/卸下 |
| 头部装备插槽 | head | 2 | 草帽、护目镜、发饰、头巾 | 穿戴/卸下 |
| 手持饰品插槽 | accessory | 3 | 弯刀、渔叉、探险工具、提灯 | 穿戴/卸下 |
| 宠物插槽 | pet | 4 | 跟随宠物伙伴 | 显示/隐藏/更换 |

---

## 4. 引擎容器结构设计（通用2D节点树）
AvatarRoot（角色总容器，控制整体位移、缩放、旋转）
├─ Container_Base (Z=0) → 角色基底 Sprite
├─ Container_Body (Z=1) → 身体装备 Sprite
├─ Container_Head (Z=2) → 头部装备 Sprite
├─ Container_Accessory (Z=3) → 手持道具 Sprite
└─ Container_Pet (Z=4) → 宠物 Sprite
说明：每个插槽独立容器，换装时仅清空当前容器子节点，不影响其他层级。

---

## 5. 核心业务逻辑伪代码
### 5.1 角色初始化
```typescript
/**
 * 初始化角色基底
 * @param isMale 是否男性角色
 */
function InitAvatar(isMale: boolean): void {
    // 替换基础角色贴图
    const baseTexturePath = isMale ? "Base/male_base_front" : "Base/female_base_front";
    SetBaseSpriteTexture(baseTexturePath);
    // 清空全部插槽装备
    ClearAllEquipSlot();
}

/** 清空所有换装插槽 */
function ClearAllEquipSlot(): void {
    Container_Body.removeChildren();
    Container_Head.removeChildren();
    Container_Accessory.removeChildren();
    Container_Pet.removeChildren();
}

5.2 插槽换装核心函数
/**
 * 指定插槽穿戴装备
 * @param slotKey 插槽标识 head/body/accessory/pet
 * @param equipId 装备编号 0=卸下装备
 * @param isMale 角色性别
 */
function SetEquipBySlot(slotKey: string, equipId: number, isMale: boolean): void {
    const slotContainer = GetSlotContainerByKey(slotKey);
    slotContainer.removeChildren();
    // ID为0直接卸下装备，终止逻辑
    if (equipId <= 0) return;

    // 读取配置表偏移、缩放参数
    const config = AvatarConfig[isMale ? "male" : "female"][slotKey][equipId];
    // 加载装备贴图
    const texPath = `${slotKey}/${slotKey}_${String(equipId).padStart(2, "0")}`;
    const equipSprite = CreateSprite(texPath);

    // 坐标与缩放赋值
    equipSprite.x = config.offsetX;
    equipSprite.y = config.offsetY;
    equipSprite.scale.set(config.scale, config.scale);
    slotContainer.addChild(equipSprite);
}

5.3 快捷卸下装备
// 卸下头部装备
SetEquipBySlot("head", 0, true);

6. 配置表结构（AvatarConfig.json）
整体结构
{
  "male": {
    "head": {
      "1": {"offsetX": 0, "offsetY": -420, "scale": 1.0},
      "2": {"offsetX": 0, "offsetY": -418, "scale": 1.0}
    },
    "body": {},
    "accessory": {},
    "pet": {}
  },
  "female": {
    "head": {},
    "body": {},
    "accessory": {},
    "pet": {}
  }
}

字段说明：
offsetX：相对角色基底中心点横向偏移
offsetY：相对角色基底中心点纵向偏移
scale：素材整体缩放系数（适配大头头饰、巨型宠物微调）
优势：美术在调试工具修改坐标，直接导出 JSON，程序无需硬编码坐标。

穿搭存档 JSON 结构
用于本地存档、数据库存储角色穿搭

{
  "isMale": true,
  "headId": 5,
  "bodyId": 12,
  "accId": 8,
  "petId": 22
}

7. 核心功能实现方案
7.1 角色性别切换
替换基底角色贴图；
使用当前穿搭 ID，读取对应性别配置表刷新全部装备位置；
保留原有穿搭组合，仅适配女性坐标。
7.2 一键全脱装
调用ClearAllEquipSlot()，仅保留角色基底。
7.3 宠物显隐控制
typescript
运行
Container_Pet.visible = false; //隐藏宠物
Container_Pet.visible = true;  //显示宠物
优势：不销毁贴图，性能更高。

7.4 穿搭存档与读取
存档：读取四个插槽 ID + 性别，序列化为 JSON 存储；
读取：解析 JSON，循环调用SetEquipBySlot还原全套穿搭。
8. 角色动画拓展方案（待机 / 行走动作）
当前为静态立绘，如需动作动画适配规则：
基底角色拆分 Idle、Walk 正向序列帧；
所有装备、宠物使用同等帧数量拆分序列帧素材；
动画播放时，基底与装备、宠物使用同一帧索引同步播放，保证动作贴合无错位。
9. 引擎性能优化策略
图集合并：同插槽素材打包大图，合并 DrawCall；
闲置资源销毁：切换穿搭时销毁未使用 Sprite，释放贴图内存；
纹理复用：同一宠物多次实例化共用一张纹理资源；
透明裁剪：素材预处理裁掉空白透明边，降低透明混合渲染开销；
宠物缓存：常驻宠物 Sprite，仅切换纹理而非新建节点。
10. 可视化编辑器调试方案
编辑器核心调试功能
绘制基准标线：脚底基线、双肩线、头顶基准线；
拖拽装备 Sprite 实时修改 offsetX、offsetY；
滑动条调整 scale 缩放值；
一键导出当前调试参数至AvatarConfig.json。
使用场景
美术 / 策划可视化调校装备位置，直接输出配置给程序，省去手动计算坐标。

11. 常见 BUG 修复与兼容方案
问题现象	根因	解决方案
装备穿插穿模	1. 素材存在斜透视2. 层级颠倒	1. 使用素材转正提示词重绘素材2. 严格按照 Z 层级搭建容器
装备整体错位	锚点基准不统一、坐标配置错误	以角色基底标线重新校准配置表
贴图边缘黑边	Alpha 通道未预乘	引擎开启 Sprite 预乘 Alpha，PNG 导出开启透明预乘
内存持续上涨	频繁创建 Sprite 不销毁	切换穿搭销毁旧节点，使用对象池复用 Sprite

13. 项目最终交付物清单
标准化素材文件夹（完整目录结构）
角色坐标配置 JSON：AvatarConfig.json
多语言通用业务伪代码（TS/C#/Lua 可直接复用）
美术素材修复 AI 提示词（透视矫正、尺寸对齐）
简易可视化穿搭调试工具实现逻辑
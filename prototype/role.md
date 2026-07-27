# PixiJS Q版纸娃娃方案（4插槽极简版）
需求梳理
> 插槽：头部 / 身体 / 配饰 / 宠物（4层，无复杂防具拆分，轻量化Q版立绘预览，用于网页角色面板、装备试穿）
> 渲染：PixiJS v7/v8，自动降级WebGL/Canvas；静态图层叠加，可选增加轻微浮动待机动画
> 用途：仅预览，不需要战斗动画，点击装备切换部件

## 一、整体架构设计
### 1. 图层渲染顺序（Z层级，从上往下=渲染先后，底层最先绘制）
```
1. base_bg（可选背景）
2. pet        宠物层
3. body       身体主体
4. accessory  配饰
5. head       头部
```
> ⚠ 层级顺序非常关键：宠物在人物背后；头部盖身体、配饰穿插中间，防止穿模。
你可以根据美术效果微调，标准Q版人设推荐上面顺序。

### 2. 数据结构（前后端通用JSON）
```ts
// 当前角色穿戴配置
interface DollConfig {
  headId: string | null;
  bodyId: string | null;
  accessoryId: string | null;
  petId: string | null;
}

// 装备资源注册表（前端静态配置）
const assetMap = {
  head: {
    "head_01": "assets/q/head/head01.png",
    "head_02": "assets/q/head/head02.png",
  },
  body: {
    "body_01": "assets/q/body/body01.png",
  },
  accessory: {
    "acc_ribbon": "assets/q/acc/ribbon.png",
  },
  pet: {
    "pet_cat": "assets/q/pet/cat.png",
  }
}
```

### 3. Pixi容器结构
```
dollRoot (PIXI.Container 总容器，整体居中、缩放)
├─ petContainer
├─ bodyContainer
├─ accessoryContainer
└─ headContainer
```
每个容器内只保留当前激活的Sprite；更换装备时：销毁旧Sprite → 加载纹理 → 创建新Sprite放入容器。

## 二、美术输出规范（直接发给美术）
1. 全部素材 **透明PNG**
2. 统一基准锚点：**人物脚底中心点为对齐原点**
3. 尺寸建议基准画布：512×512（2倍高清素材 1024×1024）
4. 所有部件独立分层导出：头部、身体、配饰、宠物分开文件
5. 禁止部件画布大小不一致，否则换装会偏移
6. Q版风格：头身比 2~3头身

## 三、完整最小可运行示例代码（PixiJS v8）
> 可直接新建html打开运行，内置资源缓存、换装函数
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Q版纸娃娃 PixiJS Demo</title>
<script src="https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js"></script>
<style>
  body{background:#222;display:flex;gap:20px;padding:20px;color:#fff}
  #view{border:1px solid #666}
  .ctrl button{margin:4px;padding:6px 10px}
</style>
</head>
<body>
<div>
  <canvas id="view"></canvas>
</div>
<div class="ctrl">
  <h4>换装测试</h4>
  <div>
    <p>头部</p>
    <button onclick="changePart('head','head_01')">头饰1</button>
    <button onclick="changePart('head','head_02')">头饰2</button>
    <button onclick="changePart('head',null)">清空</button>
  </div>
  <div>
    <p>身体</p>
    <button onclick="changePart('body','body_01')">服装A</button>
  </div>
  <div>
    <p>配饰</p>
    <button onclick="changePart('accessory','acc_ribbon')">丝带</button>
  </div>
  <div>
    <p>宠物</p>
    <button onclick="changePart('pet','pet_cat')">小猫宠物</button>
    <button onclick="changePart('pet',null)">收回宠物</button>
  </div>
</div>

<script>
// ========== 初始化 ==========
const app = new PIXI.Application({
  canvas: document.getElementById('view'),
  width: 512,
  height: 512,
  antialias: true,
  background: 0x333344
});

// 总容器
const dollRoot = new PIXI.Container();
dollRoot.position.set(256, 420); // 基准锚点，脚底居中
app.stage.addChild(dollRoot);

// 分层容器（顺序=渲染从下至上）
const layers = {
  pet: new PIXI.Container(),
  body: new PIXI.Container(),
  accessory: new PIXI.Container(),
  head: new PIXI.Container()
};
dollRoot.addChild(layers.pet);
dollRoot.addChild(layers.body);
dollRoot.addChild(layers.accessory);
dollRoot.addChild(layers.head);

// 纹理缓存
const textureCache = new Map();

// 资源路径配置
const assetPath = {
  head: {
    "head_01": "./assets/head01.png",
    "head_02": "./assets/head02.png"
  },
  body: {
    "body_01": "./assets/body01.png"
  },
  accessory: {
    "acc_ribbon": "./assets/ribbon.png"
  },
  pet: {
    "pet_cat": "./assets/cat.png"
  }
};

// ========== 换装核心函数 ==========
async function changePart(type, assetId) {
  const container = layers[type];
  // 清空当前层
  container.removeChildren();
  if(!assetId) return;

  const url = assetPath[type][assetId];
  let tex = textureCache.get(url);
  if(!tex){
    tex = await PIXI.Assets.load(url);
    textureCache.set(url, tex);
  }
  const spr = new PIXI.Sprite(tex);
  spr.anchor.set(0.5,1); // 锚点：水平居中、底部对齐（脚底基准）
  container.addChild(spr);
}

// 可选：增加轻微上下浮动待机动画
app.ticker.add((t)=>{
  dollRoot.y = 420 + Math.sin(t.time*0.0015) * 4;
})

// 初始加载默认形象
changePart("body","body_01");
changePart("head","head_01");
changePart("pet","pet_cat");
</script>
</body>
</html>
```

## 四、动画扩展（可选）
代码内自带简易呼吸浮动；想要更精致可以：
1. 每层Sprite独立偏移，制造错落晃动
2. 宠物单独增加更大摆动幅度
3. 武器/配饰增加缓慢旋转

## 五、实例效果图说明（文字描述，你可以直接拿给美术参考出图）
我给你标准Q版分层视觉布局参考，你可以直接让美术按照这个构图绘制分层PNG素材：
### 画面构图（512×512画布）
- **宠物层(pet)**：放在人物左后方偏下位置，体型小于主角Q版小人
- **身体(body)**：2.5头身Q版小人躯干+四肢主体（不含头部）
- **配饰(accessory)**：飘带、背包、围巾，穿插在头与身体之间
- **头部(head)**：脸部、发型、头饰，叠加在身体上方

### 分层示意图（文本模拟层级叠加预览）
```
        【head 头部/发型/帽子】
【accessory 飘带、小配饰】
        【body Q版身体衣服】
【pet 宠物小猫/小动物 在人物身后左下角】
```

如果你需要，我可以生成一张**分层概念参考图提示词**，丢AI绘图直接产出4层可拆分的Q版纸娃娃参考素材：
> 提示词（Midjourney / Stable Diffusion通用，透明分层Q版人设）
```
Q版2.5头身少女，奇幻RPG风格，干净平涂上色，无阴影，透明背景。分层拆分：独立头部图层、身体服装图层、飘带配饰图层、身后小猫宠物图层。人物脚底居中对齐，所有部件锚点统一，适合网页纸娃娃换装，像素清晰，512尺寸，卡通简约ARPG画风
```

## 六、后续可拓展功能
1. 角色搭配截图导出：`app.renderer.extract.image(dollRoot)`
2. 装备染色：Pixi ColorMatrixFilter
3. 左右翻转形象：`dollRoot.scale.x = -1`
4. 装备点击预览弹窗
5. 保存穿搭配置到LocalStorage

## 七、避坑清单
1. 统一锚点 `anchor(0.5,1)`，不然换装部件上下左右漂移
2. 严格锁定渲染层级，宠物永远底层
3. 一定要做纹理缓存，多次切换装备不会重复请求图片
4. 移动端可以限制最大缩放，避免画布过大性能下降

如果你想要，我可以进一步：
1. 改成 Vue/React 组件版本
2. 输出一份完整美术分层导出清单
3. 或者生成AI绘图指令，直接产出几套可用于测试的分层PNG素材！
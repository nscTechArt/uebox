<template>
  <div class="brand-sphere" :class="`speaker-${speaker}`" :style="containerStyle">
    <!-- 外辉光。画在裁切圆之外，所以是壳的兄弟不是孩子 -->
    <div class="sphere-halo"></div>

    <div class="sphere-shell">
      <!-- 玻璃里面的液体：三团光 + 中心那点亮 -->
      <div class="sphere-field">
        <div class="sphere-blob blob-emerald"></div>
        <div class="sphere-blob blob-azure"></div>
        <div class="sphere-blob blob-indigo"></div>
      </div>
      <div class="sphere-core"></div>

      <!-- 玻璃本体：把背后（含上面那几团）糊开、提彩度。液态玻璃的「厚度」从这里来 -->
      <div class="sphere-frost"></div>

      <!-- 边缘折射：球最厚的地方是边，光在那里被压缩、被拉亮 -->
      <div class="sphere-edge"></div>

      <!-- 镜面高光：一道绕着球慢慢转的光。它是「这是一块玻璃」的唯一硬证据 -->
      <div class="sphere-specular"></div>

      <!-- 边缘：细边 + 顶部内高光 + 底部内阴影 + 两道极淡的色散 -->
      <div class="sphere-rim"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 品牌球 / 语音球 —— 一块装着液体的玻璃。
 *
 * ## 为什么分深浅两套形态
 *
 * 「玻璃」在两个环境里是**两种东西**：深色下它是一颗发光的黑玻璃球，
 * 里面三团光靠 screen 往外透；浅色下它是一块磨砂白玻璃，里面三团是被磨砂
 * 糊开的颜料。照搬深色那套到白底上，screen 叠加等于不叠 —— 得到一个洗白的圆饼。
 * 所以底色、混合模式、边缘的明暗方向，三样都跟着主题翻。
 *
 * ## 玻璃是怎么做出来的
 *
 * 关键不是画一个渐变，是 `backdrop-filter`：玻璃层**真的**在采样它背后的东西
 * （里面那三团光、以及页面），再糊开、提彩度。所以三团光是「透过玻璃看到的」，
 * 不是「贴在玻璃上的」—— 两者的区别一眼能看出来，前者有厚度。
 *
 * 剩下几重都在描述这块玻璃的表面：绕着转的镜面高光、一圈细边、
 * 边缘两道极淡的色散（真玻璃的边总会把光拆成颜色）。
 *
 * ## 动效分三层
 *
 * - 主层：三团各走各的长周期路径，同时轮廓自己在扭 —— 谁也不跟谁同步
 * - 次层：中心的亮跟着响度胀缩，镜面高光反向轻微位移，形成视差
 * - 环境层：整个液体极慢地自转，外面那圈辉光随响度亮起
 *
 * 说话时**不改速度改幅度**：响度大了三团鼓起来、更亮更艳，
 * 而不是转得更快 —— 转速一变就成了加载动画，那是另一个意思。
 */
import { computed } from 'vue'

interface Props {
  size?: number
  /** 小尺寸语音指示器可放宽默认的 120px 下限。 */
  minimumSize?: number
  /** 鼠标X位置 (-1 到 1) */
  mouseX?: number
  /** 鼠标Y位置 (-1 到 1) */
  mouseY?: number
  /** 真实响度，0 到 1。0 就是安静地待着 */
  level?: number
  /** 这一刻是谁在说话。决定球里哪个色相占上风 */
  speaker?: 'user' | 'assistant' | 'idle'
}

const props = withDefaults(defineProps<Props>(), {
  size: 160,
  minimumSize: 120,
  mouseX: 0,
  mouseY: 0,
  level: 0,
  speaker: 'idle'
})

/**
 * 计算球体尺寸
 * 欢迎页默认最小 120px；语音指示器显式使用更小的下限。
 */
const size = computed(() => Math.max(props.minimumSize, props.size))

/**
 * 计算交互强度 (基于鼠标距离中心的距离)
 */
const hoverIntensity = computed(() => {
  const dist = Math.sqrt(props.mouseX ** 2 + props.mouseY ** 2)
  // 距离越近强度越高，最大为1
  return Math.min(1, dist * 0.8)
})

const containerStyle = computed(() => ({
  width: `${size.value}px`,
  height: `${size.value}px`,
  '--sphere-size': `${size.value}px`,
  '--mouse-x': props.mouseX,
  '--mouse-y': props.mouseY,
  '--hover-intensity': hoverIntensity.value,
  '--sphere-level': String(Math.min(1, Math.max(0, props.level)))
}))
</script>

<style scoped lang="less">
.brand-sphere {
  position: relative;
  /* 尺寸变了内部所有的模糊、位移、边缘都要跟着变，所以一律用它算 */
  --sphere-size: 120px;
  /*
   * 混合模式和不透明度跟着主题翻，见下面那段。
   * 玻璃本身的几个半透明白 / 黑住在 palette 的 --color-glass-*，那边分了深浅两套。
   */
  --glass-blend: screen;
  --glass-blob-alpha: 1;
  --halo-color: var(--color-sphere-indigo);
  cursor: pointer;
  /* 鼠标交互：根据位置产生 3D 倾斜 */
  transform: perspective(500px) rotateX(calc(var(--mouse-y) * -12deg))
    rotateY(calc(var(--mouse-x) * 12deg)) translateY(calc(var(--hover-intensity) * -4px))
    scale(calc(1 + var(--hover-intensity) * 0.02));
  /* 整体轻微浮动呼吸动画 */
  animation: sphere-breathe 6s ease-in-out infinite;
}

/*
 * 浅色主题：整块玻璃翻面。
 *
 * 磨砂白玻璃里的颜料不能再靠 screen 发光（白底上等于不叠），改成正常混合、
 * 压低不透明度，让上面那层磨砂把它们糊成「透过毛玻璃看到的颜色」。
 * 边缘的明暗方向也反过来：深色下靠顶部提亮，浅色下靠底部压暗。
 *
 * 祖先选择器**直接写**，别包 `:global(...)`：scoped 块里 Vue 处理 `:global(...)`
 * 时会把它后面的部分丢掉，编译出来是光秃秃的 `[data-theme='light']` —— 也就是
 * <html> 自己，下面这两个自定义属性会设到全局根节点上。直接写则由 scoped 给
 * 末段补 `[data-v-xxx]`，本来就只命中本组件。同一个坑见
 * `System/Preferences/panels/AIProviders/ProviderCatalogModal.vue`。
 */
[data-theme='light'] .brand-sphere {
  --glass-blend: normal;
  --glass-blob-alpha: 0.85;
}

/* 裁切圆。里面的液体要越界流动，靠它兜住 —— 越界的部分才是「装在球里」的错觉来源 */
.sphere-shell {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  background: var(--color-sphere-base);
  box-shadow: 0 calc(var(--sphere-size) * 0.07) calc(var(--sphere-size) * 0.2)
    var(--color-glass-drop);
}

/*
 * 液体：三团光的容器。
 *
 * 它自己极慢地转（40s），于是三条各自的路径叠上一个共同的漂移 ——
 * 这是「看多久都不重复」的来源。响度只改它的**大小**，不改速度。
 */
.sphere-field {
  position: absolute;
  /* 比球大一圈，转起来边缘才不会露出空白 */
  inset: -25%;
  transform: translate(calc(var(--mouse-x) * 12px), calc(var(--mouse-y) * 12px))
    scale(calc(1 + var(--sphere-level, 0) * 0.18));
  transition: transform 110ms linear;
  animation: sphere-drift 40s linear infinite;
  will-change: transform;
}

/*
 * 三团光 —— 有粘性的团块，不是光斑。
 *
 * 区别全在轮廓：径向渐变画出来的是**圆**，而圆只会读成「一团光」。
 * 这里用实色填充 + 八个各不相同、且一直在变的圆角半径，
 * 于是它有明确的边、边还会像有粘性的东西那样鼓起来又瘪下去。
 *
 * 自身只给球径 4% 的模糊：剩下的糊法交给上面那层玻璃 ——
 * 在这里糊掉的话轮廓就没了，那就退回成光斑。
 */
.sphere-blob {
  position: absolute;
  opacity: var(--glass-blob-alpha);
  filter: blur(calc(var(--sphere-size) * 0.04))
    brightness(calc(0.82 + var(--sphere-level, 0) * 0.45))
    saturate(calc(1 + var(--sphere-level, 0) * 0.5));
  /*
   * 深色下 screen：三团重叠处**加亮**而不是互相遮挡，交叠区自己长出第四种颜色。
   * 浅色下 normal：白底上 screen 是无操作，只会把三团洗成灰。
   */
  mix-blend-mode: var(--glass-blend);
  transition:
    opacity 320ms var(--easing-standard),
    filter 110ms linear;
  will-change: translate, scale, border-radius;
}

.blob-emerald {
  top: 12%;
  left: 8%;
  width: 40%;
  height: 40%;
  background: var(--color-sphere-emerald);
  border-radius: 58% 42% 47% 53% / 45% 51% 49% 55%;
  animation:
    sphere-blob-1 9s ease-in-out infinite alternate,
    sphere-morph-1 7s ease-in-out infinite;
}

.blob-azure {
  top: 28%;
  right: 8%;
  width: 38%;
  height: 38%;
  background: var(--color-sphere-azure);
  border-radius: 44% 56% 62% 38% / 55% 43% 57% 45%;
  animation:
    sphere-blob-2 13s ease-in-out infinite alternate,
    sphere-morph-2 11s ease-in-out infinite;
}

.blob-indigo {
  bottom: 8%;
  left: 26%;
  width: 42%;
  height: 38%;
  background: var(--color-sphere-indigo);
  border-radius: 51% 49% 38% 62% / 60% 46% 54% 40%;
  animation:
    sphere-blob-3 17s ease-in-out infinite alternate,
    sphere-morph-3 8s ease-in-out infinite;
}

/*
 * 中心那点亮。**响度就读这一处** —— 三团在流动，只有它是随声音走的。
 * 它在玻璃**底下**，所以会被磨砂糊开，读起来是「里面亮了一下」而不是「贴了个白点」。
 */
.sphere-core {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 34%;
  height: 34%;
  margin: -17% 0 0 -17%;
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--color-text-on-solid), transparent 70%);
  mix-blend-mode: var(--glass-blend);
  filter: blur(calc(var(--sphere-size) * 0.07));
  opacity: calc(0.05 + var(--sphere-level, 0) * 0.42);
  transform: scale(calc(0.7 + var(--sphere-level, 0) * 0.55));
  transition:
    opacity 110ms linear,
    transform 110ms linear;
  will-change: opacity, transform;
}

/*
 * 玻璃本体。
 *
 * `backdrop-filter` 是这块玻璃的全部：它真的在采样背后的东西再糊开、提彩度。
 * 自身那层很淡的白只是「玻璃也有一点点自己的颜色」，不是主角 ——
 * 主角是被它糊开的液体。
 */
.sphere-frost {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  backdrop-filter: blur(calc(var(--sphere-size) * 0.045)) saturate(1.25);
  background: linear-gradient(155deg, var(--color-glass-tint), var(--color-glass-tint-edge) 62%);
}

/*
 * 边缘折射。
 *
 * 真玻璃球最厚的地方是**边**，光在那里被压缩、被拉亮 —— 少了这一圈，
 * 中间再怎么糊都只是一块蒙着雾的平板。这一层只作用在外圈 22%：
 * 更狠的模糊 + 提亮 + 再一次提彩度，于是边缘把里面的颜色「挤」成一道亮环。
 */
.sphere-edge {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  backdrop-filter: blur(calc(var(--sphere-size) * 0.07)) brightness(1.08) saturate(1.15);
  mask: radial-gradient(closest-side, transparent 66%, currentcolor 88%);
}

/*
 * 镜面高光。
 *
 * 一道细长的白，绕着球**很慢**地转（18s）。它是「这是一块玻璃而不是一张贴纸」
 * 的唯一硬证据：平面不会有跟着视角走的高光。
 * 同时跟液体反向位移一点点，视差撑出厚度。
 */
.sphere-specular {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    var(--color-glass-top-light) 18deg,
    transparent 62deg,
    transparent 200deg,
    color-mix(in srgb, var(--color-glass-top-light) 45%, transparent) 236deg,
    transparent 280deg
  );
  /* 只留外圈那一环：高光是在玻璃的**边**上跑，不是在中间打一块白 */
  mask: radial-gradient(closest-side, transparent 58%, currentcolor 78%, currentcolor 100%);
  opacity: 0.85;
  transform: translate(calc(var(--mouse-x) * -5px), calc(var(--mouse-y) * -4px));
  animation: sphere-specular 18s linear infinite;
}

/*
 * 边缘。细边 + 顶部内高光 + 底部内阴影撑出厚度；
 * 最后两道是色散 —— 真玻璃的边总会把光拆成颜色，少了这一道就只是个圆。
 */
.sphere-rim {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow:
    inset 0 0 0 1px var(--color-glass-hairline),
    inset 0 calc(var(--sphere-size) * 0.02) calc(var(--sphere-size) * 0.06)
      var(--color-glass-top-light),
    inset 0 calc(var(--sphere-size) * -0.06) calc(var(--sphere-size) * 0.16)
      var(--color-glass-bottom-shade),
    inset calc(var(--sphere-size) * 0.012) 0 calc(var(--sphere-size) * 0.03)
      color-mix(in srgb, var(--color-sphere-azure) 30%, transparent),
    inset calc(var(--sphere-size) * -0.012) 0 calc(var(--sphere-size) * 0.03)
      color-mix(in srgb, var(--color-sphere-emerald) 26%, transparent);
}

/* 外辉光。安静时几乎看不见，说话时整个球「亮起来」 */
.sphere-halo {
  position: absolute;
  inset: -16%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--halo-color) 40%, transparent),
    transparent 70%
  );
  opacity: calc(0.1 + var(--sphere-level, 0) * 0.55);
  transition:
    opacity 260ms var(--easing-standard),
    background 320ms var(--easing-standard);
}

/* ==================== 谁在说话 ==================== */

/*
 * 不换配色，只换**谁占上风** —— 球始终是那三团，
 * 换掉整套颜色的话，用户看到的是两个不同的球，而不是同一个球在回应不同的人。
 */
.brand-sphere.speaker-user {
  --halo-color: var(--color-sphere-emerald);

  .blob-emerald {
    opacity: var(--glass-blob-alpha);
  }

  .blob-azure {
    opacity: calc(var(--glass-blob-alpha) * 0.45);
  }
}

.brand-sphere.speaker-assistant {
  --halo-color: var(--color-sphere-azure);

  .blob-azure {
    opacity: var(--glass-blob-alpha);
  }

  .blob-emerald {
    opacity: calc(var(--glass-blob-alpha) * 0.5);
  }
}

/* 动画定义 */

@keyframes sphere-breathe {
  0%,
  100% {
    transform: perspective(500px) rotateX(calc(var(--mouse-y) * -12deg))
      rotateY(calc(var(--mouse-x) * 12deg)) translateY(0);
  }

  50% {
    transform: perspective(500px) rotateX(calc(var(--mouse-y) * -12deg))
      rotateY(calc(var(--mouse-x) * 12deg)) translateY(-4px);
  }
}

/* 液体自转。linear 是对的 —— 匀速漂移不该有起止感 */
@keyframes sphere-drift {
  to {
    rotate: 360deg;
  }
}

/* 镜面高光绕边跑。比液体快一倍多，两者不同步才像「光在表面、液体在里面」 */
@keyframes sphere-specular {
  to {
    rotate: 360deg;
  }
}

/*
 * 三条路径都是弧线（先横后纵，不走直线），周期互质，
 * 所以任何两团都不会长期保持同一相对位置。
 *
 * 响度写进每个关键帧的 scale 里：声音一大三团就同时鼓起来往外挤，
 * 而**路径和速度不变** —— 变速的话读起来是加载动画，不是在说话。
 */
@keyframes sphere-blob-1 {
  0% {
    translate: 0 0;
    scale: calc(1 + var(--sphere-level, 0) * 0.16);
    rotate: 0deg;
  }

  50% {
    translate: 16% 10%;
    scale: calc(1.16 + var(--sphere-level, 0) * 0.16);
    rotate: 14deg;
  }

  100% {
    translate: -8% 18%;
    scale: calc(0.9 + var(--sphere-level, 0) * 0.16);
    rotate: -10deg;
  }
}

@keyframes sphere-blob-2 {
  0% {
    translate: 0 0;
    scale: calc(1 + var(--sphere-level, 0) * 0.16);
    rotate: 0deg;
  }

  50% {
    translate: -14% 14%;
    scale: calc(1.2 + var(--sphere-level, 0) * 0.16);
    rotate: -18deg;
  }

  100% {
    translate: 10% -10%;
    scale: calc(0.94 + var(--sphere-level, 0) * 0.16);
    rotate: 12deg;
  }
}

@keyframes sphere-blob-3 {
  0% {
    translate: 0 0;
    scale: calc(1 + var(--sphere-level, 0) * 0.16);
    rotate: 0deg;
  }

  50% {
    translate: 10% -14%;
    scale: calc(1.08 + var(--sphere-level, 0) * 0.16);
    rotate: 10deg;
  }

  100% {
    translate: -18% 0;
    scale: calc(0.92 + var(--sphere-level, 0) * 0.16);
    rotate: -14deg;
  }
}

/*
 * 轮廓自己的扭动。跟路径分开成两条动画、周期也不同 ——
 * 合在一条里的话「往哪走」和「鼓成什么样」会同步，看起来就是一块硬的东西在飘。
 * 八个半径分两组反相：一边鼓起来另一边就瘪下去，那是粘稠物的体积守恒感。
 */
@keyframes sphere-morph-1 {
  0%,
  100% {
    border-radius: 58% 42% 47% 53% / 45% 51% 49% 55%;
  }

  33% {
    border-radius: 40% 60% 65% 35% / 62% 38% 62% 38%;
  }

  66% {
    border-radius: 66% 34% 38% 62% / 40% 64% 36% 60%;
  }
}

@keyframes sphere-morph-2 {
  0%,
  100% {
    border-radius: 44% 56% 62% 38% / 55% 43% 57% 45%;
  }

  40% {
    border-radius: 63% 37% 36% 64% / 38% 62% 38% 62%;
  }

  70% {
    border-radius: 35% 65% 58% 42% / 64% 40% 60% 36%;
  }
}

@keyframes sphere-morph-3 {
  0%,
  100% {
    border-radius: 51% 49% 38% 62% / 60% 46% 54% 40%;
  }

  35% {
    border-radius: 64% 36% 57% 43% / 36% 61% 39% 64%;
  }

  75% {
    border-radius: 38% 62% 44% 56% / 57% 35% 65% 43%;
  }
}

/*
 * 「减少动态效果」：液体不再流动，但球还是那块玻璃，中心仍然跟着响度亮 ——
 * 亮度差本身就够读出「有没有人在说话」，不需要动。
 */
@media (prefers-reduced-motion: reduce) {
  .brand-sphere,
  .sphere-field,
  .sphere-blob,
  .sphere-specular {
    animation: none;
  }

  .sphere-field {
    transition: none;
    transform: none;
  }
}
</style>

/**
 * AI 游戏工作室题库。
 *
 * 题面刻意只有一句话：不给参考图、不给玩法、不给范围。补全空白本身就是考点。
 * 一半「类似某作」、一半只报题材 —— 前者考它能不能从一个名字里抽出玩法，
 * 后者考它能不能自己拿主意。
 *
 * `hint` 只给评分的人看，**不进题面**：它是「这类游戏常见的核心循环」，
 * 用来帮评分人快速对上号，不是标准答案。模型自己立项的玩法和这里不一样
 * 完全没问题，按它自己立的那套评。
 *
 * 开跑之后题面不许改 —— 改了前后两批就不可比。要换题就加新 id。
 * 评分标准见 docs/AI游戏工作室-题库与评分表.md。
 */

export const CASES = [
  {
    id: 'platformer-3d',
    genre: '3D 平台跳跃',
    form: '类比',
    prompt: '做一个类似《超级马里奥奥德赛》的 3D 平台跳跃游戏',
    hint: '跑跳探索 → 收集目标物 → 抵达终点或集齐过关；手感（跳跃、相机）是成败关键'
  },
  {
    id: 'roguelike-topdown',
    genre: '俯视角 Roguelike',
    form: '题材',
    prompt: '做一个俯视角的 Roguelike 射击游戏',
    hint: '进房间清怪 → 拿强化 → 下一层；死亡后重开，每局有随机性'
  },
  {
    id: 'tower-defense',
    genre: '塔防',
    form: '题材',
    prompt: '做一个塔防游戏',
    hint: '敌人按波次沿路线进攻 → 花资源建塔/升级 → 守住或基地被破'
  },
  {
    id: 'kart-racing',
    genre: '赛车',
    form: '类比',
    prompt: '做一个类似《跑跑卡丁车》的赛车游戏',
    hint: '起跑 → 跑完若干圈 → 按名次或计时结算；有对手或计时压力'
  },
  {
    id: 'puzzle-fp',
    genre: '第一人称解谜',
    form: '类比',
    prompt: '做一个类似《传送门》的第一人称解谜游戏',
    hint: '观察房间 → 用核心机制解开机关 → 出口开启进入下一关'
  },
  {
    id: 'horror-explore',
    genre: '恐怖探索',
    form: '题材',
    prompt: '做一个恐怖探索游戏',
    hint: '在暗环境里探索 → 找钥匙/线索 → 躲避或逃离威胁 → 逃出或被抓'
  },
  {
    id: 'management-sim',
    genre: '模拟经营',
    form: '题材',
    prompt: '做一个模拟经营游戏',
    hint: '投入资源 → 经营产出 → 扩张升级；有目标（赚到多少钱/撑过多少天）和失败条件'
  },
  {
    id: 'survivor-like',
    genre: '割草生存',
    form: '类比',
    prompt: '做一个类似《吸血鬼幸存者》的 3D 割草游戏',
    hint: '自动攻击 → 敌潮越来越密 → 升级选技能 → 撑到时间或死亡'
  }
]

export function findCase(id) {
  return CASES.find((c) => c.id === id)
}

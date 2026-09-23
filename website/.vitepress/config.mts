import { defineConfig } from 'vitepress'

/**
 * 虚幻盒子文档站。
 *
 * 范围限定为面向使用者的内容：安装、各功能的用法、故障排查。
 *
 * 仓库根目录的 `docs/` 是内部设计稿与评审档案，其中部分文档描述的功能已变更或下线。
 * 两边不互相搬运 —— 设计稿进站会让用户检索到不存在的功能。
 *
 * 站点不接外部服务：搜索用 VitePress 自带的本地索引（构建期生成静态 JSON），
 * 没有 Algolia、统计或 CDN 字体。
 */

/**
 * 中文分词器。
 *
 * MiniSearch（VitePress 本地搜索的底子）默认按空白和标点切词，对中文等于没切：
 * 「助手看不到引擎里的内容」整句变成一个 token。它只做前缀匹配，而「引擎」不是
 * 那一整句的前缀 —— 于是一个中文手册的搜索框搜什么都是「没有找到」。
 *
 * 这里改用 Intl.Segmenter 按词切。英文和 `UnrealAgentLink` 这类标识符不受影响，
 * Segmenter 会把它们当成一个词整体保留。
 *
 * 两条约束，改之前先看清楚：
 *   1. 这个函数会被 VitePress 序列化成字符串（toString）发到浏览器端，用来切用户
 *      输入的查询词。**函数体里不能引用任何外部变量**，否则运行期报未定义。
 *   2. 构建期（切文档建索引）和运行期（切查询词）跑的是同一份代码，天然不会只改一边。
 *
 * Intl.Segmenter 在 Chrome 87+ / Safari 14.1+ / Firefox 125+ 可用。更老的浏览器走
 * 兜底：汉字逐字切，其余按非字母数字切 —— 比整句一个 token 强得多。
 */
function tokenize(text: string): string[] {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return text
      .replace(/(\p{Script=Han})/gu, ' $1 ')
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
  }
  const out: string[] = []
  for (const piece of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)) {
    if (piece.isWordLike) out.push(piece.segment)
  }
  return out
}

export default defineConfig({
  title: '虚幻盒子',
  description: '虚幻引擎的 agent harness —— 使用手册',
  lang: 'zh-CN',
  // 和官网同一个域：nginx 把 /guide/ /develop/ /assets/ /shots/ 这几条路由到本站产物，
  // 其余交给 uebox.ai 的官网（Astro）。所以 base 是 `/` 而不是 `/guide/` ——
  // 手册里所有内链都是 `/guide/xxx` 这种从根算起的绝对路径。
  // 换成子路径部署要连带改那几十条链接，别只改这一行
  base: '/',
  // 死链就让构建红 —— 手册里所有内链都指向本站已存在的页面，
  // 外链（GitHub 仓库那些）VitePress 本来就不检查。
  // 注意它也**不检查 `#锚点`** —— 只查页面在不在（拿一条假锚点构建过，照样绿）。
  // 手册里有十几条跨页锚点，改标题时要自己回头核一遍
  ignoreDeadLinks: false,
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ['meta', { name: 'color-scheme', content: 'light dark' }],
    // 和应用同一套图标（build/icon*.svg 的副本）。两份按浏览器主题切，
    // 深色标签栏上用浅底那张会糊成一块白
    [
      'link',
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/icon.svg',
        media: '(prefers-color-scheme: light)'
      }
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/icon-dark.svg',
        media: '(prefers-color-scheme: dark)'
      }
    ]
  ],

  themeConfig: {
    logo: { light: '/icon.svg', dark: '/icon-dark.svg', alt: '虚幻盒子' },

    // 左上角的 logo 和站名默认指向 `/`。同域部署之后 `/` 是官网首页，不是本站的 ——
    // 但 VitePress 是单页应用，它会拦下这次跳转，**在前端自己画出本站的 index.md**：
    // 地址栏显示 uebox.ai，内容却是文档站的首页，刷新一下又变成官网。两张首页打架。
    // 指到手册首页，把 `/` 整个让给官网
    logoLink: '/guide/',

    // 同理：默认的 404 页有个「回首页」按钮也指向 `/`
    notFound: { link: '/guide/', linkText: '回到使用手册' },

    outline: { level: [2, 3], label: '本页内容' },

    nav: [
      { text: '使用手册', link: '/guide/', activeMatch: '/guide/' },
      { text: '给开发者', link: '/develop/', activeMatch: '/develop/' },
      // 这里是**文档站**，不是官网。卖点、下载页那些归 uebox.ai，
      // 这两条是回程入口 —— 没有它们，用户从文档回不到产品页。
      // 下载指官网的下载区（那里的按钮走 /dl/win 这类固定地址，换存储后端不用改这里），
      // 不再直指 Releases
      { text: '下载', link: 'https://uebox.ai/#download' },
      { text: '官网', link: 'https://uebox.ai' }
      // 「源码」不进 nav：右边本来就有 GitHub 图标，同一个地址摆两遍是噪声
    ],

    sidebar: {
      '/guide/': [
        {
          text: '开始',
          items: [
            { text: '虚幻盒子是什么', link: '/guide/' },
            { text: '安装与更新', link: '/guide/install' },
            { text: '第一次打开', link: '/guide/first-run' },
            { text: '界面导览', link: '/guide/interface' }
          ]
        },
        {
          // 产品的主体是 Agent，其余模块是支撑它的。侧边栏的顺序要反映这件事：
          // AI 那一组排在最前，别让它看起来像并列的第三块功能。
          // 装机顺序（先配模型还是先导工程）由「第一次打开」那一页负责讲
          text: 'AI Agent',
          items: [
            { text: '配置模型', link: '/guide/ai-setup' },
            { text: 'AI 会话', link: '/guide/assistant' },
            // 「它会干什么」「它怎么干」「怎么管住它」是三个问题，分三页。
            // 合成一页的话，想找“能不能帮我摆场景”的人得先翻过三屏权限说明
            { text: '助手能做什么', link: '/guide/capabilities' },
            { text: '助手是怎么干活的', link: '/guide/agent-loop' },
            { text: '工具、技能与权限', link: '/guide/tools-and-skills' },
            { text: '快捷提问（Spotlight）', link: '/guide/spotlight' },
            { text: '语音通话', link: '/guide/voice' }
          ]
        },
        {
          // harness 与引擎之间的接线
          text: '接上虚幻引擎',
          items: [
            { text: '项目库', link: '/guide/projects' },
            { text: '连接虚幻引擎', link: '/guide/plugin' }
          ]
        },
        {
          // 资产库的功能面比其他几个库大一个量级（保管库、标签、依赖、协作、
          // 网盘）。塞进一页就是一篇两万字的长文，谁都读不完 —— 按「做什么」拆开
          text: '素材来源：资产库',
          items: [
            { text: '入门与保管库', link: '/guide/asset-library' },
            { text: '检索与整理', link: '/guide/asset-organize' },
            { text: '导入到 UE 工程', link: '/guide/asset-to-project' },
            { text: '团队协作', link: '/guide/asset-team' },
            { text: '资产节点管理', link: '/guide/asset-server' },
            { text: '百度网盘与 WebDAV', link: '/guide/cloud-drive' }
          ]
        },
        {
          text: '片段与资料',
          items: [
            { text: '蓝图库与材质库', link: '/guide/snippets' },
            { text: '笔记与知识库', link: '/guide/notebook' }
          ]
        },
        {
          text: '创作工具',
          items: [
            { text: 'AI 创作（生图）', link: '/guide/aigc' },
            { text: '3D 生成与查看器', link: '/guide/model3d' },
            { text: '录屏与截图', link: '/guide/small-tools' }
          ]
        },
        {
          // 命令行和 MCP 服务的是搭自动化流程、接第三方 Agent 的人，
          // 跟“AI 创作”“录屏”这类给普通用户用的便利功能不是一类需求，
          // 单独成组，别再混进“其他工具”
          text: '扩展与集成',
          items: [
            { text: '命令行 uebox', link: '/guide/cli' },
            { text: 'MCP', link: '/guide/mcp' }
          ]
        },
        {
          text: '参考',
          items: [
            { text: '设置速查', link: '/guide/settings' },
            { text: '对象存储', link: '/guide/object-storage' },
            { text: '快捷键', link: '/guide/shortcuts' },
            { text: '出问题了', link: '/guide/troubleshooting' },
            { text: '文件都放在哪', link: '/guide/where-is-my-data' }
          ]
        }
      ],
      '/develop/': [
        {
          text: '给开发者',
          items: [
            { text: '从这里开始', link: '/develop/' },
            { text: '用 AI 加功能', link: '/develop/with-ai' },
            { text: '架构与验收门禁', link: '/develop/architecture' }
          ]
        }
      ]
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/ueboxai/uebox' }],

    editLink: {
      pattern: 'https://github.com/ueboxai/uebox/edit/main/website/:path',
      text: '在 GitHub 上修改这一页'
    },

    footer: {
      message: '应用 Apache-2.0 · UnrealAgentLink 插件 MIT',
      copyright: '虚幻盒子'
    },

    search: {
      provider: 'local',
      options: {
        // 直接展开每条结果的正文片段。手册里一个词常出现在好几页，
        // 只看标题分不出该点哪条
        detailedView: true,
        miniSearch: {
          options: { tokenize },
          searchOptions: {
            // 分词之后一句查询会变成好几个词。默认的 OR 会把只沾上一个词的页面
            // 全捞进来 —— 二十多页的手册里等于没筛。改成 AND：词都命中才算
            combineWith: 'AND',
            // 中文词普遍只有两三个字，模糊匹配在这个长度上只会引入噪声
            fuzzy: false,
            prefix: true,
            boost: { title: 4, text: 2, titles: 1 }
          }
        },
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到',
                resetButtonTitle: '清除',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
              }
            }
          }
        }
      }
    },

    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    lastUpdated: { text: '最后更新' }
  }
})

import { describe, expect, it } from 'vitest'

import {
  assertCommandAllowed,
  assertPathAllowed,
  assertScriptAllowed,
  __testing
} from './pathBoundary'

const { isDenied, normalizeCommand } = __testing

/**
 * 读盘是这一版新增的暴露面 —— 在这之前 agent 完全碰不到本地文件。
 * 挡的不是用户，是**被注入的提示词**诱导 agent 去读凭据再回传。
 */
describe('敏感位置拦截（按路径）', () => {
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/ai-provider-secrets.bin',
    'C:\\Users\\me\\.ssh\\id_rsa',
    'C:/Users/me/.aws/credentials',
    'C:/Users/me/AppData/Local/Google/Chrome/User Data/Default/Login Data'
  ])('挡下 %s', (p) => expect(isDenied(p)).toBe(true))

  // 斜杠方向和大小写都不该成为绕过手段
  it('正斜杠、反斜杠、大小写都认', () => {
    expect(isDenied('C:\\Users\\Me\\AppData\\Roaming\\Unreal-Box\\x')).toBe(true)
    expect(isDenied('c:/users/me/appdata/roaming/unreal-box/x')).toBe(true)
  })

  it.each([
    'D:/素材/建筑/wall.fbx',
    'I:/UnrealAgent/UALinkDev55/Saved/Logs/UALinkDev55.log',
    'C:/Users/me/Desktop/ref.png'
  ])('放行 %s', (p) => expect(isDenied(p)).toBe(false))

  /**
   * 这份清单原先只有 Windows 路径，而仓库里有 build:mac / build:linux。
   * 也就是说在 mac 和 Linux 上「防提示词注入去读凭据」这层完全没生效。
   */
  it.each([
    '/Users/me/Library/Application Support/Google/Chrome/Default/Login Data',
    '/Users/me/Library/Application Support/unreal-box/ai-provider-secrets.bin',
    '/Users/me/Library/Keychains/login.keychain-db',
    '/Users/me/.config/gcloud/credentials.db',
    '/home/me/.config/google-chrome/Default/Cookies',
    '/home/me/.local/share/keyrings/login.keyring',
    '/home/me/.docker/config.json',
    '/home/me/.git-credentials'
  ])('mac / Linux 上的凭据位置同样挡住：%s', (p) => expect(isDenied(p)).toBe(true))

  it.each([
    '/Users/me/Documents/refs/wall.png',
    '/home/me/projects/MyGame/Content/Meshes/wall.fbx'
  ])('mac / Linux 上的普通路径照常放行：%s', (p) => expect(isDenied(p)).toBe(false))

  it('允许时返回 undefined，挡住时返回给模型看的说明', () => {
    expect(assertPathAllowed('D:/素材/wall.fbx')).toBeUndefined()
    expect(assertPathAllowed('C:/Users/me/.ssh/id_rsa')).toMatch(/不允许访问/)
  })
})

/**
 * userData 整个是拒绝的，`skills/` 是两个口子之一 —— 用户自己的 skill 就存在那儿
 * （`capabilities/skills.ts` 的搜索路径第一位）。不开这个口子，
 * `ue-skill-creator` 写不进去，还会照着「换一个目录」的提示把 skill
 * 写到一个永远不会被加载的地方。
 */
describe('userData 里的 skills 例外', () => {
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/skills',
    'C:/Users/me/AppData/Roaming/unreal-box/skills/my-skill/SKILL.md',
    'C:\\Users\\me\\AppData\\Roaming\\unreal-box\\skills\\my-skill\\references\\wiring.md',
    '/Users/me/Library/Application Support/unreal-box/skills/my-skill/SKILL.md',
    '/home/me/.config/unreal-box/skills/my-skill/scripts/check.py'
  ])('放行 %s', (p) => expect(isDenied(p)).toBe(false))

  /**
   * 例外是按子串匹配的，而 `…/skills/../ai-provider-secrets.bin` 这个**字符串**
   * 含有 `/unreal-box/skills/`。不先把 `..` 折叠掉，这个口子会亲手把密钥放出去。
   */
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/skills/../ai-provider-secrets.bin',
    'C:\\Users\\me\\AppData\\Roaming\\unreal-box\\skills\\..\\chat-history\\db.sqlite',
    'C:/Users/me/AppData/Roaming/unreal-box/skills/x/../../agent-v3-sessions/s.jsonl'
  ])('`..` 跳出 skills 之后照样挡住：%s', (p) => expect(isDenied(p)).toBe(true))

  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/ai-provider-secrets.bin',
    'C:/Users/me/AppData/Roaming/unreal-box/app-settings.json',
    // 前缀撞上不算 —— 例外认的是 `skills/` 这一整段
    'C:/Users/me/AppData/Roaming/unreal-box/skills-backup/secrets.txt'
  ])('userData 里的其余位置一律照旧挡住：%s', (p) => expect(isDenied(p)).toBe(true))

  /**
   * `team/` 是工作室模式的共享工作区（见 `core/team/teamStore.ts`）。
   * 盒子自己的团队账（名册、任务板、队员对话）在 `agent-v3-sessions/<会话>.team/`，照旧挡着。
   */
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/team/abc/立项书.md',
    '/Users/me/Library/Application Support/unreal-box/team/abc/art/ref.png'
  ])('放行团队工作区：%s', (p) => expect(isDenied(p)).toBe(false))

  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/agent-v3-sessions/abc.team/roster.json',
    'C:/Users/me/AppData/Roaming/unreal-box/team/../ai-provider-secrets.bin',
    'C:/Users/me/AppData/Roaming/unreal-box/teams/x.txt'
  ])('团队工作区以外照旧挡住：%s', (p) => expect(isDenied(p)).toBe(true))

  // 例外只解除 userData 那三条，不解除别的 —— 否则在 skills 下摆一个
  // `.ssh` 目录就能把整份清单绕过去
  it('例外不为别的规则开门', () => {
    expect(isDenied('C:/Users/me/AppData/Roaming/unreal-box/skills/x/.ssh/id_rsa')).toBe(true)
  })

  // 命令和 Python 那两条路没有例外：写 skill 用 write_local_file 就够了
  it('命令和脚本里提到 skills 目录仍然拒绝', () => {
    expect(
      assertCommandAllowed('cat ~/AppData/Roaming/unreal-box/skills/my-skill/SKILL.md')
    ).toBeDefined()
    expect(
      assertScriptAllowed("open('C:/Users/me/AppData/Roaming/unreal-box/skills/x/SKILL.md')")
    ).toBeDefined()
  })
})

/**
 * 保管库 —— 用户全部素材的原始文件 —— 物理上就住在 userData 里
 * （`VaultManager` 拼的 `<userData>/database/vaults/<库id>/`）。
 * 大圈一画，它跟着一起进了禁区：真机上按文件名找一个素材会被回一句
 * 「这个位置存放的是凭据、密钥或浏览器数据」，而那只是用户自己的素材库。
 */
describe('userData 里的保管库例外', () => {
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/database/vaults',
    'C:/Users/me/AppData/Roaming/unreal-box/database/vaults/system_vault_aigc',
    'C:/Users/me/AppData/Roaming/unreal-box/database/vaults/system_vault_aigc/AIGC/模型/ToonHead.fbx',
    'C:\\Users\\me\\AppData\\Roaming\\unreal-box\\database\\vaults\\system_vault_default\\assetData\\1788181471964\\a.png',
    '/Users/me/Library/Application Support/unreal-box/database/vaults/system_vault_default/assetData/x.fbx',
    '/home/me/.config/unreal-box/database/vaults/system_vault_aigc/thumbnails/t.webp'
  ])('放行 %s', (p) => expect(isDenied(p)).toBe(false))

  /**
   * 开的是 `vaults/`，不是 `database/` 整层 —— 公共库和备份还在禁区里。
   * 前缀撞上也不算：例外认的是 `database/vaults/` 这一整段。
   */
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/database/app-data.db',
    'C:/Users/me/AppData/Roaming/unreal-box/database/backups/app-data.2026.db',
    'C:/Users/me/AppData/Roaming/unreal-box/database/vaults-old/secrets.txt',
    'C:/Users/me/AppData/Roaming/unreal-box/network-credentials/keys.json'
  ])('database 下的其余位置照旧挡住：%s', (p) => expect(isDenied(p)).toBe(true))

  // 和 skills 一样：例外按子串匹配，`..` 不折叠的话这个口子会亲手把密钥放出去
  it.each([
    'C:/Users/me/AppData/Roaming/unreal-box/database/vaults/../../ai-provider-secrets.bin',
    'C:\\Users\\me\\AppData\\Roaming\\unreal-box\\database\\vaults\\x\\..\\..\\app-data.db'
  ])('`..` 跳出保管库之后照样挡住：%s', (p) => expect(isDenied(p)).toBe(true))

  it('例外不为别的规则开门', () => {
    expect(isDenied('C:/Users/me/AppData/Roaming/unreal-box/database/vaults/v1/.ssh/id_rsa')).toBe(
      true
    )
  })

  it('命令和脚本允许处理保管库素材', () => {
    expect(
      assertCommandAllowed('ls ~/AppData/Roaming/unreal-box/database/vaults/system_vault_aigc')
    ).toBeUndefined()
    expect(
      assertScriptAllowed(
        "open('C:/Users/me/AppData/Roaming/unreal-box/database/vaults/v1/assetData/x.png','rb')"
      )
    ).toBeUndefined()
  })

  it.each([
    String.raw`cd "C:\Users\me\AppData\Roaming\unreal-box\database\vaults\system_vault_aigc\AIGC\图片" && python -c "from PIL import Image; im = Image.open('SteakKing_Boss_36frames_6x6.png'); print(im.size, im.mode)"`,
    'ls "C:/Users/My Name/AppData/Roaming/Unreal-Box/database/vaults"',
    'ls "/Users/me/Library/Application Support/unreal-box/database/vaults/v1/a.png"',
    // mac 上最常见的写法是转义空格而不是加引号。`\ ` 不先还原成空格的话，
    // 例外匹配不上，然后归一化又把它拼回 userData 前缀 —— 素材库例外在 mac 上
    // 等于没做（拒绝，不是放行，但功能一样用不了）
    String.raw`ls /Users/me/Library/Application\ Support/unreal-box/database/vaults/v1/a.png`,
    'ls /home/me/.config/unreal-box/database/vaults/v1/a.png',
    'cp ~/AppData/Roaming/unreal-box/database/vaults/a.png ~/AppData/Roaming/unreal-box/database/vaults/b.png'
  ])('素材处理命令放行：%s', (source) => {
    expect(assertCommandAllowed(source)).toBeUndefined()
    expect(assertScriptAllowed(source)).toBeUndefined()
  })

  /**
   * 2026-09-26 真机反馈：队员把脚本写进团队工作区再用 powershell -File 去跑，
   * 被当成凭据位置拒掉。工作区是团队自己写的文档和脚本，命令里也要放行。
   */
  it.each([
    String.raw`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\me\AppData\Roaming\unreal-box\team\abc\clear_ro.ps1"`,
    'cat ~/AppData/Roaming/unreal-box/team/abc/GDD.md'
  ])('团队工作区的命令放行：%s', (source) => {
    expect(assertCommandAllowed(source)).toBeUndefined()
  })

  it.each([
    'cat ~/AppData/Roaming/unreal-box/team/../ai-provider-secrets.bin',
    'cat ~/AppData/Roaming/unreal-box/teams/x.txt',
    'cat ~/AppData/Roaming/unreal-box/agent-v3-sessions/abc.team/roster.json'
  ])('团队工作区以外照旧挡住：%s', (source) => {
    expect(assertCommandAllowed(source)).toBeDefined()
  })

  it.each([
    'cat ~/AppData/Roaming/unreal-box/ai-provider-secrets.bin',
    'cat ~/AppData/Roaming/unreal-box/database/app-data.db',
    'cat ~/.ssh/id_rsa',
    'cat ~/AppData/Roaming/unreal-box/database/vaults/v1/.aws/credentials',
    'cat ~/AppData/Roaming/unreal-box/database/vaults-old/a.png',
    'cat ~/AppData/Roaming/unreal-box/database/vaults中文/a.png',
    'cat ~/AppData/Roaming/unreal-box/database/vaults.old/a.png',
    'cat ~/AppData/Roaming/unreal-box/database/vaults/../../ai-provider-secrets.bin',
    'cat ../../app-data.db'
  ])('素材库例外不放行同一命令中的敏感位置或父目录跳转：%s', (operation) => {
    const source = `cd ~/AppData/Roaming/unreal-box/database/vaults/v1 && ${operation}`
    expect(assertCommandAllowed(source)).toBeDefined()
    expect(assertScriptAllowed(source)).toBeDefined()
  })
})

/**
 * 命令这一路原先完全没有边界 —— 写文件那边锁着的门，
 * `run_shell_command('cat ~/.ssh/id_rsa')` 从旁边走过去就是了。
 *
 * 下面每一条都是「同一个位置，换成命令行的写法」。
 */
describe('敏感位置拦截（按命令）', () => {
  it.each([
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.aws/credentials',
    'cat "$HOME/.aws/credentials"',
    'type %USERPROFILE%\\.ssh\\id_rsa',
    'cp ~/.gnupg/secring.gpg /tmp/x',
    'cat ~/.git-credentials',
    'grep -r . ~/.config/gcloud'
  ])('挡下 %s', (c) => expect(assertCommandAllowed(c)).toBeDefined())

  /**
   * token 的开头也算路径边界。`cd ~` 之后的相对路径前面没有斜杠，
   * 不把空格当成边界的话这一整类写法全漏。
   */
  it('先 cd 再用相对路径也挡得住', () => {
    expect(assertCommandAllowed('cd ~ && cat .ssh/id_rsa')).toBeDefined()
    expect(assertCommandAllowed('cd $HOME; cat .netrc')).toBeDefined()
  })

  // 引号插在路径中间不该成为绕过手段
  it('引号插在路径中间也挡得住', () => {
    expect(assertCommandAllowed('cat ~/".ssh"/id_rsa')).toBeDefined()
    expect(assertCommandAllowed("cat '~/.ssh/id_rsa'")).toBeDefined()
  })

  /**
   * 清单里有三条带空格（`…/Chrome/User Data`、`…/Application Support/…`），
   * 而命令归一化会把空格换成 `/`。两边不同步做这一下，恰恰是浏览器登录态和
   * mac 密钥库这几条永远匹配不上 —— 而它们正是最该挡的。
   */
  it('带空格的位置在命令里同样挡得住', () => {
    expect(
      assertCommandAllowed('ls "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"')
    ).toBeDefined()
    expect(
      assertCommandAllowed('cp ~/Library/Application\\ Support/Google/Chrome/Default/Cookies /tmp')
    ).toBeDefined()
  })

  it.each([
    'git status',
    'git log --oneline -20',
    'npm run build',
    'ls -la /d/素材/建筑',
    'ls -d "/c/Program Files/Epic Games/UE_5.4"',
    './Engine/Build/BatchFiles/Build.bat MyGameEditor Win64 Development'
  ])('正常命令照常放行：%s', (c) => expect(assertCommandAllowed(c)).toBeUndefined())

  // 挡命令时不能复用挡路径那句话（那句在说「换个目录」），
  // 否则模型会去改写路径，一次次撞在同一堵墙上
  it('拒绝的话是对着命令说的，并且明说别改写重试', () => {
    const said = assertCommandAllowed('cat ~/.ssh/id_rsa')!
    expect(said).toMatch(/命令/)
    expect(said).toMatch(/不要改写路径再试/)
  })
})

/**
 * `ue_run_python_script` 跑在 UE 进程里，容易被当成「引擎内部的事」——
 * 但 UE 的 Python 有完整的 `open()`，本地文件工具那边挡着的目录，
 * 从这里读一样读得到。边界漏一个出口就不成其为边界。
 */
describe('敏感位置拦截（按 Python 脚本）', () => {
  it.each([
    "open(os.path.expanduser('~/.ssh/id_rsa')).read()",
    "with open('C:/Users/me/.aws/credentials') as f: print(f.read())",
    "import shutil; shutil.copy('~/.git-credentials', '/tmp/x')"
  ])('挡下 %s', (s) => expect(assertScriptAllowed(s)).toBeDefined())

  // 正常的引擎脚本不能被误伤 —— UE 工程里 Config/ 目录到处都是
  it.each([
    'import unreal; unreal.log("hello")',
    'unreal.EditorAssetLibrary.list_assets("/Game/Maps")',
    'output_data = {"count": len(unreal.EditorUtilityLibrary.get_selected_assets())}',
    'print(open("D:/MyGame/Config/DefaultEngine.ini").read())'
  ])('正常引擎脚本照常放行：%s', (s) => expect(assertScriptAllowed(s)).toBeUndefined())

  // 说的是「脚本」不是「命令」，否则模型会以为是别的工具被挡了
  it('拒绝的话是对着脚本说的', () => {
    expect(assertScriptAllowed("open('~/.ssh/id_rsa')")).toMatch(/脚本/)
  })
})

/**
 * 这是**特征匹配，不是沙箱**。下面两条固化的是「已知挡不住」，
 * 不是缺陷 —— 写在这里是为了别有人把它当成「跑命令是安全的」的依据。
 * 真正的兜底是审批门；这层只挡直白写出路径的那一种形态。
 */
describe('已知的边界（故意不挡）', () => {
  it('编码绕过挡不住', () => {
    expect(assertCommandAllowed('cat $(echo fi5zc2gvaWRfcnNh | base64 -d)')).toBeUndefined()
  })

  it('变量拼接挡不住', () => {
    expect(assertCommandAllowed('S=ssh; cat ~/.$S/id_rsa')).toBeUndefined()
  })

  /**
   * 反过来的代价：宁可误挡。命令里**提到**敏感位置就够了，
   * 哪怕只是写在提交信息里。这个方向的错是可以接受的 ——
   * 误挡一次模型换条路走，漏放一次是用户的私钥进了上下文。
   */
  it('宁可误挡 —— 只是提到也会被拦', () => {
    expect(assertCommandAllowed('git commit -m "fix .netrc parsing"')).toBeDefined()
  })

  // 但别误挡得太离谱：只是前缀撞上不算（`.awesome` 不含 `.aws`）
  it('前缀相近的普通目录照常放行', () => {
    expect(assertCommandAllowed('ls ~/.awesome-project')).toBeUndefined()
  })
})

describe('命令归一化', () => {
  it('反斜杠、大小写、连续分隔符都抹平', () => {
    expect(normalizeCommand('CAT   C:\\Users\\Me\\file.txt')).toBe('cat/c:/users/me/file.txt')
  })

  it('路径里不可能出现的字符一律变成分隔符', () => {
    expect(normalizeCommand('a|b;c(d)')).toBe('a/b/c/d/')
  })
})

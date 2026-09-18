import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('realtime voice session ownership', () => {
  const welcome = read('src/renderer/src/views/Assistant/Welcome.vue')
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')
  const assistant = read('src/renderer/src/views/Assistant/composables/voiceAssistant.ts')
  const realtime = read('src/renderer/src/views/Assistant/composables/useRealtimeVoice.ts')
  const zhLocale = read('src/renderer/src/i18n/locales/zh-CN.ts')
  const enLocale = read('src/renderer/src/i18n/locales/en-US.ts')
  const localStorageBaseline = read('scripts/local-storage.baseline.json')

  /*
   * 每条对话是一个独立的 keep-alive 页面实例。语音挂在页面上的话，
   * 切到「语音任务」看一眼过程，新页面的语音是空的、旧页面被换掉时还关麦克风。
   * 所以那一路是应用级的，页面只是宿主。
   */
  it('语音是应用级的一路，页面只登记为宿主，切会话不断线', () => {
    expect(welcome).toContain('const voice = useVoiceAssistant()')
    expect(welcome).toContain('attachVoiceHost(voiceHost)')
    expect(welcome).not.toContain('useRealtimeVoice(')
    expect(composer).not.toContain('useRealtimeVoice(')
    expect(assistant).toContain('shared = useRealtimeVoice({')
    // 组件销毁不挂断：那条 onBeforeUnmount 正是「切一下会话语音就没了」的成因
    expect(realtime).not.toContain('onBeforeUnmount(')
    expect(welcome.match(/:voice="voice"/g)).toHaveLength(2)
  })

  it('连接成功后继续使用普通对话列表和底部输入框', () => {
    expect(welcome).toContain('const conversationMode = computed(')
    expect(welcome).toContain('v-if="conversationMode" ref="chatContainerRef"')
    expect(welcome.match(/@send="handleComposerSend"/g)).toHaveLength(2)
    expect(composer).not.toContain('class="voice-session"')
  })

  it('只有正对着这次通话绑的那条对话时，打的字才交给语音；别处打字仍是普通发送', () => {
    expect(welcome).toContain('voice.active.value && plainTextOnly && sid.value === voiceChatSid()')
  })

  /*
   * 两个入口都必须经 `startVoiceIn` 绑定。直接 `voice.start()` 的话对白没有去处，
   * 而在某条对话里点麦克风本来就是想接着眼前这段上下文往下聊。
   */
  it('球体和麦克风都绑住眼前这条对话，没有固定的「语音助手」会话了', () => {
    expect(welcome).toContain('void startVoiceIn(sid.value)')
    expect(composer).toContain('void startVoiceIn(props.chatSid || ')
    expect(welcome).not.toContain('voice.start()')
    expect(composer).not.toContain('voice.start()')
    expect([welcome, composer, assistant].join('\n')).not.toContain('VOICE_CHAT_SESSION_ID')
  })

  /*
   * 语音的对白写这次通话绑的那条对话，派出去的活进它配套的那条任务对话。
   * 干活那条不能和说话那条共用 —— 共用正是过程日志渲染两遍、
   * 分不清谁在说话、以及闲聊污染 Agent 记忆的根因（见 docs §6）。
   */
  it('语音对白写进这次通话绑的那条对话', () => {
    expect(assistant).toContain('onUserText: recordVoiceUserText')
    expect(assistant).toContain('onAssistantText: updateVoiceAssistantText')
    expect(assistant).toContain('pushUser(boundSid')
    expect(welcome).toContain('class="voice-orb-dock"')
    expect(welcome).toContain(':output-level="voice.outputLevel.value"')
  })

  it('语音不再往任何 agent transcript 里写 —— 那是共用会话时代的补丁', () => {
    expect(welcome).not.toContain('appendExternalMessages')
    expect(assistant).not.toContain('appendExternalMessages')
  })

  /*
   * 走和打字同一套 executeAgent，只是目标对话不是用户正开着的这条。
   * 裸的 agentV3API.execute 主进程跑是跑了，界面上那条对话却一个字都不长 ——
   * 没有气泡、没有事件处理器，用户切过去看到的是空白。
   *
   * 用的是应用级的那个运行器，不再借助手页：助手路由没开 keepAlive，借页面
   * 就意味着用户切个页面语音就派不了活（报「助手页面都关了」）。
   */
  it('派活落在这通电话自己那条任务对话，走应用级运行器而不是借页面', () => {
    expect(assistant).toContain('pushUser(targetSid')
    expect(assistant).toContain('chatSid: targetSid')
    expect(assistant).toContain('appExecuteAgent(')
    expect(assistant).not.toContain('host.executeAgent(')
    expect(assistant).not.toContain('agentV3API.execute(')
    expect(welcome).not.toContain('agentV3API.execute(')
  })

  it('球体两路响度都接真实音频，才分得清是谁在说话', () => {
    expect(welcome).toContain(':input-level="voice.inputLevel.value"')
    expect(welcome).toContain(':output-level="voice.outputLevel.value"')
  })

  it('Agent 执行期间仍保留结束语音的麦克风按钮', () => {
    expect(composer).toContain('v-if="!props.isGenerating || voiceVisible"')
    expect(composer).toContain(':aria-pressed="props.voice.active.value"')
  })

  it('会话阶段由麦克风外的圆环交代，按钮不再换成 spinner 图标', () => {
    expect(composer).toContain(':phase="props.voice.phase.value"')
    expect(composer).toContain(':level="props.voice.outputLevel.value"')
    expect(composer).not.toContain(':loading="props.voice.connecting.value"')
  })

  it('欢迎球体只触发语音，并完整移除每日灵感链路', () => {
    expect(welcome).toContain('class="hero-sphere-button"')
    expect(welcome).toContain('@click="toggleVoice"')

    const removedDailyInspirationCode = [welcome, zhLocale, enLocale, localStorageBaseline].join(
      '\n'
    )
    expect(removedDailyInspirationCode).not.toContain('handleSphereEasterEgg')
    expect(removedDailyInspirationCode).not.toContain('assistant.blindBox')
    expect(removedDailyInspirationCode).not.toContain('daily_inspiration_reward_date')
    expect(removedDailyInspirationCode).not.toContain('DAILY_INSPIRATION')
  })
})

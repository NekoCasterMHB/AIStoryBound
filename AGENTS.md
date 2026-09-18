# AI StoryBound(AI Word2World)项目记忆

## 测试账户(本地/远程开发测试统一使用)

| 项 | 值 |
| --- | --- |
| 邮箱 | `testuser@example.com` |
| 用户名 | 测试玩家 |
| 密码 | `testpass123` |
| 用户 id(云端 D1) | `dEIoUv2Eq8yqTRaKDFTQq9KU3ymqUt0j` |
| 注册方式 | 邮箱 + 验证码 |

### 使用说明

- 登录方式:邮箱 + 密码直接登录(无需验证码);若流程需要验证码(如重注册),验证码存云端 D1 `verification` 表,`identifier` 含 `testuser`,用 `npx wrangler d1 execute aiword2world --remote --command "SELECT identifier, value FROM verification WHERE identifier LIKE '%testuser%'"` 查询(注意列名是 `expires_at` / `created_at` 下划线命名)。
- 该账户为正式保留的测试账号,不要删除;页面测试(登录、书架、游戏流程)默认使用它。

## TTS 语音服务(Edge TTS 代理)

| 项 | 值 |
| --- | --- |
| 代理 Worker | `https://aistorybound-edge-tts.w2575525962.workers.dev`(独立部署,源码在 `D:\workspace\edge-tts-worker`,README 含 API Key 明文) |
| 主应用配置 | `wrangler.toml [vars] TTS_BASE_URL` + `wrangler secret put TTS_API_KEY`(本地 `.dev.vars` 同名键);代码读法见 `server/api/tts.post.ts` |
| 中转端点 | `POST /api/tts`(body: `input/voice/speed/pitch`,需登录,返回音频流透传) |

### 前端架构要点

- 音色清单与「旁白+引号对白」多音色分段在 `shared/tts.ts`(纯函数 `buildSpeechSegments`;说话人归属三级:① 冒号强信号——引号前「角色名+≤6 字引导词+冒号」取离冒号最近的已知角色名(baseRules 已强制每处对白署名、引导语禁夹他人名)② 回退引号前 60 字内最近角色名 ③ 再沿用上一说话人;未配置音色的角色回退旁白音色)。
- 播放器单例 `app/utils/ttsPlayer.ts`(逐段请求+顺序播放+Blob LRU 缓存+`prefetchTts` 预取去重,全局互斥);逐角色配音设置存 IndexedDB `prefs` 表(key `tts-voice:<scope>`,含 `autoSpeak` 跟读开关),读写 `app/utils/ttsPrefs.ts`;设置弹窗 `app/components/VoiceSettingsModal.vue`。
- 入口:游戏页顶栏「配音」按钮 + 旁白消息悬停朗读按钮(`/games/[id].vue`);阅读页顶栏耳机按钮 + 听书迷你条(读完自动连播下一章,`/read/[src]/[id].vue`)。
- **打字机跟读(朗读与文字并行)**:typewriter 的 `waitFor` 显示门(`app/utils/typewriter.ts`)保留作每 tick 调度钩子,但门永远放行——游戏页在门里做跟读调度:段落一开始上屏即把该段排入页面级播放链 `liveChain`(token 作废机制),朗读与打字机同步开始、互不阻塞;流式期仅调度「稳定边界」(最后一个闭合引号,`stableFrontier`)内的段(分段不再随追加重切),`narrReady` 后全文定型并预取;回合收尾等「文字+链」都完成;快进/停止/新回合/手动朗读/配音设置变更统一走 `stopLiveTts()` 作废链。配音设置弹窗(`VoiceSettingsModal.vue`)内嵌全局播放器实时进度/状态 + 暂停/继续/停止,任意设置变更立即停朗读并即时回传配置。
- **计费**:按估算音频时长计 token——**1 秒 = 10 token**(`TTS_TOKENS_PER_SECOND`),时长 = 字符数 ÷(基准语速 4.8 字/秒 × 语速参数),公式在 `shared/tts.ts` `estimateTtsTokens`(实测校准:晓晓默认语速 ≈4.8 字/秒)。`server/api/tts.post.ts` 原子预扣 `ai_token_balance`(余额不足 402),上游失败退还,成功落 `ai_usage`(prompt/completion 置 0,不进 LLM 金额估算);响应头 `X-TTS-Tokens-Billed` 携带实扣值。回合统计:游戏页门里成功播放后 `addTurnTtsTokens` 累加,统计弹窗出现「配音朗读(TTS)」阶段行(旁白关闭时唯一消耗也可能早于报告建立,累加器会自行创建报告)。缓存命中不发请求不计费;若想改为按内容量计(不受语速影响),把公式里的 speed 去掉即可。
- **坑:USelect 的 SelectItem 禁止空字符串 value**(挂载即抛 `A <SelectItem /> must have a value prop that is not an empty string`,打崩弹窗渲染树导致无法关闭)。「不单独配音/关闭旁白」用哨兵值 `NO_VOICE='__none__'` 作下拉 value,写入配置时还原为空串(空串 = 不配音/关闭旁白),见 `VoiceSettingsModal.vue`。
- **旁白默认关闭**:配音设置里旁白音色选「关闭旁白(不朗读)」(配置值为空字符串)→ 只朗读配置了音色的角色对白,叙述与未配音角色台词整段跳过;`defaultVoiceConfig`/各页初始值即旁白关闭(空串),用户显式选择旁白音色后才开启;阅读页听书在旁白关闭时提示并打开设置。
- 叙事 prompt 对白格式约定(`shared/game.ts` baseRules 第 1 条):对白必须「」包裹、引号前紧邻角色名+引导词、单引号单角色——这是分段归属可靠性的前提,改动措辞需同步验证 `buildSpeechSegments`。
- 超长文本切分:单段 ≤1100 字,攒满后句读处落段(勿改成每句一切,会产生海量碎段请求)。


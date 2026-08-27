// adapter.example.js — Tier 2 适配器示例(伪品牌 DemoFun)
//
// 适用于协议无法用 Tier 1 声明式配置表达的玩具(有校验和/加密/复杂握手)。
// 约定:
//   1. 文件必须命名为 adapter.js,放在 manifest.json 旁边,一起导入;
//   2. 在 Worker 全局作用域定义 self.buildFrames(必填)、self.buildInitFrames(可选)、self.buildStopFrames(可选);
//   3. 函数必须是【纯函数】:输入命令对象,输出 Uint8Array 帧数组;不能访问网络/蓝牙/DOM/定时器;
//   4. 全部同步执行(沙箱不做异步支持);帧必须是 Uint8Array(或可转为 Uint8Array 的数组)。
//
// command 结构(与 AI 下发的语义命令一致):
//   { function: 'vibration' | 'heating' | ..., intensity: 0-100, mode?: 1-4, duration?: 秒 }
// lastState 结构(stop 时提供):
//   { 'vibration': { mode: 2 }, 'heating': { mode: undefined } }

// 帧格式(示例玩具 DemoFun,8 字节):
//   [0] 0xAA 固定帧头  [1] SEQ(随机,设备不校验)  [2] 0x01 固定
//   [3] 功能码(震动 0x01 / 加热 0x03)  [4] 强度 0-100  [5] 0x00 填充
//   [6] 0x11 操作码  [7] 模式(震动 1-4;加热固定 1)
const FN_CODE = { vibration: 0x01, heating: 0x03 }

self.buildFrames = function (command) {
  const code = FN_CODE[command.function]
  if (code == null) throw new Error('不支持的功能: ' + command.function)
  const frame = new Uint8Array([
    0xAA,
    Math.floor(Math.random() * 256), // SEQ:随机
    0x01,
    code,
    Math.max(0, Math.min(100, Math.round(command.intensity))),
    0x00,
    0x11,
    command.mode != null ? command.mode : 1
  ])
  return [frame]
}

self.buildInitFrames = function () {
  // 连接后先发初始化帧(如有),让设备就绪
  return [new Uint8Array([0xAA, 0x00, 0x01, 0x00, 0xC8, 0x11, 0x01])]
}

self.buildStopFrames = function (lastState) {
  // 全停:每个功能各发一帧强度 0(模式保留,与"强度归零"约定一致)
  const frames = []
  for (const fn of Object.keys(FN_CODE)) {
    const mode = lastState && lastState[fn] && lastState[fn].mode != null ? lastState[fn].mode : 1
    frames.push(new Uint8Array([0xAA, 0x00, 0x01, FN_CODE[fn], 0x00, 0x00, 0x11, mode]))
  }
  return frames
}

# 插件配置制作指南(平台强制格式)

本平台用**统一语义控制插件**:用户上传一份 `manifest.json`(配置清单),系统按**强制格式规则**分析,自动渲染控制 UI,并把**能力清单(含每能力强度上限)**暴露给 AI——AI 在剧情流式输出中埋入内联指令,文字显示到对应句子时设备即时执行。

> **强制规则**:清单**没有任何隐式推导**——连接 uuid、电量查询、每功能指令、能力与强度上限必须全部显式声明。缺任何必填字段,导入会被拒绝,错误信息会列出具体缺项。

---

## 一、清单结构总览

```
manifest.json
├── id / name / version / icon / description    顶层(必填:id/name/version)
├── runtime                                    执行后端(必填)
│   ├── type: "toy-protocol" | "toy-code" | "none"
│   ├── scanNames                               蓝牙广播名(玩具必填)
│   ├── protocol                                协议全量(Tier 1)
│   │   ├── gatt                                连接 uuid(必填)
│   │   ├── battery                             电量查询(必填)
│   │   ├── frame                               帧模板 + 强度/模式范围(必填)
│   │   ├── functions                           每功能指令(必填)
│   │   ├── init                                初始化帧(可选)
│   │   └── perFunctionPair                     逐功能发包(可选,默认 true)
│   └── (toy-code 时) gatt / battery            连接参数(必填)
├── capabilities                                能力声明(必填,数组)
└── ui                                          控制面板布局(可选,缺省自动生成)
```

## 二、顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 稳定标识,小写字母/数字/连字符,唯一(导入主键、AI 指令路由目标) |
| `name` | string | ✅ | 展示名(界面卡片、AI 提示词) |
| `version` | string | ✅ | 版本号 |
| `icon` | string | 可选 | emoji 图标 |
| `description` | string | 可选 | 一句话说明 |

## 三、连接声明(runtime)

### 3.1 蓝牙广播名 `scanNames`

扫描设备时按**广播名前缀**过滤(如啵啵贝广播名 `SOSEXY`);不声明则列出全部设备由用户选择。

```json
"scanNames": ["SOSEXY"]
```

### 3.2 连接 uuid `protocol.gatt`(必填)

Web Bluetooth 连接所需的服务/写/通知特征 UUID,缺一不可;自定义服务 UUID 必须声明,否则连接时会被浏览器拒绝。

```json
"gatt": {
  "serviceUuid": "0000ee01-0000-1000-8000-00805f9b34fb",
  "writeUuid": "0000ee03-0000-1000-8000-00805f9b34fb",
  "notifyUuid": "0000ee02-0000-1000-8000-00805f9b34fb",
  "writeWithResponse": true
}
```

`writeWithResponse` 缺省 `true`(带响应写入)。

### 3.3 电量查询 `protocol.battery`(必填)

声明设备是否支持电量读取。**缺省用标准电池服务** `0x180f/0x2a19`;自定义设备必须声明自己的服务/特征 UUID。

```json
"battery": { "supported": true }
```

```json
"battery": {
  "supported": true,
  "serviceUuid": "0000ff0f-0000-1000-8000-00805f9b34fb",
  "characteristicUuid": "0000ff1a-0000-1000-8000-00805f9b34fb"
}
```

设备无电量时:`"battery": { "supported": false }`(界面不显示电量)。

## 四、帧声明(protocol.frame / protocol.functions)

### 4.1 帧模板 `frame.template`

一帧由 token 序列构成,支持字面量与占位符:

| token | 含义 |
|---|---|
| `0xNN` 或纯数字 | 固定字节(十六进制/十进制,0-255) |
| `[SEQ]` | 随机字节(多数设备不校验;`seqRandom:false` 时恒为 0) |
| `[MODE1]` | 强度通道字节(该功能 `mode1` 声明的值) |
| `[MODE2]` | 模式通道字节(该功能 `mode2` 声明的值) |
| `[INTENSITY]` | 强度(映射到 `intensityRange`) |
| `[MODE]` | 模式档位(映射到 `modeRange`) |

```json
"frame": {
  "template": ["[SEQ]", "0x01", "0x00", "0x02", "0x00", "[MODE1]", "0x11", "[INTENSITY]", "0x00", "[MODE2]", "0x11", "[MODE]"],
  "seqRandom": true,
  "intensityRange": [0, 100],
  "modeRange": [1, 4]
}
```

- `intensityRange`(必填):帧字节上的强度映射范围,通常 `[0,100]`;
- `modeRange`(可选):档位范围,如 `[1,4]`。

### 4.2 每功能指令 `protocol.functions`(必填)

每个功能一对通道:**`mode1` 强度通道 + `mode2` 模式通道**;`supportsMode: true` 表示有档位。

```json
"functions": {
  "suction":   { "mode1": "0x07", "mode2": "0x08", "supportsMode": true },
  "vibration": { "mode1": "0x01", "mode2": "0x02", "supportsMode": true },
  "electric":  { "mode1": "0x03", "mode2": "0x04", "supportsMode": true }
}
```

### 4.3 初始化帧 `init`(可选)

连接成功后必发的初始化帧(等设备回 `notifyFragments` 条通知后才可下发控制):

```json
"init": { "frame": ["[SEQ]", "0x01", "0x00", "0x01", "0x00", "0xC8", "0x11", "0x01"], "notifyFragments": 4, "waitMs": 2000 }
```

无初始化流程则删除该段。

### 4.4 逐功能发包 `perFunctionPair`(可选,默认 true)

多数玩具要求一次只发正在调的那一对通道,把多个功能的通道塞进一个包会无响应,保持默认 `true`。

## 五、能力声明(capabilities,必填,禁止隐式推导)

每个功能对应一个能力,`intensity` 参数的 `min`/`max` **即该能力的强度上限**——既写入 AI 提示词(让 AI 知道可控范围),也是执行时钳制/拒绝的上限。

```json
"capabilities": [
  {
    "id": "vibration",
    "name": "震动",
    "description": "震动强度控制,用于节奏性身体互动情节。intensity 越大震动越强;mode 为档位;duration 为持续秒数(到时自动停止)。",
    "params": [
      { "key": "intensity", "type": "int", "min": 0, "max": 100, "description": "强度 0-100(0=停止)" },
      { "key": "mode", "type": "enum", "values": [ { "value": 1, "label": "档位 1" }, { "value": 2, "label": "档位 2" } ], "description": "模式档位" },
      { "key": "duration", "type": "int", "min": 0, "max": 3600, "description": "持续秒数(到时自动停止;0=不限)" }
    ]
  }
]
```

### 参数三种类型

| 类型 | 必填字段 | 可选字段 |
|---|---|---|
| `int` / `float` | `key`、`type`、`max`(强度上限) | `min`、`step`、`unit`、`default`、`required`、`description` |
| `enum` | `key`、`type`、`values:[{value,label}]` | `default`、`description` |
| `bool` | `key`、`type` | `default`、`description` |

### 强度上限规则(重要)

- `intensity.min` 恒为 **0**(0=停止,低于 0 会被归一化);
- `intensity.max` 是 AI 可控范围上限,也是执行上限;**不得超过 `protocol.frame.intensityRange` 上限**(如帧范围是 `[0,100]`,能力上限也只能 ≤100);超出会被拒绝;
- 用户可在「详细配置」安全设置中**进一步调低**上限(生效上限 = min(清单声明值, 用户设置)),清单值本身不能被调高;
- `mode` 档位数不得超过 `frame.modeRange` 上限;无档位的功能不声明 `mode` 参数即可。

## 六、控制面板布局(ui,可选)

缺省由平台按 capabilities 自动生成默认布局(每能力一组:强度滑块 + 模式档位 + 时长档位);需要定制时声明 `ui`:

```json
"ui": {
  "groups": [
    {
      "id": "vibration-group",
      "title": "震动",
      "controls": [
        { "type": "slider", "bind": { "capability": "vibration", "param": "intensity" }, "label": "强度" },
        { "type": "stepper", "bind": { "capability": "vibration", "param": "mode" }, "values": [{ "label": "1", "value": 1 }, { "label": "2", "value": 2 }] }
      ]
    }
  ]
}
```

控件六种:

| 类型 | 说明 | 关键字段 |
|---|---|---|
| `slider` | 强度滑块(纵向,拖动即发,0 即停) | `bind`、可选 `min/max/step`(缺省取参数声明) |
| `stepper` | 档位按钮组(模式/时长) | `bind`、`values:[{label,value}]` |
| `select` | 下拉选择 | `bind`、可选 `options` |
| `toggle` | 开关 | `bind` |
| `action` | 一键动作(固定参数) | `capability`、`params:{key:value}`、`label` |
| `display` | 只读实时状态(如强度) | `bind` |

`bind` 必须指向已声明能力的已声明参数,否则拒绝。

## 七、Tier 2 代码适配器(runtime.type = "toy-code")

协议有校验和/加密/握手等逻辑时,配一个 `adapter.js` 放在 manifest.json 旁边一起导入(或打 zip):

- 在 Worker 全局作用域定义 `self.buildFrames(command)`(必填)、`self.buildInitFrames()`(可选)、`self.buildStopFrames(lastState)`(可选);
- 函数必须是**同步纯函数**:输入命令对象,输出 `Uint8Array` 帧数组,不能访问网络/蓝牙/DOM/定时器;
- `runtime.type: "toy-code"` 时,连接参数改为在 runtime 顶层声明 `gatt` 与 `battery`(格式同 Tier 1);
- capabilities 仍必须显式声明。

## 八、AI 内联指令语法

AI 在剧情流式输出中埋入指令(对玩家不可见、不在正文复述),文字显示到对应句子时执行:

| 指令 | 语法 | 示例 |
|---|---|---|
| 设备动作 | `[[dev:功能id:强度[:模式[:持续秒数]]]]` | `[[dev:vibration:80:2:5]]`(震动 强度80 模式2 持续5s) |
| 戏剧性停顿 | `[[pause:毫秒]]` | `[[pause:800]]`(关键情绪点;常规标点停顿由系统自动处理) |

- 强度必须在该能力声明的范围内;`duration` 省略 = 保持,由后续指令或自动停止接管;
- **指令数量不设上限**,完全由 AI 按情节节奏判断;
- 未连接设备的事件会被拒绝并提示。

## 九、本地测试流程(无硬件也能跑)

1. 在个人中心 → 功能插件,点「导入适配器」选择你的 `manifest.json`(+ 可选 `adapter.js`),或打包成 zip 导入;
2. 导入成功后在列表出现卡片,点「详细配置」;
3. 「配置」页连接区保持「模拟设备 (Mock)」→ 连接;
4. 「手动控制」页用滑条控制各功能——mock 会记录收到的帧(十六进制),可核对帧构造是否正确;
5. 确认无误后,开「真实蓝牙连接」连真机(桌面/Android Chrome;iOS Safari 暂不支持)。

## 十、常见拒绝原因

| 缺项 | 错误提示 |
|---|---|
| 缺 id / name / version | 「缺少 id(稳定标识)」等 |
| 缺连接 uuid | 「缺少 protocol.gatt uuid 声明(serviceUuid / writeUuid / notifyUuid)」 |
| 缺电量查询 | 「缺少 protocol.battery 电量查询声明」 |
| 缺每功能指令 | 「runtime.toy-protocol 的 protocol 不合法(需 … functions 每功能指令)」 |
| 缺能力声明 | 「capabilities 必须显式声明至少一个能力(禁止隐式推导)」 |
| 缺强度上限 | 「capability「xx」缺少强度上限(intensity.max)」 |
| 强度上限超帧范围 | 「capability「xx」强度上限 120 超出帧范围上限 100」 |
| 档位超帧范围 | 「capability「xx」模式档位数 6 超出帧 modeRange 上限 4」 |

## 合规提醒

- 只逆向**你自己拥有**的设备;协议通常无官方文档,社区逆向成果自行甄别;
- 插件仅在本地浏览器运行,不经过任何服务器,数据不出设备。

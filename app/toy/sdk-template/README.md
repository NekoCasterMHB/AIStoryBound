# 玩具适配器 SDK(玩家开发指南)

本平台用**统一语义 API** 控制玩具:AI/游戏只认识归一化命令(功能 + 强度 0-100 + 模式 + 时长),品牌差异全部收敛在「适配器」里。你开发的适配器让平台支持你的玩具。

## 适配器是什么

一个适配器 = 一个文件夹,包含:

```
my-adapter/
├── manifest.json      # 声明文件(必填):品牌信息、扫描名、能力、协议配置
└── adapter.js         # 代码文件(仅 Tier 2 需要):纯函数 buildFrames 等
```

打包成 zip 后,在「设备面板 → 导入适配器」里选择导入即可。

## 两种适配器,先选对路

### Tier 1:声明式配置(推荐,零代码)

适合协议简单、无校验和/加密的玩具(啵啵贝就是这种)。

- 复制 [`manifest.example.json`](./manifest.example.json) 为 `manifest.json`;
- 改 `scanNames`(广播名)、`gatt`(UUID)、`frame.template`(帧模板)、`functions`(通道对)、`init`(初始化帧);
- **不需要 adapter.js**。

字段说明:

| 字段 | 说明 |
|---|---|
| `id` | 稳定标识,小写字母/数字/连字符,唯一 |
| `scanNames` | BLE 广播名(前缀匹配),连接时用于过滤设备 |
| `functionNames` | 功能中文名(界面/AI 提示词展示) |
| `protocol.gatt` | 服务/写/通知特征 UUID;`writeWithResponse: true` 时用带响应写入 |
| `protocol.frame.template` | 帧模板 token 序列:`0xNN` 字面量;`[SEQ]` 随机字节;`[MODE1]`/`[MODE2]` 通道字节;`[INTENSITY]` 强度(0-100);`[MODE]` 模式档位 |
| `protocol.functions` | 每个功能一对通道:`mode1` 强度通道 + `mode2` 模式通道;`supportsMode` 是否有模式档位 |
| `protocol.init` | 连接后必发的初始化帧(如无则删除该段) |
| `perFunctionPair` | 是否要求逐功能一对通道发包(默认 true,多数玩具必须) |

### Tier 2:代码适配器(Worker 沙箱)

适合有校验和/加密/握手等逻辑的玩具。复制 [`adapter.example.js`](./adapter.example.js),按约定实现:

- `self.buildFrames(command)` → `Uint8Array[]`(**必填**):语义命令转帧;
- `self.buildInitFrames()` → `Uint8Array[]`(可选):连接后初始化;
- `self.buildStopFrames(lastState)` → `Uint8Array[]`(可选):全停;缺省自动回退为逐功能强度 0。

**沙箱规则(务必遵守)**:函数必须是同步纯函数——不能访问网络、蓝牙、DOM、定时器、localStorage;输入命令对象、输出帧数组。代码在 Web Worker 里执行,隔离于页面,但仍然只信任你自己写的代码。

## 抓包逆向你的玩具(没有协议文档时)

1. Android 开发者选项开启「蓝牙 HCI 信息收集日志」,**先关闭再打开蓝牙**(否则不记录);
2. 用官方 App 操作各功能,触发强度变化;
3. bugreport 导出后,在 `FS/data/misc/bluetooth/logs/bthci/` 找 `.btsnoop`,用 Wireshark 打开;
4. 过滤 ATT `Write Request`,对比不同强度/功能的包,找出帧结构、通道字节与强度字节的位置;
5. iOS 抓包:安装 Bluetooth Logging 描述文件 → sysdiagnose → `.pklg` → PacketLogger 分析。

## 本地测试流程(无硬件也能跑)

1. 打开「设备面板」页;
2. 「导入适配器」选择你的文件夹/zip(含 manifest.json,必要时加 adapter.js);
3. 在连接区选「模拟设备 (Mock)」→ 连接;
4. 用滑条控制各功能——mock 会记录并展示收到的帧(十六进制),可核对帧构造是否正确;
5. 确认无误后,再用真机:选「蓝牙直连 (Web Bluetooth)」连接(桌面/Android Chrome;iOS Safari 暂不支持)。

## 控制链路与安全

```
AI 回合输出 device_events → 校验(能力/范围)→ 硬限制(最大强度/时长/总开关)→ 适配器帧 → 传输 → 玩具
```

- AI 只能使用你 `capabilities` 里声明的功能;
- 用户设置的硬限制对所有来源(含 AI)生效,超限直接拒绝;
- 所有命令带自动停止(时长到期)/断连自动停止/紧急停止按钮三重保险。

## 合规提醒

- 只逆向**你自己拥有**的设备;协议通常无官方文档,社区逆向成果自行甄别;
- 适配器仅在本地浏览器运行,不经过任何服务器,数据不出设备。

# 玩具插件 SDK(玩家开发指南)

本平台用**统一语义**控制设备:AI/游戏只认识归一化命令(功能 + 强度 + 模式 + 时长),设备差异全部收敛在「插件清单」里。你开发的插件让平台支持你的设备。

> **完整规范请阅读 [`PLUGIN_GUIDE.md`](./PLUGIN_GUIDE.md)**(平台强制格式:uuid / 电量查询 / 每功能指令 / 能力与强度上限全部显式声明,缺必填字段导入被拒并提示缺项)。

## 插件是什么

一个插件 = 一个文件夹:

```
my-adapter/
├── manifest.json      # 声明文件(必填):品牌信息、连接(uuid/电量)、每功能指令、能力声明
└── adapter.js         # 代码文件(仅 Tier 2 需要):纯函数 buildFrames 等
```

打包成 zip 后,在「个人中心 → 功能插件 → 导入适配器」导入即可(支持多选文件或 zip)。

## 两种适配器,先选对路

### Tier 1:声明式配置(推荐,零代码)

适合协议简单、无校验和/加密的设备(啵啵贝就是这种)。

- 复制 [`manifest.example.json`](./manifest.example.json) 为 `manifest.json`;
- 改 `scanNames`(广播名)、`protocol.gatt`(uuid)、`protocol.battery`(电量查询)、`protocol.frame`(帧模板)、`protocol.functions`(每功能指令)、`protocol.init`(初始化帧)、`capabilities`(能力声明,含每能力强度上限);
- **不需要 adapter.js**。

### Tier 2:代码适配器(Worker 沙箱)

适合有校验和/加密/握手等逻辑的设备。复制 [`adapter.example.js`](./adapter.example.js),按约定实现:

- `self.buildFrames(command)` → `Uint8Array[]`(**必填**):语义命令转帧;
- `self.buildInitFrames()` → `Uint8Array[]`(可选):连接后初始化;
- `self.buildStopFrames(lastState)` → `Uint8Array[]`(可选):全停;缺省自动回退为逐功能强度 0。

**沙箱规则(务必遵守)**:函数必须是同步纯函数——不能访问网络、蓝牙、DOM、定时器、localStorage;输入命令对象、输出帧数组。代码在 Web Worker 里执行,隔离于页面,但仍然只信任你自己写的代码。

## AI 内联指令(流式同步)

AI 在剧情流式输出中埋入指令(对玩家不可见),文字显示到对应句子时设备即时执行:

- 设备动作:`[[dev:功能id:强度[:模式[:持续秒数]]]]`,如 `[[dev:vibration:80:2:5]]`;
- 戏剧性停顿:`[[pause:毫秒]]`,如 `[[pause:800]]`(常规标点停顿由系统自动处理)。

指令数量不设上限,完全由 AI 按情节判断;强度必须在该能力声明的范围内。

## 抓包逆向你的设备(没有协议文档时)

1. Android 开发者选项开启「蓝牙 HCI 信息收集日志」,**先关闭再打开蓝牙**(否则不记录);
2. 用官方 App 操作各功能,触发强度变化;
3. bugreport 导出后,在 `FS/data/misc/bluetooth/logs/bthci/` 找 `.btsnoop`,用 Wireshark 打开;
4. 过滤 ATT `Write Request`,对比不同强度/功能的包,找出帧结构、通道字节与强度字节的位置;
5. iOS 抓包:安装 Bluetooth Logging 描述文件 → sysdiagnose → `.pklg` → PacketLogger 分析。

## 本地测试流程(无硬件也能跑)

1. 个人中心 → 功能插件 → 「导入适配器」选择你的 `manifest.json`(必要时加 `adapter.js`),或 zip 导入;
2. 导入成功后在列表出现卡片,点「详细配置」;
3. 连接区保持「模拟设备 (Mock)」→ 连接;
4. 用手动控制滑条驱动各功能——mock 会记录并展示收到的帧(十六进制),可核对帧构造是否正确;
5. 确认无误后,再开「真实蓝牙连接」连真机(桌面/Android Chrome;iOS Safari 暂不支持)。

## 控制链路与安全

```
AI 叙事流内联指令 [[dev:...]] → 解析 → 校验(能力/声明范围)→ 硬限制(AI 开关/强度上限)→ 适配器帧 → 传输 → 设备
```

- AI 只能使用你 `capabilities` 里声明的功能,强度不得超过声明的上限;
- 用户设置的硬限制对所有来源(含 AI)生效,超限直接拒绝;
- 所有命令带自动停止(时长到期)/断连自动停止/紧急停止按钮三重保险;
- 自动指令生效期间,手动面板显示 loading 并锁定,回合收尾后恢复。

## 合规提醒

- 只逆向**你自己拥有**的设备;协议通常无官方文档,社区逆向成果自行甄别;
- 插件仅在本地浏览器运行,不经过任何服务器,数据不出设备。

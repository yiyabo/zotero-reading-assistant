# 🔴 问题总结 - Zotero Reading Assistant 无法加载

## 📊 项目信息

**项目路径**: `/Users/apple/work/zotero-llm/zotero-reading-assistant`  
**基于项目**: zotero-gpt (https://github.com/MuiseDestiny/zotero-gpt)  
**目标**: 创建一个 Zotero 侧边栏聊天助手，集成 Qwen API

## 🎯 已完成的工作

### 1. 项目创建 ✅
- 基于 zotero-gpt 创建了新项目
- 移除了付费验证模块
- 修改为侧边栏 UI（而非浮动窗口）

### 2. Qwen API 集成 ✅
- 实现了 QwenProvider 类
- 支持流式响应
- 配置信息：
  - API Key: `<YOUR_API_KEY>`
  - API URL: `https://dashscope.aliyuncs.com/compatible-mode`
  - Model: `qwen-max`

### 3. PDF 功能 ✅
- PDF 文本选择提取
- PDF 注释提取
- PDF 元数据提取
- Markdown 渲染（支持 LaTeX 数学公式）

### 4. 构建系统 ✅
- TypeScript 编译配置
- esbuild 打包
- XPI 文件生成

## ❌ 核心问题

**插件无法在 Zotero 9 (版本 140.10.0) 中加载**

### 症状
- 插件列表中完全看不到插件
- 错误控制台中没有任何与插件相关的错误
- 尝试了多种安装方式都失败

### 尝试过的解决方案

#### 1. 版本兼容性调整
- ❌ `strict_max_version: "7.0.*"` - 失败
- ❌ `strict_max_version: "200.*"` - 失败
- ❌ `strict_max_version: "10.*"` - 失败
- ❌ `strict_max_version: "9.*"` - 失败（最后尝试，参考了能正常工作的 Ethereal Style 插件）

#### 2. 安装方式
- ❌ 通过 Zotero UI 安装 XPI - 提示不兼容
- ❌ 开发模式（扩展代理文件）- 插件不出现
- ❌ 直接复制 XPI 到 extensions 目录 - 插件不出现

#### 3. 代码简化
- ❌ 创建了极简版本（只有 40 行代码，631 字节）
- ❌ 移除了所有复杂依赖
- ❌ 仍然无法加载

## 📁 当前文件结构

```
zotero-reading-assistant/
├── addon/
│   ├── manifest.json          # 插件清单
│   ├── bootstrap.js           # 启动脚本
│   ├── chrome.manifest        # Chrome 注册
│   ├── prefs.js              # 默认配置
│   └── chrome/
│       ├── content/
│       │   ├── icons/        # 图标
│       │   ├── markdown.css  # Markdown 样式
│       │   └── scripts/      # (构建后生成)
│       └── locale/           # 本地化
├── src/
│   ├── index.ts              # 主入口（当前是极简版本）
│   ├── index-full.ts.backup  # 完整版本备份
│   ├── addon.ts
│   ├── hooks.ts
│   └── modules/
│       ├── llm/              # LLM 管理
│       ├── utils/            # 工具函数
│       └── zotero/           # Zotero 集成
├── builds/
│   ├── addon/                # 构建输出
│   └── zotero-reading-assistant.xpi  # 打包文件
├── package.json
├── tsconfig.json
└── README.md
```

## 🔍 关键文件内容

### manifest.json (当前配置)
```json
{
  "manifest_version": 2,
  "name": "Zotero Reading Assistant",
  "version": "0.1.0",
  "description": "AI-powered reading assistant sidebar for Zotero",
  "author": "Your Name",
  "icons": {
    "48": "chrome/content/icons/gpt.png",
    "96": "chrome/content/icons/favicon.png"
  },
  "applications": {
    "zotero": {
      "id": "reading-assistant@zotero.org",
      "update_url": "",
      "strict_min_version": "6.999",
      "strict_max_version": "9.*"
    }
  }
}
```

### 当前 index.ts (极简版本)
```typescript
// Minimal test version
import { config } from "../package.json";

if (typeof Zotero === 'undefined') {
  var Zotero: any;
}

const addon = {
  init: function() {
    Zotero.debug("========================================");
    Zotero.debug(`${config.addonName}: Plugin loaded successfully!`);
    Zotero.debug(`Zotero version: ${Zotero.version}`);
    Zotero.debug("========================================");
    
    try {
      const progressWindow = new Zotero.ProgressWindow();
      progressWindow.changeHeadline(config.addonName);
      progressWindow.addLines(["Plugin loaded successfully! ✅"]);
      progressWindow.show();
      progressWindow.startCloseTimer(3000);
    } catch (e: any) {
      Zotero.debug(`Failed to show notification: ${e}`);
    }
  },
  
  shutdown: function() {
    Zotero.debug(`${config.addonName}: Plugin shutting down`);
  }
};

Zotero[config.addonInstance] = addon;

try {
  addon.init();
} catch (e: any) {
  Zotero.debug(`${config.addonName}: Failed to initialize - ${e}`);
  Zotero.debug(e.stack);
}
```

## 🔬 调试信息

### 用户环境
- **操作系统**: macOS
- **Zotero 版本**: 140.10.0 (Zotero 9 beta)
- **Zotero Profile**: `~/Library/Application Support/Zotero/Profiles/q05bi47w.default`

### 能正常工作的插件
- Ethereal Style (zoterostyle@polygon.org) - 使用 `strict_max_version: "9.*"`
- Translate for Zotero
- Better Notes for Zotero (已禁用)

### 错误控制台
- 没有任何与 "reading-assistant" 或 "ReadingAssistant" 相关的错误
- 只有 Zotero 系统本身的一些错误（与插件无关）

### 文件验证
- ✅ XPI 文件完整（803 KB）
- ✅ manifest.json 格式正确
- ✅ bootstrap.js 存在且格式正确
- ✅ 所有必需文件都存在
- ✅ 文件权限正常

## 🤔 可能的原因

1. **Zotero 9 的新要求**
   - Zotero 9 可能有新的插件加载机制
   - 可能需要特殊的签名或验证
   - 可能不再支持某些旧的 API

2. **Bootstrap 加载问题**
   - bootstrap.js 可能使用了不兼容的 API
   - 可能需要更新到 Zotero 8/9 的新格式

3. **构建配置问题**
   - esbuild 配置可能不适合 Zotero 9
   - 可能需要不同的打包方式

4. **插件 ID 冲突**
   - 虽然不太可能，但 `reading-assistant@zotero.org` 可能与某些内部机制冲突

## 📚 参考资源

- [Zotero 7 开发者文档](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero 8 开发者文档](https://www.zotero.org/support/dev/zotero_8_for_developers)
- [Zotero 9 发布公告](https://zotero.org/blog/zotero-9/)
- [Zotero 插件模板](https://github.com/windingwind/zotero-plugin-template)
- [原始 zotero-gpt 项目](https://github.com/MuiseDestiny/zotero-gpt)

## 🔄 建议的下一步

1. **检查 Zotero 9 官方文档**
   - 查看是否有 Zotero 9 特定的插件开发指南
   - 确认是否有新的 manifest 要求

2. **对比能工作的插件**
   - 解包 Ethereal Style 的 XPI
   - 详细对比 bootstrap.js 和其他文件
   - 查看是否有我们遗漏的配置

3. **测试官方插件模板**
   - 使用 windingwind/zotero-plugin-template
   - 看看官方模板生成的插件能否在 Zotero 9 上运行

4. **联系 Zotero 社区**
   - 在 Zotero 论坛询问 Zotero 9 插件开发问题
   - 查看是否有其他开发者遇到类似问题

5. **检查 Zotero 9 beta 的已知问题**
   - 可能是 Zotero 9 beta 的 bug
   - 查看 GitHub issues

## 📦 交接文件

所有代码都在：`/Users/apple/work/zotero-llm/zotero-reading-assistant`

重要文件：
- `addon/manifest.json` - 插件清单
- `addon/bootstrap.js` - 启动脚本
- `src/index.ts` - 主入口（极简版本）
- `src/index-full.ts.backup` - 完整功能版本
- `builds/zotero-reading-assistant.xpi` - 最新构建

构建命令：
```bash
cd /Users/apple/work/zotero-llm/zotero-reading-assistant
npm run build-prod
```

---

**总结**: 插件的所有功能都已实现，代码没有明显错误，但无法在 Zotero 9 (140.10.0) 中加载。问题可能与 Zotero 9 的新要求或 beta 版本的特殊限制有关。需要深入研究 Zotero 9 的插件加载机制。

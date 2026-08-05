# Zotero Reading Assistant

[![Release](https://img.shields.io/github/v/release/yiyabo/zotero-reading-assistant?label=release)](https://github.com/yiyabo/zotero-reading-assistant/releases/latest)
[![Zotero](https://img.shields.io/badge/Zotero-7-CC2936)](https://www.zotero.org/)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

在 Zotero 侧边栏中直接和论文、PDF、便签与知识图谱对话 —— 不用离开文献管理器。

![Zotero Reading Assistant 界面](docs/assets/introduce.png)

> 截图摄于早期版本,PDF 便签、多会话管理和重做后的空状态界面尚未包含在内。

## 这是什么

一个面向学术精读工作流的 Zotero 7 插件。它把 AI 对话、PDF 上下文读取、页面便签、Markdown/LaTeX 渲染和文献知识图谱整合进 Zotero 的右侧栏,目标是支撑**深度阅读**,而不只是生成一段摘要。

界面提供中文与英文两套文案,跟随 Zotero 的语言设置。

## 功能

### 侧边栏对话

- 在 Zotero 条目面板中常驻,阅读 PDF 时不被弹窗打断。
- **PDF 上下文理解**:读取当前 PDF 的选中文本、注释、元数据与页面内容作为回答依据。
- **多会话管理**:同一篇论文下可并行多个对话,随时新建、切换、删除。
- **局部追问**:从任意一条 AI 回答旁开独立追问窗口,围绕该回答深入,不污染主对话。
- **图片提问**:截图、图表或页面片段可直接粘贴进输入框,交给支持视觉的模型分析。
- **Markdown / LaTeX 渲染**:列表、代码块、表格、引用块与数学公式。
- **对照论文**:选取库内其他文献作为参照,进行横向比较。

### PDF 便签

- 在 PDF 页面上直接放置便签,支持拖动与缩放,位置随页面锚定。
- 便签正文是 Markdown,提供编辑 / 分栏 / 预览三种视图与实时预览。
- 内置 AI 工具条,三个动作共用同一套流式改写逻辑:
  - **AI 生成** —— 依据便签所在页的正文生成内容;
  - **AI 优化格式** —— 把草稿重写为结构清晰的 Markdown;
  - **AI 改写选区** —— 只改动选中的那一段,其余原样保留。
- 便签可在对话里用 `#编号` 引用。

### 知识图谱与 Wiki

- 从 Zotero 文献库构建**论文 — 方法 — 数据集**关系网络。
- 关系边尽量保留 evidence、rationale、source fields 等可解释信息,而非只给一个结论。
- **知识 Wiki**:把图谱中的论文、方法、数据集和研究方向沉淀为可浏览页面,每页可追加个人 Markdown 备注。

### 文献集整理

- 让模型审阅现有 collection 结构并给出改进建议,附带理由。
- 也提供手动拖拽模式。
- **任何变更都需要你确认后才会写入**,不存在自动改库。

## 安装

### 从 Release 安装(推荐)

1. 到 [Releases](https://github.com/yiyabo/zotero-reading-assistant/releases/latest) 下载 `zotero-reading-assistant.xpi`。
2. Zotero → 工具 → 插件 → 右上角齿轮 → **从文件安装插件…**(Install Add-on From File…)
3. 选中刚下载的 `.xpi`,重启 Zotero。

插件内置更新源,后续新版本会由 Zotero 自动提示升级,无需手动重装。

> 仓库里**不含**打包好的 XPI(`builds/` 已被 gitignore),请从 Release 下载,或按下方步骤自行构建。

### 配置模型

打开插件设置页填写:

| 设置 | 说明 | 默认值 |
| --- | --- | --- |
| **API Key** | 模型服务密钥 | 空 |
| **Base URL** | 兼容 OpenAI Chat Completions 的接口地址 | `https://dashscope.aliyuncs.com/compatible-mode` |
| **Model** | 模型名称 | `qwen-max` |
| **Temperature** | 生成温度 | `0.7` |
| **Max tokens** | 单次最大输出长度 | `8192` |
| **Web search** | 若服务端支持则可开启 | 开 |

任何兼容 OpenAI Chat Completions 协议的服务都可以接入;默认指向 Qwen DashScope 的 compatible mode。

**API Key 只保存在本地 Zotero 配置中。** 不要写进源码、README 或提交历史。

## 开发

需要 Node.js、npm,以及 Zotero 7(manifest 声明的兼容区间是 `6.999` – `9.*`)。

```bash
npm install
npm run build-dev    # 开发构建 → builds/
npm run link-dev     # 把 builds/addon 以代理文件方式链接进 Zotero profile
```

之后重启 Zotero 即可加载。改完代码重复 `build-dev`,或者用一条命令走完全流程:

```bash
npm run restart      # build-dev → link-dev → 关闭 Zotero → 重新启动
```

### 常用命令

```bash
npx tsc --noEmit     # 类型检查(提交前必须通过)
npm run build-dev    # 开发构建
npm run build-prod   # 生产构建
npm run release:patch # 版本号 +1、打 tag、发 GitHub Release
```

### 调试

插件启动时会把日志写到 `/tmp/ra-bootstrap.log`,其中包含构建指纹:

```bash
tail -3 /tmp/ra-bootstrap.log
# [RA ...] SubScript loaded — build 0.1.5 @ 2026-08-03 17:10:43
```

这一行是判断"当前 Zotero 跑的到底是哪个构建"的**唯一可靠依据** —— 开发模式下 Zotero 插件面板显示的版本号会滞后,不要参考它。

## 知识图谱工作流

分析分三步:

1. **单篇画像** —— 从 Zotero 条目与 PDF 全文抽取任务、贡献、方法、数据集、限制与 references。
2. **关系判断** —— 基于结构化画像判断论文间的引用、方法相似、同领域、同数据集、对比等关系。
3. **概念归并** —— 把方法名与数据集名归并成概念节点,形成可浏览网络。

取文策略是 **PDF-first**:

- 有 PDF 时优先使用 Zotero 全文索引;
- 索引缺失时用 Zotero PDFWorker 直接抽取文本;
- PDF 存在但抽不出可读文本时,提示修复 PDF 或重建索引 —— 不会静默降级;
- 只有确实没有 PDF 的条目,才允许用摘要兜底。

## 项目结构

```text
addon/                              插件静态资源(manifest、prefs、locale、bootstrap)
src/sidebar/                        右侧栏聊天界面
src/features/ai-notes/              PDF 便签覆盖层与 AI 编辑器
src/features/knowledge-graph/       知识图谱 UI、状态与分析 pipeline
src/features/wiki/                  知识 Wiki 窗口
src/features/followup/              局部追问窗口
src/features/collection-organizer/  文献集整理
src/modules/llm/                    LLM provider 与统一调用管理
src/modules/zotero/                 Zotero / PDF 读取能力
src/shared/                         设计 token 与共享样式
scripts/                            构建、链接与发布脚本
docs/assets/                        文档图片
```

## 已知限制

- **不自带模型服务**,必须自行配置一个兼容 OpenAI Chat Completions 的 API。
- 知识图谱质量依赖 PDF 全文;只有元数据和摘要的条目分析结果会明显偏弱。
- 便签编辑框内 `Cmd/Ctrl+F` 会触发 Zotero 阅读器自带的查找框 —— Zotero 的监听器先于插件执行,插件侧无法拦截。
- 便签编辑器的视图模式(编辑 / 分栏 / 预览)目前只存在内存中,重启不保留。

## 设计原则

- **阅读不中断** —— 优先侧边栏与就地覆盖层,而不是弹窗式交互。
- **上下文优先** —— 回答尽量落在当前 PDF、选区、注释与 Zotero 元数据上。
- **不静默降级** —— 拿不到 PDF 全文就明确报出,而不是悄悄退回摘要。
- **改动需确认** —— 涉及写入文献库的操作一律先给方案、等确认。
- **视觉统一** —— 紫白主基调,保持轻量、清晰的学术工具感。

## 致谢

本项目基于 [zotero-gpt](https://github.com/MuiseDestiny/zotero-gpt) 的插件思路发展而来,并针对侧边栏阅读、PDF 深度上下文与知识图谱工作流做了重构与扩展。

## License

[AGPL-3.0-or-later](LICENSE) —— 完整许可证正文见 [`LICENSE`](LICENSE),版权与溯源声明见 [`NOTICE`](NOTICE)。以本项目衍生的网络服务同样需要开放源码(AGPL §13)。

问题与建议请提交到 [Issues](https://github.com/yiyabo/zotero-reading-assistant/issues)。

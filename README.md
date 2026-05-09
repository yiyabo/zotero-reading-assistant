# Zotero Reading Assistant

![Zotero Reading Assistant logo](addon/content/icons/logo.png)

紫白色 Zotero 论文阅读助手：在 Zotero 侧边栏中直接和论文、PDF、笔记与知识图谱对话。

![Zotero Reading Assistant interface](docs/assets/introduce.png)

## 简介

Zotero Reading Assistant 是一个面向学术阅读工作流的 Zotero 插件。它把 AI 对话、PDF 上下文读取、图像粘贴、Markdown/LaTeX 渲染和论文知识图谱整合到 Zotero 的右侧栏中，让你可以在不离开文献管理器的情况下完成论文理解、方法梳理和文献关系分析。

项目当前采用统一的紫白色视觉基调，并优先服务深度科研阅读，而不是简单的摘要问答。

## 核心能力

- **侧边栏对话**：在 Zotero 条目面板中持续显示阅读助手，不打断 PDF 阅读。
- **PDF 上下文理解**：读取当前 PDF 的选中文本、注释、元数据和页面内容，用于回答论文相关问题。
- **图片粘贴提问**：可以直接把截图、图表或页面片段粘贴到输入框中，让支持视觉的模型分析。
- **高质量 Markdown 渲染**：支持列表、代码块、表格、引用块和 LaTeX 数学公式。
- **知识图谱分析**：从 Zotero 文献库中构建论文关系、方法概念和数据集概念。
- **PDF 全文优先的 KG Pipeline**：知识图谱分析优先使用 PDF 全文抽取；当 PDF 存在时，不再退回摘要版分析。
- **证据化关系边**：关系和概念连接会尽量保留 evidence、rationale、source fields 等解释信息。
- **可配置 LLM**：通过设置页配置兼容 OpenAI Chat Completions 协议的服务，例如 Qwen DashScope compatible mode。

## 使用场景

- **快速理解论文**：询问核心问题、方法路线、贡献、限制和实验结果。
- **精读 PDF**：针对当前页、选中文本或注释继续追问。
- **检查模型/方法定位**：区分论文是提出方法、使用方法、扩展方法还是仅引用方法。
- **梳理 references**：基于 PDF bibliography 提取关键引用，辅助构建文献关系。
- **构建知识图谱**：把一批 Zotero 文献转化成可浏览的论文-方法-数据集网络。

## 安装与构建

### 依赖

- Node.js
- npm
- Zotero 7 或兼容新版 Zotero 插件系统的版本

### 本地构建

```bash
npm install
npm run build-dev
```

构建产物会生成在：

```text
builds/
```

开发安装可根据项目脚本或 Zotero 开发扩展加载方式进行。

## 配置 LLM

打开 Zotero 插件设置页，填写：

- **API Key**：你的模型服务密钥
- **Base URL**：兼容 Chat Completions 的接口地址
- **Model**：模型名称
- **Temperature**：生成温度
- **Max tokens**：最大输出长度
- **Web search**：如果模型服务支持，可按需开启

示例模型服务可以使用 Qwen DashScope compatible mode。请不要把真实 API Key 写入 README、源码或提交历史。

## 知识图谱工作流

知识图谱模块大致分为三步：

1. **单篇论文画像**：从 Zotero 条目和 PDF 全文中抽取任务、贡献、方法、数据集、限制和 references。
2. **论文关系判断**：基于结构化画像判断论文之间的引用、相似方法、同领域、同数据集、对比关系等。
3. **概念归并**：把方法名和数据集名归并为概念节点，形成可浏览的知识网络。

当前策略是 **PDF-first**：

- 有 PDF 时，优先使用 Zotero full-text index。
- 如果索引缺失，使用 Zotero PDFWorker 直接抽取 PDF 文本。
- 如果 PDF 存在但无法抽出可读文本，会提示修复 PDF 或重建索引。
- 只有没有 PDF 的条目才允许使用摘要作为兜底信息。

## 开发命令

```bash
# 类型检查
npx tsc --noEmit

# 开发构建
npm run build-dev

# 生产构建
npm run build-prod
```

## 项目结构

```text
addon/                         Zotero 插件静态资源
src/sidebar/                   右侧栏聊天界面
src/modules/llm/               LLM provider 与统一调用管理
src/modules/zotero/            Zotero/PDF 读取能力
src/features/knowledge-graph/  知识图谱 UI、状态和分析 pipeline
docs/assets/                   README 和文档图片资源
scripts/                       构建与开发脚本
```

## 设计原则

- **阅读不中断**：优先使用侧边栏，而不是弹窗式交互。
- **上下文优先**：回答必须尽量基于当前 PDF、选区、注释和 Zotero 元数据。
- **质量优先**：知识图谱更重视完整 PDF、references、evidence 和可解释关系。
- **视觉统一**：以紫白色作为主基调，保持轻量、清晰、学术工具感。
- **安全配置**：API Key 只通过本地设置存储，不应硬编码到仓库。

## 致谢

本项目基于 [zotero-gpt](https://github.com/MuiseDestiny/zotero-gpt) 的插件思路继续发展，并针对侧边栏阅读、PDF 深度上下文和知识图谱工作流做了重构与扩展。

## License

AGPL-3.0-or-later

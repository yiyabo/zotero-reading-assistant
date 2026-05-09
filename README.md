# Zotero Reading Assistant

> AI-powered reading assistant sidebar for Zotero

[![License](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

## 📖 Overview

Zotero Reading Assistant is a Zotero plugin that provides an AI-powered sidebar to assist with reading and understanding academic papers. Unlike popup-based tools, it offers a persistent sidebar interface for continuous reading support.

## ✨ Features

- 🎯 **Persistent Sidebar**: Always-visible chat interface that doesn't interrupt your reading
- 💬 **Conversational AI**: Natural dialogue with GPT models about your papers
- 📄 **PDF Context Awareness**: Automatically understands the content you're reading
- 🔍 **Smart Search**: Vector-based similarity search for relevant content
- 📝 **Reading Assistance**: 
  - Summarize sections or entire papers
  - Explain complex concepts
  - Answer questions about the content
  - Translate text
- 🌐 **Multi-LLM Support**: OpenAI GPT-3.5/4 (more models coming soon)
- 🎨 **Markdown Rendering**: Beautiful formatting with LaTeX support

## 🚀 Installation

### From Release (Recommended)

1. Download the latest `.xpi` file from [Releases](https://github.com/yourusername/zotero-reading-assistant/releases)
2. In Zotero, go to `Tools` → `Add-ons`
3. Click the gear icon → `Install Add-on From File`
4. Select the downloaded `.xpi` file

### From Source

```bash
git clone https://github.com/yourusername/zotero-reading-assistant.git
cd zotero-reading-assistant
npm install
npm run build
```

The `.xpi` file will be in the `builds` directory.

## 🔧 Configuration

1. Open Zotero Reading Assistant sidebar
2. Click the settings icon
3. Enter your OpenAI API key
4. Configure other preferences as needed

### Available Settings

- `secretKey`: Your OpenAI API key
- `model`: Model name (gpt-3.5-turbo, gpt-4, etc.)
- `api`: API endpoint URL
- `temperature`: Response randomness (0-2)

## 📚 Usage

### Opening the Sidebar

- Click the Reading Assistant icon in the Zotero toolbar
- Or use keyboard shortcut: `Shift + /`

### Basic Operations

1. **Ask about PDF**: Select text in PDF and ask questions
2. **Summarize**: Request summaries of sections or papers
3. **Explain**: Get explanations of complex terms
4. **Translate**: Translate selected text

### Example Prompts

```
Summarize the main findings of this paper
What methodology did the authors use?
Explain the concept of [term] in simple terms
Translate this paragraph to Chinese
```

## 🙏 Acknowledgments

This project is based on [zotero-gpt](https://github.com/MuiseDestiny/zotero-gpt) by MuiseDestiny.

Key differences from the original:
- Sidebar interface instead of floating window
- Removed proprietary validation system
- Focused on reading assistance workflow
- Simplified command system
- Enhanced conversation management

## 📄 License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

Original project (zotero-gpt) by MuiseDestiny is also licensed under AGPL-3.0.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📮 Support

- Issues: [GitHub Issues](https://github.com/yourusername/zotero-reading-assistant/issues)
- Discussions: [GitHub Discussions](https://github.com/yourusername/zotero-reading-assistant/discussions)

## 🗺️ Roadmap

- [ ] Multi-LLM support (Claude, local models)
- [ ] Enhanced reading context awareness
- [ ] Note-taking integration
- [ ] Citation management
- [ ] Collaborative features
- [ ] Mobile support

---

Made with ❤️ for the academic community

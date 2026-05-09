#!/bin/bash

# Zotero Reading Assistant - 开发模式安装脚本
# 用于在 Zotero 中以开发模式安装插件

set -e

echo "🔧 Zotero Reading Assistant - 开发模式安装"
echo "=========================================="
echo ""

# 插件 ID
ADDON_ID="reading-assistant@zotero-llm.org"

# 获取当前脚本所在目录的绝对路径
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ADDON_PATH="$SCRIPT_DIR/builds/addon"

echo "📁 插件路径: $ADDON_PATH"
echo ""

# 检查 addon 目录是否存在
if [ ! -d "$ADDON_PATH" ]; then
    echo "❌ 错误: 找不到 builds/addon 目录"
    echo "请先运行: npm run build-prod"
    exit 1
fi

# 查找 Zotero profile 目录
ZOTERO_PROFILES_DIR="$HOME/Library/Application Support/Zotero/Profiles"

if [ ! -d "$ZOTERO_PROFILES_DIR" ]; then
    echo "❌ 错误: 找不到 Zotero Profiles 目录"
    echo "路径: $ZOTERO_PROFILES_DIR"
    echo "请确保 Zotero 已安装并至少运行过一次"
    exit 1
fi

# 查找默认 profile（通常是 *.default）
PROFILE_DIR=$(find "$ZOTERO_PROFILES_DIR" -maxdepth 1 -type d -name "*.default" | head -n 1)

if [ -z "$PROFILE_DIR" ]; then
    # 如果没有 .default，尝试找任何 profile
    PROFILE_DIR=$(find "$ZOTERO_PROFILES_DIR" -maxdepth 1 -type d ! -name "Profiles" | head -n 1)
fi

if [ -z "$PROFILE_DIR" ]; then
    echo "❌ 错误: 找不到 Zotero profile 目录"
    echo "请手动查找: $ZOTERO_PROFILES_DIR"
    exit 1
fi

echo "📂 找到 Zotero Profile: $PROFILE_DIR"
echo ""

# 创建 extensions 目录（如果不存在）
EXTENSIONS_DIR="$PROFILE_DIR/extensions"
if [ ! -d "$EXTENSIONS_DIR" ]; then
    echo "📁 创建 extensions 目录..."
    mkdir -p "$EXTENSIONS_DIR"
fi

# 创建扩展代理文件
PROXY_FILE="$EXTENSIONS_DIR/$ADDON_ID"
echo "📝 创建扩展代理文件..."
echo "$ADDON_PATH" > "$PROXY_FILE"

echo "✅ 扩展代理文件已创建: $PROXY_FILE"
echo ""
echo "📄 文件内容:"
cat "$PROXY_FILE"
echo ""

echo "=========================================="
echo "✅ 安装完成！"
echo ""
echo "📋 下一步："
echo "1. 完全关闭 Zotero（如果正在运行）"
echo "2. 重新启动 Zotero"
echo "3. 打开 工具 → 插件，检查是否看到 'Zotero Reading Assistant'"
echo "4. 配置 API（编辑 → 首选项 → 高级 → 配置编辑器）："
echo ""
echo "   extensions.zotero.readingassistant.secretKey"
echo "   sk-756b48f07d1f4a24a87a43e92111dcac"
echo ""
echo "   extensions.zotero.readingassistant.api"
echo "   https://dashscope.aliyuncs.com/compatible-mode"
echo ""
echo "   extensions.zotero.readingassistant.model"
echo "   qwen-max"
echo ""
echo "=========================================="

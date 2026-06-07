# 即梦批量视频生成工具

一键批量将图片提交到[即梦 AI](https://jimeng.jianying.com) 生成视频。

## 功能

- **选择图片文件夹** — 自动读入全部图片，实时预览
- **AI 批量定制提示词** — 接入千问，根据图片内容自动生成延时摄影/航拍等风格化提示词
- **一键批量生成视频** — 通过即梦 CLI 顺序提交，SSE 实时反馈进度
- **登录管理** — 网页端 OAuth Device Flow 登录即梦、退出登录
- **参数灵活配置** — 模型版本、时长、分辨率、画幅比例自由选择

## 快速开始

### 方式一：双击启动（推荐）

双击 `START.command` 即可启动服务器并自动打开浏览器。

### 方式二：终端手动启动

```bash
cd "工具所在文件夹路径"
node dreamina-server.js
```

然后浏览器访问 `http://localhost:8765`

## 依赖

- **Node.js** — 大部分 Mac 已内置，未安装请访问 [nodejs.org](https://nodejs.org)
- **[即梦 CLI](https://jimeng.jianying.com/ai-tool/install)** — 需要安装并登录即梦账号

## 工作流程

1. 启动服务器 → 打开网页
2. 登录即梦（网页端 OAuth 授权）
3. 选择图片文件夹 → 自动加载
4. 填写 AI 提示词生成要求 → 分析图片内容 → 批量生成定制提示词
5. 配置参数（模型/时长/分辨率/画幅）
6. 点击「批量生成视频」→ 服务端顺序提交 → 视频输出到图片同目录下的 `output/` 文件夹

## 项目结构

```
即梦批量生视频/
├── START.command              # 一键启动
├── dreamina-server.js         # Node.js 服务端
└── 即梦批量视频生成工具_v1.html # 前端页面
```

## 技术实现

- **前端** — 原生 HTML/CSS/JS，GSAP 动画，无需框架
- **后端** — Node.js 内置 http 模块，零依赖
- **通信** — RESTful API + SSE 实时推送
- **AI 提示词** — 千问（DashScope）图片识别 + 提示词生成
- **视频生成** — 即梦 CLI `multimodal2video` + `query_result`

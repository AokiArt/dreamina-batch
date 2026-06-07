---
name: batch-video-generator-v2
description: 四段式管道：①获取分镜头脚本(人工确认)→②获取参考图(人工审核)→③生成(含内部重试+完成度校验)→④拼接。输入视频/图片/文档/文本均可。
metadata:
  tags: video, batch, dreamina, grok, ai-generation, storyboard, video-analysis, pipeline
---

# Batch Video Generator V2

四段式管道，每阶段有明确目标，阶段分割点卡在人工干预节点：

**① 获取分镜头脚本 → ② 获取参考图 → ③ 生成（含内部重试） → ④ 拼接**

---

## 统一数据格式

阶段1 产出 `storyboard.json`，阶段2 产出 `ref_frames/`，阶段3 消费这两者。

### storyboard.json

> **说明**：`raw_analysis.json` 是千问 VL 的原始输出（仅含 overview + shots 的描述字段）。
> `storyboard.json` 是完整版 = `raw_analysis.json` + Claude 生成的 `image_prompt` / `video_prompt`。
> `grouping` 不在阶段1生成，若需分组在阶段3处理。

```json
{
  "overview": {
    "title": "视频标题",
    "script": "整体剧本描述（叙事结构、各阶段逻辑、情绪递进）",
    "style": "全局视觉风格",
    "color_palette": ["主色1", "主色2"],
    "overall_rhythm": "整体节奏描述"
  },
  "shots": [
    {
      "id": 1,
      "timecode": "00:00-00:03",                // MM:SS
      "duration_sec": 3.2,
      "shot_type": "景别",
      "composition": "构图方式（含元素位置信息）",
      "colors": "色调光影（含光源方向、光照情况、明暗对比）",
      "content": "中文画面详细描述",
      "dynamics": "动态元素",
      "vfx": "视觉特效和包装（粒子、光效、烟雾等）",
      "camera_movement": "运镜方式",
      "transition": "本镜头结尾到下一个镜头之间的转场描述（最后一个为空）",
      "image_prompt": "Claude生成的图片提示词（中文，侧重静态画面）",
      "video_prompt": "Claude生成的视频提示词（中文，侧重动态/运镜/转场）"
    }
  ],
  "meta": {
    "total_duration_sec": 44.3,
    "total_shots": 11,
    "source_type": "video|images|storyboard_doc|text_prompt",
    "has_reference_frames": false
  }
}
```

### ref_frames/

每个镜头一张参考图，命名 `shot_01.jpg`, `shot_02.jpg`...

---

## 阶段总览

```
用户输入（视频/图片+模板/分镜文档/纯文本创意）
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段1: 获取分镜头脚本（目标：storyboard.json 定稿）              │
│                                                             │
│  1A 视频          → 千问VL分析                                │
│  1B 图片+模板     → 千问VL逐张填充                             │
│  1C 分镜文档      → 解析(文本/Excel/Word)                      │
│  1D 纯文本创意    → 分析意图 + 展开                             │
│                                                             │
│  → ⏸ 人工审核确认（无明确指令时暂停，有"直接做完"则跳过）         │
│  → 输出定稿 storyboard.json                                  │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ storyboard.json 定稿
┌─────────────────────────────────────────────────────────────┐
│ 阶段2: 获取参考图（目标：ref_frames/ 完整）                     │
│                                                             │
│  2A 原始是视频 → 从原视频截帧 + 默认去水印                        │
│  2B 原始是图片 → 图片本身作为参考帧（默认不去水印）                 │
│  2C 原始是文档/文本 → dreamina text2image（用 image_prompt）     │
│                                                             │
│  去水印：统一中文提示词，按原图比例，2K，每镜头1张                   │
│  文生图：默认执行，仅"不用生图"时才跳过                             │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ ref_frames/ 产出
┌─────────────────────────────────────────────────────────────┐
│ 🔍 阶段2 出口：生图任务完整性检测 → 格式校验 → 人工审核            │
│  □ 循环检测 dreamina 生图任务，失败自动重试直至全部成功            │
│  □ 输出校验报告（每个镜头有图/有prompt，打勾打叉）                  │
│                                                             │
│  格式不通过 → 报告缺失 → 询问用户（无论何时都暂停）                │
│  格式通过 → ⏸ 展示参考图 → 人工审核图片质量                        │
│    · 无明确指令 → 暂停询问                                       │
│    · 用户确认/有明确指令 → 进入阶段3                              │
│    · 用户要求修改某张图 → 重新生成该镜头参考图 → 再次审核           │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ 校验通过 + 人工确认
┌─────────────────────────────────────────────────────────────┐
│ 阶段3: 生成（含内部重试 + 兜底链）                                │
│                                                             │
│  默认：Dreamina Web，逐镜头 image2video，shot.duration_sec      │
│  分组：仅用户明确提出时，multi image2video + 合并时长              │
│  积分：>1000 暂停确认                                           │
│                                                             │
│  → 逐镜头提交 → 监控 → 下载                                     │
│  → 失败重试 3 次 → 仍失败换 Grok 兜底                            │
│  → Grok 也失败 → 标记 ❌                                       │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ 全部生成完毕
┌─────────────────────────────────────────────────────────────┐
│ 🔍 阶段3 出口：完成度校验 + 人工决策                             │
│  □ 所有镜头是否全部生成成功？                                     │
│                                                             │
│  全部成功 → 自动进入阶段4                                      │
│  有失败项 → ⏸ 暂停，列出失败原因，询问用户：                     │
│    1. 不管失败项，直接用已成功的视频拼接                         │
│    2. 倒置提示词后用 Grok 再试一次                               │
│    3. 手动修改提示词后重新生成失败项                               │
└─────────────────────────────────────────────────────────────┘
        │
        ▼ 用户确认拼接
┌─────────────────────────────────────────────────────────────┐
│ 阶段4: 拼接                                                   │
│  ffmpeg concat → 最终汇总输出                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 阶段1: 获取分镜头脚本

**目标**：不管输入是什么，产出经人工确认的定稿 `storyboard.json`。

**通用流程**：识别输入类型 → 对应方式产出脚本 → ⏸ 人工审核 → 定稿

---

### 1A: 视频 → 千问VL分析

#### 1A.1 视频预检：获取信息 + 文件大小判断

```bash
ffprobe -v error -show_entries format=duration,size,bit_rate \
  -show_entries stream=width,height,r_frame_rate \
  -of json "<video_path>"
```

提取关键参数：`duration`（秒）、`size`（字节）、`width×height`、`fps`。

**计算画面比例**：`width / height` → 映射到最接近的预设比例。

比例映射表（按 width/height 值从窄到宽）：
| 比例 | 比值 | 说明 |
|------|------|------|
| 1:1 | 1.0 | 正方形 |
| 3:4 | 0.75 | 竖屏 |
| 4:3 | 1.33 | 传统横屏 |
| 9:16 | 0.56 | 手机竖屏 |
| 16:9 | 1.78 | 标准宽屏 |
| 21:9 | 2.33 | 超宽屏 |

选取规则：计算 `w/h`，找到比值差最小的预设。若差值相等则选更宽的。
此比例用于阶段2生图和阶段3生视频的 `--ratio` 参数。**不在提示词中写比例关键词**。

#### 1A.2 视频预检 + 智能压缩

**千问 VL 视频上传限制**（通过 API 实际查询 `get_upload_certificate` 确认）：

| 项目 | qwen3-vl-plus | 说明 |
|------|-------------|------|
| SDK 临时上传上限 | **1024 MB** | `max_file_size_mb: 1024`，OSS policy `content-length-range: 0-1073741824` |
| 推荐安全值 | **300 MB** | 上传超时 300s，控制在 300MB 以内保证上传速度 |
| 视频时长上限 | 1 小时 | 原生视频理解，支持 fps 参数控制帧采样 |

**压缩规则**：

1. 获取视频参数：宽度、高度、文件大小
2. 短边 < 720px 且文件 ≤ 300MB → 直接发送
3. 短边 ≥ 720px → 压缩到 720p
4. 文件 > 300MB → 压缩到 300MB 以内

#### 1A.3 发送视频给千问 VL 分析

qwen3-vl-plus 拥有 256K 上下文和 32K+ 输出限制，**一般情况下不需要分段**，直接全视频发送即可。

```python
from dashscope import MultiModalConversation

response = MultiModalConversation.call(
    api_key=DASHSCOPE_KEY,
    model="qwen3-vl-plus",
    messages=[{"role": "user", "content": [
        {"video": f"file://{VIDEO_PATH}"},
        {"text": ANALYSIS_PROMPT}
    ]}],
    temperature=0.3,
    max_tokens=32768
)
```

#### 1A.4 分析提示词模板（精简版，中文为主）

千问只负责**画面描述 + 动态识别 + 元素识别 + 特效识别**，不生成 prompts、不分组、不输出英文。

#### 1A.5 JSON 修复 + 保存

```python
import re, json

text = response_text[text.find('{'):text.rfind('}')+1]
text = re.sub(r'}\s*\n\s*{', '},\n    {', text)
text = re.sub(r',\s*}', '}', text)
text = re.sub(r',\s*]', ']', text)
raw_data = json.loads(text)
```

保存千问原始返回为 `raw_analysis.json`。`meta.source_type = "video"`。

#### 1A.6 后备：分段循环（覆盖率不足时自动触发）

#### 1A.7 Claude 本地生成完整 storyboard.json

千问返回 `raw_analysis.json`（仅含 overview + shots 的描述字段）之后，**由 Claude 在本地完成以下工作**：

**输入**：千问返回的 `raw_analysis.json`
**输出**：完整的 `storyboard.json`（含 image_prompt、video_prompt）

**核心原则**：

两个提示词都基于千问返回的画面描述字段，但**侧重点不同**：
- `image_prompt`：侧重**静态画面**，从零生成一张图，需要详细的画面内容描述
- `video_prompt`：侧重**动态表现**，在已有画面的基础上描述运动，但也需要一部分画面描述来支撑运动方向

> 两者有重叠是正常的，AI 参与生成时根据各自侧重自动调整，不做机械拼接。

**Claude 生成六步**：
1. 读取 overview 全局约束
2. 去水印/Logo/字幕过滤
3. 生成 image_prompt（侧重静态）
4. 生成 video_prompt（侧重动态，含音效描述规则）
5. 全局 script 对提示词的影响（开场→暗调缓慢等）
6. 组装 storyboard.json

---

### 1B: 图片 → 千问分析 + 生成分镜脚本

### 1C: 分镜文档 → 解析

| 子场景 | 输入 | 处理 |
|--------|------|------|
| C1 文本脚本 | `序号｜画面｜运镜` 格式 | 直接解析分隔符 |
| C2 Excel | `.xlsx` | `openpyxl` 读取表格 |
| C3 Word | `.docx` | `python-docx` 提取文本/表格 |

### 1D: 纯文本创意 → 展开构造

### ⏸ 人工审核（阶段1 出口）

**跳过审核触发词**：`直接做完` `不用看脚本` `不用审核` `跳过审核` `跳过人工` `跳过脚本审核` `直接继续` `全部做完` `自动继续`

---

## 阶段2: 获取参考图

**目标**：基于定稿 storyboard.json，为每个镜头产出一张参考图 → `ref_frames/`。

### ⚠️ 跳过阶段2

若用户初始指令中包含以下关键词，**跳过整个阶段2**，直接从阶段1进入阶段3：

触发词：`文生视频` `不要参考图` `不用生图` `不用参考图` `不用截图` `纯文字生成` `text2video` `text to video` `不要图`

### 2A: 原始是视频 → 从原视频截帧 + 默认去水印

### 2B: 原始是图片 → 图片本身（默认不去水印）

### 2C: 原始是文档/纯文本 → 文生图（默认）

### 去水印统一模板

```
保持原图画面内容完全不变，去除图片中的水印、logo、字幕，画面清晰干净
```

---

## 阶段2 出口：生图任务完整性检测 + 格式校验 + 人工审核

### 第零步：生图任务完整性检测（循环重试，不设上限）

### 第一步：格式校验

⚠️ **规则**：格式校验不通过**无论何时都暂停** → 根据报告定位缺失项 → 询问用户

### 第二步：人工审核图片质量

**跳过审核触发词**：`直接做完` `不用审核` `跳过审核` `跳过人工` `不用看` `直接继续` `全部做完` `自动继续`

---

## 阶段3: 生成

### 3.0 默认流程（无明确指令时）

| 项目 | 默认值 |
|------|--------|
| 后端 | **Dreamina Web**（浏览器操控） |
| 生成方式 | 有参考图 → `image2video` / 无参考图（跳过阶段2）→ `text2video` |
| 单位 | **按单个分镜头逐一生成**，时长 = `shot.duration_sec` |
| 画幅 | 取阶段1计算的**最接近预设比例** |
| 分辨率 | 720p |
| 模型 | seedance2.0 |

### 3.0.1 积分阈值检查

| 总积分 | 行为 |
|--------|------|
| ≤ 1000 | 直接生成 |
| > 1000 | ⏸ 暂停，提示人工确认后再继续 |

### 3.1 生成模式

#### 模式 A: text2video（文生视频）
#### 模式 B: image2video（图生视频）—— 默认
#### 模式 C: multi image2video（多图生视频，仅分组时）

### 3.2 统一后端参数

| 参数 | Dreamina (CLI / Web) | Grok |
|------|---------------------|------|
| 模型 | seedance2.0 / fast | — |
| 画幅 | 1:1 / 3:4 / 16:9 / 4:3 / 9:16 / 21:9 | 2:3 / 3:2 / 1:1 / 9:16 / 16:9 |
| 分辨率 | 480p / 720p / 1080p | 480p / 720p |
| 时长 | 4s / 6s / 8s / 10s / 12s | 6s / 10s |
| text2video | ✅ | ✅ |
| image2video | ✅ | ✅ |

### 3.3 Dreamina CLI

### 3.4 Dreamina Web（默认后端）

Playwright CDP 浏览器自动化，控制 `dreamina.capcut.com` 国际版网页。

自动化脚本：`dreamina_web_automation.py`（本 skill 目录下）。

#### 前置条件
- Chrome 运行并开启 `--remote-debugging-port=9222`
- 用户需在 CDP Chrome 实例上**已登录** Dreamina 国际版
- Playwright Python: `pip install playwright`

#### 工具栏布局（从左到右）

| Element | Type | Combobox Index | Description |
|---------|------|---------------|-------------|
| AI 影片 | `lv-select` | `nth(0)` | Mode selector |
| Model (Dreamina Seedance 2.0) | `lv-select` | `nth(1)` | **Model selector** |
| 全方位參考 | `lv-select` | `nth(2)` | Reference type |
| 16:9 | `button` | — | Aspect ratio button |
| 8s | `lv-select` | `nth(3)` | **Duration selector** |
| Bookmark | `button` | — | Save/bookmark |
| Credits | `div` | — | Credit cost display |
| Submit | `button` | — | White circle, up-arrow icon |

### 3.5 Grok（兜底后端）

Chrome CDP 9222 → navigate `grok.com/imagine` → imagine video → upload → prompt → submit → monitor → download。

**Grok 仅作为兜底**：Dreamina 反复失败（非瞬时错误）后才用 Grok 重试。

### 3.6 逐镜头重试 + 兜底链

1. 提交 Dreamina → 监控 → 下载
2. 瞬时错误 → 同模型重试最多 3 次
3. 非瞬时错误 → 换 Grok 兜底（不倒置提示词）
4. Grok 也失败 → 标记 ❌

---

## 阶段3 出口：完成度校验 + 人工决策

- **全部成功** → 自动进入阶段4
- **有失败项** → ⏸ 暂停，提供 3 个选项

---

## 阶段4: 拼接

```bash
echo "file '<output_dir>/01.mp4'
file '<output_dir>/02.mp4'..." > concat_list.txt
ffmpeg -f concat -safe 0 -i concat_list.txt -c copy <combined>.mp4 -y
```

---

## 用户指令判断规则

1. **有明确指令** → 严格按指令，不在中间询问
2. **无明确指令** → 每个阶段结束后询问
3. **例外**（以下情况无论何时都暂停）：
   - 格式校验不通过（阶段2出口第一步）
   - 阶段3 积分阈值 > 1000（除非用户说"不管积分"）
   - 阶段3出口有失败项
4. **跳过阶段2**：用户指令含文生视频相关关键词

---

## 关键常量

```
DREAMINA = "/Users/aoki/.local/bin/dreamina"
DASHSCOPE_KEY = "sk-6c78b940401948cc82797d86074c95cb"
Qwen VL 模型 = "qwen3-vl-plus"
Qwen VL 视频上传上限 = 1024 MB
视频压缩阈值 = 300 MB
视频分辨率上限 = 720p (短边)
Dreamina 默认模型 = "seedance2.0"
参考帧截取偏移 = +1s
Dreamina Web 自动化脚本 = dreamina_web_automation.py
Chrome CDP 端口 = 9222
```

## 相关 Skill

- `dreamina-batch`: 图片文件夹 → 千问分析 → dreamina 命令
- `grok-video-batch`: Grok 浏览器自动化
- `prompt-optimizer`: 提示词优化和倒置
- `dreamina-cli`: Dreamina CLI 基础操作
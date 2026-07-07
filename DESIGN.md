# Design

## Overview

ProjectFlow 是一个面向大学生团队的项目管理工具，采用简洁、智能、高效的产品型设计方向。视觉系统以清晰的层级和克制的装饰为核心，让 AI 推进的工作流程成为焦点。

## Theme

- **Mode**: Light default, dark supported via `dark` class
- **Strategy**: Restrained — tinted neutrals + one accent ≤10%
- **Character**: 清爽的产品界面，蓝色主调传递专业可信，金色点缀标记 AI 提案和高亮状态

## Colors

### Brand

| Token | Value | OKLCH | Usage |
|-------|-------|-------|-------|
| `--color-primary-token` | `#2d6dc3` | oklch(52% 0.12 255) | 品牌色、主按钮、链接、当前状态 |
| `--color-primary-strong-token` | `#0066ff` | oklch(58% 0.18 255) | Hover、强强调 |
| `--color-primary-light-token` | `#8fb9ff` | oklch(75% 0.1 255) | 柔和强调、背景 tint |
| `--color-accent-token` | `#fad13b` | oklch(85% 0.14 95) | Badge、高亮、AI 提案标记 |
| `--color-accent-light-token` | `#faeb75` | oklch(90% 0.12 95) | 柔和 accent 状态 |

### Background

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg-primary-token` | `#fdfaf5` | 页面画布（warm off-white，但 chroma 极低，避免奶油风） |
| `--color-bg-secondary-token` | `#ffffff` | 卡片、面板 |
| `--color-bg-primary-light-token` | `#faf9f5` | 嵌套表面 |
| `--color-bg-primary-deep-token` | `#fefcf4` | 温暖嵌套表面 |
| `--color-bg-primary-dark-token` | `#0b1220` | 深色画布 |
| `--color-bg-secondary-dark-token` | `#0f1b2d` | 深色卡片、面板 |

### Text

| Token | Value | Usage |
|-------|-------|-------|
| `--color-text-primary-token` | `#19222f` | 主标题 |
| `--color-text-secondary-token` | `#3f4a5a` | 正文 |
| `--color-text-tertiary-token` | `#7a6550` | 弱化元数据 |
| `--color-text-primary-dark-token` | `#f7f9fc` | 深色模式标题 |
| `--color-text-secondary-dark-token` | `#c5cedb` | 深色模式正文 |
| `--color-text-tertiary-dark-token` | `#9bb3d7` | 深色模式弱化文字 |

### Neutral Scale

| Token | Value |
|-------|-------|
| `--color-neutral-50` | `#f7f9fc` |
| `--color-neutral-100` | `#edf1f8` |
| `--color-neutral-200` | `#dfe4ed` |
| `--color-neutral-300` | `#c5cedb` |
| `--color-neutral-400` | `#92a1b7` |
| `--color-neutral-500` | `#677487` |
| `--color-neutral-600` | `#4f5a6d` |
| `--color-neutral-700` | `#3f4a5a` |
| `--color-neutral-800` | `#2c3542` |
| `--color-neutral-900` | `#19222f` |
| `--color-neutral-950` | `#10161f` |

### Semantic Mapping (shadcn/ui)

| Token | Light | Dark |
|-------|-------|------|
| `--background` | `#fdfaf5` | `#0b1220` |
| `--foreground` | `#3f4a5a` | `#c5cedb` |
| `--card` | `#ffffff` | `#0f1b2d` |
| `--primary` | `#2d6dc3` | `#3884eb` |
| `--secondary` | `#faf9f5` | `#101a2b` |
| `--muted` | `#edf1f8` | `#172235` |
| `--accent` | `#fad13b` | `#fad13b` |
| `--destructive` | `#dc4f5f` | `#f06b7a` |
| `--border` | `#dfe4ed` | `rgb(197 206 219 / 16%)` |
| `--ring` | `rgb(45 109 195 / 45%)` | `rgb(56 132 235 / 55%)` |
| `--radius` | `0.75rem` | — |

## Typography

### Font Families

| Role | Font | Fallback |
|------|------|----------|
| Display | Instrument Serif | Georgia, serif |
| Body | Inter | system-ui, sans-serif |

### Scale

| Level | Size | Weight | Usage |
|-------|------|--------|-------|
| Hero | `clamp(2.5rem, 5vw, 4rem)` | 400 | 页面主标题 |
| H1 | `clamp(1.75rem, 3vw, 2.5rem)` | 600 | 章节标题 |
| H2 | `clamp(1.25rem, 2vw, 1.5rem)` | 600 | 子章节 |
| H3 | `1.125rem` | 500 | 卡片标题、面板标题 |
| Body | `1rem` | 400 | 正文 |
| Small | `0.875rem` | 400 | 辅助文字、标签 |
| Caption | `0.75rem` | 400 | 元数据、时间戳 |

### Rules

- Display font 仅用于页面级或主要章节标题
- Body font 用于正文、表单、表格、标签、紧凑面板
- 紧凑 UI 标题小于 Hero 标题
- 默认不使用负 letter-spacing
- `text-wrap: balance` 用于 h1–h3
- `text-wrap: pretty` 用于长文本段落

## Layout

### Containers

| Class | Value | Usage |
|-------|-------|-------|
| `.site-container` | `max-width: 1200px` + 水平 padding | 主页面布局 |
| `.inner-container` | `max-width: 800px` + 水平 padding | 窄内容 |

### Spacing Scale

Base: `0.25rem` (4px)

| Token | Value |
|-------|-------|
| `space-1` | `0.25rem` |
| `space-2` | `0.5rem` |
| `space-3` | `0.75rem` |
| `space-4` | `1rem` |
| `space-6` | `1.5rem` |
| `space-8` | `2rem` |
| `space-12` | `3rem` |
| `space-16` | `4rem` |
| `space-20` | `5rem` |

### Rules

- Flexbox 用于 1D 布局，Grid 用于 2D
- 响应式网格：`repeat(auto-fit, minmax(280px, 1fr))`
- 卡片圆角 ≤ `16px`（`--radius: 0.75rem`）
- 按钮/标签可用 pill（全圆角）
- 避免嵌套卡片

## Components

### Button

| Variant | Style |
|---------|-------|
| Primary | `bg-primary text-white hover:bg-primary-strong` |
| Secondary | `bg-neutral-100 text-neutral-800 hover:bg-neutral-200` |
| Outline | `border border-neutral-200 bg-transparent hover:bg-neutral-50` |
| Ghost | `bg-transparent hover:bg-neutral-50` |
| Destructive | `bg-destructive text-white hover:bg-red-600` |

### Card

- 背景：`--card`
- 边框：`1px solid var(--border)` 或无边框（根据层级）
- 圆角：`var(--radius)`（12px）
- 阴影：仅在需要提升层级时使用，避免 `box-shadow + border` 同时装饰

### Input / Form

- 边框：`var(--border)`
- Focus：`ring-2 ring-primary/30`
- 标签：始终可见，不依赖 placeholder
- 错误状态：边框变 destructive，下方显示错误文字

### Badge

| Variant | Style |
|---------|-------|
| Default | `bg-primary/10 text-primary` |
| Accent | `bg-accent/25 text-yellow-700` |
| Success | `bg-emerald-100 text-emerald-600` |
| Warning | `bg-destructive/10 text-destructive` |

## Motion

### Principles

- 动画是设计的一部分，不是事后添加
- 不动画 CSS 布局属性（width、height、top、left）
- 使用 ease-out 指数曲线（ease-out-quart / quint / expo）
- 每个动画需要 `@media (prefers-reduced-motion: reduce)` 替代方案

### Patterns

| Pattern | Implementation |
|---------|----------------|
| Page enter | Framer Motion `initial={{ opacity: 0, y: 24 }}` `animate={{ opacity: 1, y: 0 }}` |
| Stagger list | `transition={{ staggerChildren: 0.05 }}` |
| Hover | `transition: transform 0.2s ease-out` |
| Modal | `AnimatePresence` + fade + scale |

## Z-Index Scale

| Layer | Value |
|-------|-------|
| Dropdown | 10 |
| Sticky header | 20 |
| Modal backdrop | 30 |
| Modal | 40 |
| Toast | 50 |
| Tooltip | 60 |

## Responsive Breakpoints

| Name | Width |
|------|-------|
| sm | 640px |
| md | 768px |
| lg | 1024px |
| xl | 1280px |

## Files

- `src/styles/globals.css` — CSS variables、全局样式、容器 helper
- `tailwind.config.ts` — Tailwind v3 token bridge
- `src/app/layout.tsx` — 字体和根 metadata

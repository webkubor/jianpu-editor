# jianpu-editor

丝滑的网页简谱（numbered musical notation）编辑器。逆向 [numerical-notation-editor](https://github.com/mattuylee/numerical-notation-editor) 的排版原理后全部重写（零运行时依赖：Vite + TypeScript）。

## 核心思路

1. **一切皆符号**：音符 / 延音线 / 小节线统一为扁平 `Notation` 节点，渲染、播放、DSL 投影共享同一数据源。
2. **节拍分组推断时值**：存储层只存显式属性，空格分组的 n 个音在编译层平分一拍（自动 n-1 条减时线）——输入成本砍到最低。
3. **SVG 纯文本排版**：不用音符字体，数字 + 圆点 + 横线直接画，canvas measureText 测宽、段落两端对齐。
4. **Web Audio 回放**：正弦 + 泛音合成，Enter 试听。

## 键盘

| 键 | 作用 |
|---|---|
| `1`–`7` | 音符（继承前音八度） |
| `空格` | 延音线 |
| `\|` | 小节线 |
| `←→` / `↑↓` | 移动光标 / 换段 |
| `+` / `-` | 高低八度 |
| `.` | 附点 |
| `⌘Z` | 撤销 |
| `Enter` | 播放 / 停止 |

## DSL

```
6, 1 2 3  5 - 3 | 2 - - ‖
```

空格 = 拍内分组；**双空格 = 拍边界**；`-` 延音；`~` 连音线；`,` 低八度、`'` / `^` 高八度；`#` / `b` 变音；`.` 附点。

## 开发

```bash
npm install
npm run dev      # http://localhost:5196
npm test         # node --test，15 个核心层用例
npm run build    # tsc + vite 生产构建
```

## 结构

```
src/core/    model / transpose / dsl / player / serialize —— 纯逻辑，可单测
src/render/  svg-render —— 排版渲染
src/app/     editor-state / main —— 状态与壳
```

## License

MIT

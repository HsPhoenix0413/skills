# Skills

保存在各个 AI Agent 下的 skill 集合，用于在新电脑上快速部署。

## 仓库结构

```
skill/
├── zcode/         # ZCode
│   ├── global/    # 复制到 ~/.zcode/skills/（zcode 用户级全局 skill）
│   └── agents/    # 复制到 ~/.agents/skills/（.agents 共享 skill 目录，zcode 会自动加载）
├── opencode/      # OpenCode
├── pi/            # Pi
├── dsh/           # DSH
├── antigravity/   # Antigravity
└── claudecode/    # Claude Code
```

## 新电脑部署

### ZCode

Linux / macOS（或 Windows Git Bash）：

```bash
git clone https://github.com/HsPhoenix0413/skills.git
cp -r skills/skill/zcode/global/* ~/.zcode/skills/
cp -r skills/skill/zcode/agents/* ~/.agents/skills/
# imgfetch 需要重建 node 依赖（仓库不含 node_modules）
cd ~/.agents/skills/imgfetch && npm install
```

Windows PowerShell：

```powershell
git clone https://github.com/HsPhoenix0413/skills.git
Copy-Item -Recurse -Force skills/skill/zcode/global/* $HOME\.zcode\skills\
Copy-Item -Recurse -Force skills/skill/zcode/agents/* $HOME\.agents\skills\
Push-Location $HOME\.agents\skills\imgfetch; npm install; Pop-Location
```

### 其他 Agent

各目录暂为空占位，后续有对应 agent 的 skill 时放入即可，部署方式待补充。

## 当前收录

| Agent | Skill | 说明 |
|---|---|---|
| zcode | cocoloop | skill 安装 / 管理 / 安全检查 |
| zcode | grill-me | 通过连环追问打磨方案或设计 |
| zcode | grilling | 对计划、决策进行高压拷问式检验 |
| zcode | readme-generator | 分析项目结构生成 README |
| zcode (.agents) | imgfetch | 从多级跳转落地页中提取隐藏图片资源 |

## 维护约定

- 仓库不依赖本地某个固定目录同步，改动哪个 skill 就把该 skill 文件夹整个覆盖上传。
- `node_modules` 等可重建的依赖目录不上传，靠 `package.json` / `package-lock.json` 还原。

<div align="center">

<img src="assets/umiro-header.png" alt="Umiro" width="700">

[English](README.md) · **繁體中文**

**可自行託管、在 Discord 與終端機中運作的個人 AI 助理。**

[![version](https://img.shields.io/badge/version-0.1.0-blue)](package.json)
[![node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

Umiro 透過可設定的 LLM 連線 profile 執行不綁定特定協議的 agent loop，並提供本機 workspace 與工具。它能跨對話保留實用的上下文，同時讓資料儲存位置仍由使用者掌控。

> [!WARNING]
> Umiro 可以執行 shell 指令及存取已連結的服務。請只在你信任的基礎設施與 Discord 伺服器上執行，並在開放給其他使用者前仔細檢查設定。

## 功能特色

| | |
|---|---|
| **兩種前端** | Discord（提及、owner 私訊、ambient channels）與互動式本機 CLI |
| **持久上下文** | 各頻道獨立 session、對話歸檔、每日記憶與長期記憶 |
| **Workspace 優先** | Persona、操作指令、人員紀錄、skills、記憶與產生的檔案都存放在 `workspace/` |
| **工具** | 檔案、shell、Discord 管理與訊息、排程、提醒、天氣，以及 Google Calendar／Gmail／Drive／Tasks |
| **可擴充** | 可安裝的 workspace skills 與本機私人 plugins |
| **完整性保護** | Soul Guardian 監控受保護的 workspace 檔案 |
| **易讀日誌** | 每個本機日期一份檔案：`logs/umiro-YYYY-MM-DD.log` |

架構與資料流請見 [docs/DESIGN.md](docs/DESIGN.md)。工具活動訊息庫請見 [docs/TOOL_ACTIVITY.md](docs/TOOL_ACTIVITY.md)。若要建立私人工具整合，請見 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 系統需求

- Node.js 24 以上版本及 npm
- OpenAI API key，或任何支援 function calling 並實作 `POST /v1/chat/completions` 或 `POST /v1/responses` 的相容 endpoint
- 若要使用 Discord 前端，需要 Discord application token
- Linux 與 systemd：非必要，但建議用來將 gateway 作為服務執行

## 快速開始

```bash
git clone <repo-url> ~/.umiro
cd ~/.umiro

# Install dependencies, create local templates, register `umiro`,
# and install a systemd service when the host supports it.
npx tsx bin/umiro.ts install

# Fill in credentials and runtime settings.
$EDITOR .env
$EDITOR config.yaml

# Save your Discord user ID and, optionally, a first allowed channel.
umiro onbord

# Start the gateway in the foreground.
umiro gateway
```

`umiro install` 不會覆寫既有的設定或 workspace 檔案，因此可安全地重複執行。

> [!NOTE]
> 第一次使用 Discord 前，請先在本機執行 `umiro onbord`。這個指令會明確寫入 `discord.owner_id`，而不是直接信任第一位接觸 gateway 的使用者。Owner 偏好的稱呼方式與助理 persona，則會在第一次 Discord 對話中私下收集。

## 設定

### `.env`：憑證

```dotenv
# Required for model access
LLM_API_KEY=
# Empty uses https://api.openai.com/v1; otherwise an OpenAI-compatible `/v1` base URL.
LLM_BASE_URL=

# Required only when Discord is enabled
DISCORD_TOKEN=

# Optional: semantic memory recall with Gemini embeddings
GOOGLE_API_KEY=

# Optional: Google Calendar, Gmail, Drive, and Tasks tools
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

> [!CAUTION]
> 絕對不要提交 `.env`、`config.yaml` 或 `workspace/`。這些路徑預設已被忽略，因為其中包含密鑰與助理的私人資料。

### `config.yaml`：行為與存取控制

請從 `config.example.yaml` 開始設定。第一次啟動前，建議先檢查以下項目：

```yaml
timezone: "Asia/Taipei"

llm:
  active_profile: "local-gateway"
  maxContextTokens: 150000
  memoryCharLimit: 3000
  profiles:
    local-gateway:
      protocol: "openai_chat_completions"
      baseUrl: "${LLM_BASE_URL}"
      apiKey: "${LLM_API_KEY}"
      auth: "bearer"
      model: "claude-sonnet-4-6"
      reasoningEffort: "default"
      tokenLimitField: "max_completion_tokens"
      capabilities:
        vision: true
        function_tools: true
        responses: true
        hosted_web_search: true
        hosted_image_generation: true
        hosted_code_execution: false
```

`timezone` 會影響時間戳記、記憶檔名與日記日期。留空時會使用主機的時區。

**連線 profiles。** Active profile 會分別指定 wire protocol、gateway URL、驗證方式、預設 model ID、token limit 欄位，以及可用的 hosted capabilities。建立 session 時，系統會保存當時 profile 的模型與 reasoning effort；因此 `/model` 只會更改目前 Discord session，其他頻道、討論串、私訊、CLI session 與背景 session 都會保留各自的選擇。

Model ID 會透過該 session endpoint 的 `GET /models` 取得，不需要在設定中重複列出。若相容伺服器未在 discovery 結果中列出 alias，仍可手動輸入 model ID。正式支援互動對話的 adapters 是 `openai_chat_completions` 與 `openai_responses`。兩者都以標準 OpenAI-compatible contract 為目標，而非綁定特定 gateway 實作；支援 bearer 驗證與受信任的免驗證 endpoint，供應商特有的擴充則必須由 profile 明確宣告。只有 active profile 明確宣告 Responses capabilities 時，才會開放對應的 hosted 功能；Umiro 不會在背景自行切換 profile 或模型。

## 執行方式

| | |
|---|---|
| `umiro gateway` | 以前景模式啟動 gateway，適合開發環境或沒有 systemd 的主機 |
| `umiro` | 互動式本機 CLI；`new` 會歸檔對話，`exit` 會離開 |
| `sudo systemctl {start,stop,restart,status} umiro` | 控制服務 |
| `journalctl -u umiro -f` | 持續查看服務輸出 |

Installer 只會在偵測到 systemd 的 Linux 主機上建立 `umiro.service`。自訂 unit file 後，請先執行 `sudo systemctl daemon-reload` 再重新啟動。

### 日誌

應用程式日誌會寫入 `logs/umiro-YYYY-MM-DD.log`，每個本機日期一份。Gateway 不必重新啟動，系統便會在本機午夜建立新檔；既有檔案只會接續寫入，不會被覆蓋。

```text
[2026-08-21 09:04:52] INFO: discord trigger {"sessionId":"...","author":"owner"}
```

`LOG_LEVEL` 控制日誌詳細程度。預設值是 `debug`；若平常不需要工具層級的診斷資訊，可改用 `info`。

```bash
LOG_LEVEL=info umiro gateway
```

## Discord

Umiro 會在被提及時回應，也能在 `discord.ambient_channels` 列出的頻道中不經提及直接回覆。討論串不會繼承 parent channel 的 ambient 行為。

| 指令 | 說明 | 權限 |
|---|---|---|
| `/new` | 歸檔目前頻道的 session 並開始新對話 | |
| `/status` | 顯示模型、session、token 與執行狀態 | |
| `/stop` | 停止目前 session 正在執行的工作 | 工作觸發者或 owner |
| `/queue` | 設定目前 session 的 `followup`／`steer` 訊息處理模式，或重設為全域預設值 | |
| `/compact` | 摘要較舊的上下文並保留近期訊息 | |
| `/task` | 列出 Google Tasks | |
| `/model` | 切換目前 session 的模型與 reasoning effort | 僅限 owner |
| `/google-auth` | 完成 Google OAuth 授權 | 僅限 owner |
| `/restart` | 結束 gateway，讓 process manager 將它重新啟動 | 僅限 owner |
| `/plugin` | 安裝、更新或移除 plugin | 僅限 owner |

## Workspace

`workspace/` 是 Umiro 的私人執行區域。`umiro install` 會建立 prompt templates，其餘內容則由 agent 維護。

```text
workspace/
├── AGENT.md            # Operating rules and tool behavior
├── SOUL.md             # Persona and voice
├── OWNER.md            # Owner profile: identity, permissions, accounts, work, relationships
├── PEOPLE.md           # Profiles for everyone except the owner
├── MEMORY.md           # Long-lived non-profile operating context
├── JOURNAL.md          # Daily-memory and journal prompts
├── attachments/        # Generated and downloaded files
├── config/             # SQLite DB, cron/reminder data, OAuth tokens
├── memory/             # Daily memory files
├── sessions/           # Active sessions and archived conversations
└── skills/             # Installed skills
```

> [!IMPORTANT]
> 請保持此目錄為私人狀態並定期備份。裡面包含對話紀錄、OAuth tokens、上傳檔案與個人筆記。

## 安全模型

Umiro 是為個人、受信任的部署環境設計，而不是可公開使用的 sandbox bot。

- `bash` 會直接在主機上執行任意指令，沒有 sandbox。預設的 `tools.bash_owner_only: true` 只允許已設定的 owner，以及 `bash_allowed_users` 列出的 ID 使用。
- Gmail、Drive、Calendar、排程與 Discord 訊息修改等高影響工具僅限 owner 使用。
- 使用 `discord.allowed_guilds` 與 `discord.allowed_channels`，盡量縮小 bot 可被觸發的範圍。
- 將 `workspace/config/google-token.json`、`.env`，以及所有日誌與 workspace 資料視為私人內容。
- 安裝任何第三方 skill 前都應先檢查內容；skill 可以加入會影響工具使用方式的指令。

## Google 整合

1. 建立 Google Cloud project。
2. 啟用 Calendar、Gmail、Drive 與 Tasks APIs。
3. 建立 Desktop OAuth client。
4. 將 client ID 與 secret 填入 `.env`。
5. 重新啟動 Umiro，並由 owner 執行 `/google-auth`。

`GOOGLE_API_KEY` 是獨立設定，只用於 Gemini embedding-based semantic memory recall。未設定時，memory search 仍可透過全文搜尋運作。

## 私人 Plugins

Plugins 可以註冊部署環境專用的工具、週期性背景工作與 lifecycle handlers，而不必修改內建 registry，也不必將私人整合提交到此 repository。受管理的 plugins 會安裝至 `workspace/plugins/`，並登記在 `workspace/config/plugins.json`。

```bash
umiro plugin install <git-url>
umiro plugin install <git-url> --workspace <package-name-or-path>
umiro plugin list
umiro plugin enable <name>
umiro plugin disable <name>
umiro plugin update [name]
umiro plugin remove <name>
```

Plugin package 需在 `package.json` 中以 `"umiro": { "plugin": "./dist/index.js" }` 宣告 entry。Installer 會安裝 dependencies，並在存在時執行 `build` script，但不會自行重新啟動 gateway。

Discord 的 owner-only `/plugin` 指令有一個必要的 `action` 選項（`install`、`update` 或 `remove`），以及一個選填的 `target` 字串。安裝時，`target` 接受 GitHub URL；更新或移除時，則會提供已安裝 plugin 的 autocomplete。執行更新時省略 `target`，會更新所有受管理的來源。系統會直接將呼叫者與 `discord.owner_id` 比對，因為安裝 plugin 代表在主機上執行受信任的程式碼。Discord 安裝只接受公開的 HTTPS GitHub 連結；本機路徑、SSH 來源，以及 enable／disable 維護操作仍須在主機 CLI 進行。

> [!WARNING]
> Plugin 程式碼會直接在 Umiro process 中執行，沒有 sandbox。工具權限仍會經過中央 registry。

第一個 plugin 教學、package 範例、monorepo 安裝方式、API contract 與疑難排解，請見 [docs/PLUGINS.md](docs/PLUGINS.md)。

## 開發

```bash
npm install
npm run build      # Type-check and emit JavaScript into dist/
npm run dev        # Start the local CLI
npm run typecheck  # Type-check without emitting
```

## 解除安裝

```bash
sudo systemctl stop umiro
sudo systemctl disable umiro
sudo rm /etc/systemd/system/umiro.service
sudo systemctl daemon-reload
npm unlink -g umiro
rm -rf ~/.umiro
```

> [!CAUTION]
> 執行最後一行前，請先備份所有想保留的 workspace 資料。

---

<div align="center">
<img src="assets/umiro-brand.png" alt="Umiro brand sheet" width="600">
</div>

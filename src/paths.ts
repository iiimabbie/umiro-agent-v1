import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

export const WORKSPACE_DIR = resolve(ROOT, "workspace");
export const LOGS_DIR = resolve(ROOT, "logs");
export const CONFIG_PATH = resolve(ROOT, process.env.UMIRO_CONFIG_PATH ?? "config.yaml");
export const SESSIONS_DIR = resolve(WORKSPACE_DIR, "sessions");
export const ARCHIVE_DIR = resolve(SESSIONS_DIR, "archive");
export const MEMORY_DIR = resolve(WORKSPACE_DIR, "memory");
export const MEMORY_INDEX = resolve(WORKSPACE_DIR, "MEMORY.md");
export const PEOPLE_FILE = resolve(WORKSPACE_DIR, "PEOPLE.md");
export const OWNER_FILE = resolve(WORKSPACE_DIR, "OWNER.md");
export const SOUL_FILE = resolve(WORKSPACE_DIR, "SOUL.md");
export const AGENT_FILE = resolve(WORKSPACE_DIR, "AGENT.md");
export const WORKSPACE_CONFIG_DIR = resolve(WORKSPACE_DIR, "config");
export const CRONS_FILE = resolve(WORKSPACE_CONFIG_DIR, "crons.json");
export const REMINDERS_FILE = resolve(WORKSPACE_CONFIG_DIR, "reminders.json");
export const GOOGLE_TOKEN_PATH = resolve(WORKSPACE_CONFIG_DIR, "google-token.json");
export const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");
export const PLUGINS_DIR = resolve(WORKSPACE_DIR, "plugins");
export const PLUGIN_REGISTRY_FILE = resolve(WORKSPACE_CONFIG_DIR, "plugins.json");
export const PLUGIN_CONFIG_DIR = resolve(WORKSPACE_CONFIG_DIR, "plugins");

/**
 * agent 產生或抓下來的檔案一律落在這裡：下載的圖片、Discord 附件、
 * 產出的報表／HTML、暫存檔。不要再另開 `pages/`、`tmp/` 之類的同級目錄。
 */
export const ATTACHMENTS_DIR = resolve(WORKSPACE_DIR, "attachments");
/**
 * 附件索引的內部儲存：下載的原檔、inline 圖片與 OCR cache。
 * 放在 config 下而不是 attachments 下，是因為 attachments 是使用者的交付區——
 * 雜湊分片目錄對使用者沒有意義，混在裡面只會讓人不知道哪些檔案可以自己動。
 */
export const ATTACHMENT_INDEX_DIR = resolve(WORKSPACE_CONFIG_DIR, "attachment-index");

/**
 * 全域唯一的回收桶。刪除一律 `mv` 到這裡，不用 `rm`。
 *
 * 刻意放在 workspace 頂層而非 attachments 底下，並且指定到絕對位置：
 * 只說「移到 .trash」的話，agent 會依當下工作目錄各建一個，散成多個回收桶。
 */
export const TRASH_DIR = resolve(WORKSPACE_DIR, ".trash");

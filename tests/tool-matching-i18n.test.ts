import assert from "node:assert/strict";
import test from "node:test";

import { activeLlmProfile } from "../src/llm/profile.js";
import { executeTool, getToolDefinitions } from "../src/tools/registry.js";
import { detectSignals } from "../src/tools/metadata.js";

const config = {
  llm: {
    active_profile: "test",
    profiles: {
      test: {
        protocol: "openai_responses" as const,
        baseUrl: "https://example.invalid/v1",
        auth: "none" as const,
        apiKey: "",
        model: "test-model",
        reasoningEffort: "default" as const,
        tokenLimitField: "max_output_tokens" as const,
        capabilities: {
          vision: true,
          function_tools: true,
          responses: true,
          hosted_web_search: false,
          hosted_image_generation: true,
          hosted_code_execution: false,
        },
      },
    },
  },
} as Parameters<typeof activeLlmProfile>[0];

const profile = activeLlmProfile(config);

function selected(prompt: string, hasAttachment = false): Set<string> {
  return new Set(getToolDefinitions({
    profile,
    prompt,
    trigger: "discord-owner",
    hasAttachment,
    exposureEnabled: true,
    maxMatchedTools: 50,
  }).map(tool => tool.name));
}

const cases: Array<[string, string, string]> = [
  ["weather", "明天台北天气怎么样？", "get_weather"],
  ["weather", "明天會下雨", "get_weather"],
  ["weather", "東京の天気予報を見て", "get_weather"],
  ["weather", "내일 서울 날씨 알려줘", "get_weather"],
  ["reminder", "Remind me tomorrow at 9", "reminder_create"],
  ["reminder", "明日の9時にリマインドして", "reminder_create"],
  ["reminder", "내일 9시에 알림 설정해 줘", "reminder_create"],
  ["gmail", "帮我搜索邮件里的发票", "google_gmail_search"],
  ["gmail", "受信トレイから請求書のメールを検索して", "google_gmail_search"],
  ["gmail", "받은편지함에서 영수증 이메일 검색해 줘", "google_gmail_search"],
  ["calendar", "下周的日程安排是什么？", "google_calendar_list_events"],
  ["calendar", "来週の予定を確認して", "google_calendar_list_events"],
  ["calendar", "다음 주 일정 확인해 줘", "google_calendar_list_events"],
  ["image", "幫我生圖", "image_gen"],
  ["image", "帮我生成图片，一只抱着海獭的女孩", "image_gen"],
  ["image", "Generate an image of a girl holding an otter", "image_gen"],
  ["image", "カワウソを抱く女の子の画像を生成して", "image_gen"],
  ["image", "해달을 안고 있는 여자아이 이미지 만들어 줘", "image_gen"],
  ["image follow-up", "圖呢？", "image_gen"],
  ["image follow-up", "pic?", "image_gen"],
  ["image follow-up", "did the image generate?", "image_gen"],
  ["image follow-up", "画像は？", "image_gen"],
  ["image follow-up", "그림은?", "image_gen"],
];

for (const [label, prompt, expected] of cases) {
  test(`${label} intent exposes ${expected}: ${prompt}`, () => {
    assert.equal(selected(prompt).has(expected), true);
  });
}

const casualCases: Array<[string, string]> = [
  ["外面熱嗎", "get_weather"],
  ["天气咋样", "get_weather"],
  ["天気どう", "get_weather"],
  ["날씨 어때", "get_weather"],
  ["ping me later", "reminder_create"],
  ["あとで教えて", "reminder_create"],
  ["이따 알려 줘", "reminder_create"],
  ["有沒有收到信", "google_gmail_search"],
  ["did I get an email", "google_gmail_search"],
  ["メール来てる", "google_gmail_search"],
  ["메일 왔어", "google_gmail_search"],
  ["下週忙嗎", "google_calendar_list_events"],
  ["am I free tomorrow", "google_calendar_list_events"],
  ["来週空いてる", "google_calendar_list_events"],
  ["다음 주 바빠", "google_calendar_list_events"],
  ["丟到雲端", "google_drive_upload"],
  ["put it in Drive", "google_drive_upload"],
  ["ドライブに入れといて", "google_drive_upload"],
  ["드라이브에 올려 줘", "google_drive_upload"],
  ["昨天聊了啥", "session_search"],
  ["find that old chat", "session_search"],
  ["昨日何話したっけ", "session_search"],
  ["어제 뭐 얘기했지", "session_search"],
];

for (const [prompt, expected] of casualCases) {
  test(`casual intent exposes ${expected}: ${prompt}`, () => {
    assert.equal(selected(prompt).has(expected), true);
  });
}

test("ambiguous or context-dependent phrases do not expose image generation", () => {
  const prompts = [
    "這個計畫不錯",
    "剛才那張表格",
    "再丟一次文件",
    "Please review the project plan",
    "Please review the image compression code",
    "Did it generate a useful report?",
    "画像認識とは何ですか",
    "できた？",
    "写真を見て説明して",
    "사진을 봐 줘",
    "다시 보내 줘",
  ];
  for (const prompt of prompts) {
    assert.equal(selected(prompt).has("image_gen"), false, prompt);
  }
});

test("image edit signal supports all five languages", () => {
  const prompts = [
    "幫這張照片去背",
    "帮这张图片换背景",
    "Please remove the background",
    "この画像の背景を削除して",
    "이 사진 배경 제거해 줘",
  ];
  for (const prompt of prompts) {
    assert.equal(detectSignals(prompt, true).hasImageEditRequest, true, prompt);
  }
});

test("date-time signal supports all five languages", () => {
  for (const prompt of ["明天下午三點", "明天下午三点", "tomorrow at 3 pm", "明日の午後3時", "내일 오후 3시"]) {
    assert.equal(detectSignals(prompt, false).hasDateTime, true, prompt);
  }
});


test("tool catalog searches the same multilingual metadata", async () => {
  const result = await executeTool("tool_catalog", { action: "search", query: "날씨" });
  assert.match(result, /get_weather/);
});

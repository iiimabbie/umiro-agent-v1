/**
 * Natural-language intent phrases used by deterministic tool exposure and catalog search.
 *
 * Keep these phrases specific enough to express an operation. Bare ambiguous words make
 * unrelated tools compete for the per-request exposure cap. Tool names remain independently
 * matchable, so these packs focus on common Traditional Chinese, Simplified Chinese,
 * English, Japanese, and Korean requests.
 */

export const TOOL_INTENTS = {
  weather: [
    "天氣", "氣溫", "溫度", "下雨", "會下雨嗎", "天氣預報",
    "天气", "气温", "温度", "下雨", "会下雨吗", "天气预报",
    "weather", "forecast", "will it rain", "temperature",
    "天気", "気温", "雨が降る", "雨降る", "天気予報",
    "날씨", "기온", "비 와", "비 올까", "일기예보",
      "會不會下雨", "外面熱嗎", "天气咋样", "会下雨不", "what's the weather like", "gonna rain", "天気どう", "雨降る？", "날씨 어때", "비 와?",
  ],

  memoryList: ["記憶列表", "列出記憶", "记忆列表", "列出记忆", "memory list", "list memories", "記憶一覧", "記憶を一覧", "기억 목록", "기억을 보여", "我記過什麼", "都记了啥", "what do you remember", "何を覚えてる", "뭐 기억해"],
  memoryAdd: ["記住", "記住這個", "記下來", "長期記憶", "记住", "记住这个", "记下来", "长期记忆", "remember this", "save to memory", "覚えて", "記憶して", "기억해 줘", "기억해둬", "幫我記著", "这个记一下", "keep this in mind", "これ覚えといて", "이거 기억해 둬"],
  memoryReplace: ["更新記憶", "修改記憶", "改記憶", "更新记忆", "修改记忆", "改记忆", "update memory", "change memory", "記憶を更新", "記憶を修正", "기억 수정", "기억 업데이트", "這個記憶改一下", "把这个改一下", "fix what you remember", "覚えてる内容直して", "기억한 거 고쳐 줘"],
  memoryRemove: ["刪除記憶", "移除記憶", "忘記這個", "删除记忆", "移除记忆", "忘记这个", "forget this", "remove memory", "記憶を削除", "忘れて", "기억 삭제", "잊어 줘", "這個別記了", "这个忘掉", "don't remember this", "これは忘れて", "이건 잊어 줘"],
  peopleRemove: ["刪除人物", "移除人物", "删除人物", "移除人物", "remove person", "delete person", "人物を削除", "人を削除", "인물 삭제", "사람 삭제", "把這個人刪掉", "把这个人删掉", "remove them from people", "この人消して", "이 사람 지워 줘"],

  cronBase: ["排程", "定期任務", "定時任務", "定时任务", "计划任务", "cron", "recurring schedule", "定期実行", "スケジュール", "정기 작업", "예약 실행", "固定跑", "定期跑", "定时跑", "run this regularly", "定期で回して", "주기적으로 돌려"],
  cronCreate: ["建立排程", "新增排程", "每天執行", "每週執行", "创建排程", "新增排程", "每天执行", "每周执行", "create cron", "schedule recurring", "定期実行を作成", "毎日実行", "정기 작업 만들어", "매일 실행", "每天幫我跑", "每周帮我跑", "run this every day", "毎日やって", "매일 해 줘"],
  cronList: ["排程列表", "列出排程", "排程清單", "排程列表", "列出排程", "计划任务列表", "list schedules", "list cron jobs", "スケジュール一覧", "定期実行一覧", "예약 목록", "정기 작업 목록", "現在有哪些排程", "现在有啥定时任务", "what schedules do I have", "今どんな定期実行ある", "지금 예약된 거 뭐 있어"],
  cronDelete: ["刪除排程", "取消排程", "删除排程", "取消排程", "delete schedule", "cancel cron", "スケジュールを削除", "定期実行を取消", "예약 삭제", "정기 작업 취소", "這個排程不要了", "这个定时任务不要了", "stop this schedule", "この定期実行やめて", "이 예약 없애 줘"],
  cronToggle: ["停用排程", "啟用排程", "暂停排程", "启用排程", "disable schedule", "enable schedule", "スケジュールを無効", "スケジュールを有効", "예약 비활성화", "예약 활성화", "先停掉這個排程", "把这个定时任务打开", "pause this schedule", "この定期実行止めて", "이 예약 잠깐 꺼 줘"],
  cronUpdate: ["修改排程", "更新排程", "修改排程", "更新排程", "update schedule", "change cron", "スケジュールを変更", "定期実行を更新", "예약 수정", "정기 작업 변경", "排程時間改一下", "把定时任务改一下", "move this schedule", "定期実行の時間変えて", "예약 시간 바꿔 줘"],
  reminderCreate: ["提醒我", "幾點叫我", "叫我記得", "提醒我一下", "几点叫我", "叫我记得", "remind me", "set a reminder", "リマインドして", "知らせて", "알림 설정", "잊지 않게 알려줘", "等等提醒我", "到時叫我", "等下提醒我", "到时候叫我", "ping me later", "remind me later", "あとで教えて", "後で声かけて", "이따 알려 줘", "나중에 말해 줘"],
  reminderList: ["提醒列表", "列出提醒", "提醒清單", "提醒列表", "列出提醒", "提醒清单", "list reminders", "show reminders", "リマインダー一覧", "リマインド一覧", "알림 목록", "리마인더 목록", "我有什麼提醒", "我有啥提醒", "what reminders do I have", "リマインダー何ある", "알림 뭐 있어"],
  reminderDelete: ["刪除提醒", "取消提醒", "删除提醒", "取消提醒", "delete reminder", "cancel reminder", "リマインダーを削除", "リマインドを取消", "알림 삭제", "리마인더 취소", "這個提醒不要了", "这个提醒不要了", "drop this reminder", "このリマインダー消して", "이 알림 없애 줘"],

  discordFetchMessage: ["抓這則訊息", "查看這則訊息", "抓取消息", "查看这条消息", "fetch message", "get this message", "このメッセージを取得", "メッセージを確認", "이 메시지 가져와", "메시지 확인", "看一下這則", "看下这条", "pull up this message", "これ見て", "이거 봐 줘"],
  discordFetchChannel: ["抓頻道訊息", "頻道歷史", "查看頻道紀錄", "抓频道消息", "频道历史", "查看频道记录", "fetch channel messages", "channel history", "チャンネル履歴", "チャンネルのメッセージ", "채널 기록", "채널 메시지 가져와", "看一下這裡前面聊什麼", "看看这个频道前面聊了啥", "what happened in this channel", "このチャンネル前のやつ見て", "이 채널 앞에 뭐 얘기했는지 봐 줘"],
  discordSendMessage: ["發訊息", "傳訊息", "發送訊息", "发消息", "传消息", "发送消息", "send a message", "post a message", "メッセージを送って", "メッセージを投稿", "메시지 보내", "메시지 전송", "跟他說", "幫我丟一句", "跟他说", "帮我发一句", "tell them", "send this", "これ送って", "これ伝えて", "이거 보내 줘", "이렇게 말해 줘"],
  discordButtons: ["建立按鈕", "發送按鈕", "互動按鈕", "创建按钮", "发送按钮", "交互按钮", "create buttons", "send buttons", "ボタンを作成", "ボタンを送信", "버튼 만들어", "버튼 보내", "弄幾個按鈕", "加幾個按鈕", "弄几个按钮", "add some buttons", "ボタン付けて", "버튼 좀 달아 줘"],
  discordPin: ["釘選訊息", "置頂訊息", "钉选消息", "置顶消息", "pin message", "pin this", "メッセージをピン留め", "ピン留めして", "메시지 고정", "핀 고정", "把這個釘起來", "這則置頂", "把这个置顶", "pin this one", "これピンして", "이거 고정해 줘"],
  discordUnpin: ["取消釘選", "取消置頂", "取消钉选", "取消置顶", "unpin message", "remove pin", "ピン留めを解除", "ピンを外して", "메시지 고정 해제", "핀 해제", "這個不用釘了", "取消这个置顶", "unpin this one", "これピン外して", "이거 고정 풀어 줘"],
  discordThread: ["建立討論串", "開討論串", "创建讨论串", "开启讨论串", "create thread", "start a thread", "スレッドを作成", "スレッドを立てて", "스레드 만들어", "스레드 열어", "另開一串", "開一串聊", "另开一串", "make a thread for this", "これスレッドにして", "이거 스레드로 빼 줘"],
  discordForum: ["建立論壇貼文", "新增論壇貼文", "创建论坛帖子", "新增论坛帖子", "create forum post", "new forum post", "フォーラム投稿を作成", "フォーラムに投稿", "포럼 글 만들어", "포럼 게시물 작성", "開個新貼文", "幫我開一篇", "开个新帖子", "make a new post", "新しい投稿作って", "새 글 하나 만들어 줘"],
  discordEdit: ["編輯訊息", "修改訊息", "编辑消息", "修改消息", "edit message", "change the message", "メッセージを編集", "メッセージを修正", "메시지 수정", "메시지 편집", "剛那句改一下", "把刚才那句改一下", "fix that message", "さっきのメッセージ直して", "아까 메시지 고쳐 줘"],
  discordArchive: ["封存討論串", "封存貼文", "归档讨论串", "归档帖子", "archive thread", "archive post", "スレッドをアーカイブ", "投稿をアーカイブ", "스레드 보관", "게시물 보관", "這串收起來", "把这帖收起来", "close out this thread", "このスレッドしまって", "이 스레드 보관해 줘"],

  calendarList: ["查看行程", "行事曆", "日曆行程", "查看日程", "日历行程", "日程安排", "calendar events", "show my schedule", "予定を確認", "カレンダー", "일정 확인", "캘린더 일정", "我明天有啥", "下週忙嗎", "下周忙吗", "what's on my calendar", "am I free tomorrow", "明日何ある", "来週空いてる", "내일 뭐 있어", "다음 주 바빠"],
  calendarCreate: ["建立行程", "新增活動", "加到日曆", "创建日程", "新增活动", "加到日历", "create calendar event", "add to calendar", "予定を追加", "カレンダーに追加", "일정 추가", "캘린더에 추가", "幫我排進去", "放到行事曆", "帮我加进去", "放到日历里", "put it on my calendar", "add this to my schedule", "予定に入れといて", "カレンダー入れて", "일정에 넣어 줘", "캘린더에 잡아 줘"],
  calendarUpdate: ["修改行程", "更新活動", "修改日程", "更新活动", "update calendar event", "change my schedule", "予定を変更", "イベントを更新", "일정 수정", "캘린더 일정 변경", "把時間挪一下", "行程改到明天", "把时间挪一下", "日程改到明天", "move it to tomorrow", "reschedule it", "明日にずらして", "時間変えて", "내일로 옮겨 줘", "시간 바꿔 줘"],

  gmailSearch: ["查信", "搜尋郵件", "找郵件", "收件匣", "查邮件", "搜索邮件", "找邮件", "收件箱", "search email", "find an email", "inbox", "メールを検索", "受信トレイ", "이메일 검색", "받은편지함", "信箱找一下", "有沒有收到信", "邮箱找一下", "有没有收到邮件", "check my mail", "did I get an email", "メール来てる", "メール探して", "메일 왔어", "메일 좀 찾아 줘"],
  gmailRead: ["讀這封信", "郵件內容", "查看郵件", "读这封邮件", "邮件内容", "查看邮件", "read this email", "open the email", "メールを読んで", "メールの内容", "이메일 읽어", "메일 내용", "這封講啥", "打開這封", "这封说啥", "打开这封", "what's this email about", "open this one", "このメール何て書いてある", "これ開いて", "이 메일 뭐래", "이거 열어 줘"],
  gmailSend: ["寄信", "寄封郵件", "發送郵件", "发邮件", "寄封邮件", "发送邮件", "send email", "email them", "メールを送って", "メールを送信", "이메일 보내", "메일 전송", "幫我回信", "寄給他", "帮我回邮件", "发给他", "reply to them", "send them an email", "返信して", "この人にメールして", "답장해 줘", "메일 보내 줘"],
  gmailDraft: ["建立郵件草稿", "寫信草稿", "创建邮件草稿", "写邮件草稿", "create email draft", "draft an email", "メールの下書き", "下書きを作成", "이메일 초안", "메일 초안 작성", "先幫我寫一封", "先打個草稿", "先帮我写一封", "先打个草稿", "draft something for me", "write a quick email draft", "メール下書きして", "とりあえず文面作って", "메일 초안 써 줘", "일단 메일 써 줘"],

  driveSearch: ["搜尋雲端檔案", "找雲端文件", "搜尋雲端硬碟", "搜索云端文件", "找云端文档", "搜索云盘", "search drive", "find a drive file", "ドライブを検索", "クラウドのファイルを探す", "드라이브 검색", "클라우드 파일 찾기", "雲端找一下", "Drive 裡找", "云端找一下", "网盘里找", "look in Drive", "find it in my Drive", "ドライブで探して", "クラウドにあるか見て", "드라이브에서 찾아 줘", "클라우드에 있는지 봐 줘"],
  driveRead: ["讀雲端文件", "查看雲端內容", "读云端文档", "查看云端内容", "read drive file", "open drive document", "ドライブの文書を読む", "クラウド文書を開く", "드라이브 문서 읽기", "클라우드 문서 열기", "打開雲端那份", "看一下 Drive 那份", "打开云端那份", "看下网盘那个", "what's in that Drive file", "open that Drive file", "ドライブのあれ開いて", "あの文書見て", "드라이브에 있는 거 열어 줘", "그 문서 봐 줘"],
  driveUpload: ["上傳到雲端", "存到雲端硬碟", "上传到云端", "保存到云盘", "upload to drive", "save to drive", "ドライブにアップロード", "クラウドに保存", "드라이브에 업로드", "클라우드에 저장", "丟到雲端", "幫我存 Drive", "传到云端", "帮我存网盘", "put it in Drive", "upload this", "ドライブに入れといて", "これクラウドに上げて", "드라이브에 올려 줘", "이거 클라우드에 넣어 줘"],

  tasksList: ["待辦清單", "查看待辦", "任務列表", "待办清单", "查看待办", "任务列表", "task list", "show my tasks", "タスク一覧", "やることリスト", "할 일 목록", "작업 목록", "我還有啥要做", "待辦有什麼", "我还有啥要做", "待办有啥", "what's left to do", "show my to-dos", "やること何残ってる", "タスク何ある", "할 일 뭐 남았어", "해야 할 거 뭐 있어"],
  tasksCreate: ["新增待辦", "加入任務", "添加待办", "新增任务", "add a task", "create task", "タスクを追加", "やることを追加", "할 일 추가", "작업 추가", "這個加待辦", "幫我記一個待辦", "这个加待办", "帮我记个任务", "add this to my to-do list", "make this a task", "これタスクに入れて", "やることに追加して", "이거 할 일에 넣어 줘", "작업 하나 추가해 줘"],
  tasksComplete: ["完成待辦", "完成任務", "标记待办完成", "完成任务", "complete task", "mark task done", "タスクを完了", "完了にして", "할 일 완료", "작업 완료", "這個做完了", "待辦打勾", "这个做完了", "待办打勾", "this one is done", "check this off", "これ終わった", "完了にしといて", "이거 끝났어", "완료로 해 줘"],

  imageGeneration: [
    "生成圖片", "生成照片", "生圖", "幫我畫", "畫一張", "繪製圖片", "生一張圖", "做一張圖片", "圖片呢", "照片呢", "圖呢", "圖在哪", "剛才那張圖", "剛才那張照片", "重新生成圖片",
    "生成图片", "生成照片", "帮我画", "画一张", "绘制图片", "做一张图片", "图片呢", "照片呢", "图呢", "图在哪", "刚才那张图", "刚才那张照片", "重新生成图片",
    "generate an image", "create a picture", "draw me", "draw a picture", "draw an image", "make an image", "make a photo", "where is the image", "where's the image", "generate the image again",
    "画像を生成", "絵を描いて", "画像を作って", "画像はどこ", "さっきの画像", "もう一度生成",
    "이미지 만들어", "그림 그려", "사진 만들어", "이미지 어디", "아까 그 이미지", "다시 생성",
    "去背", "移除背景", "去掉背景", "换背景", "remove background", "edit this image", "背景を削除", "画像を編集", "배경 제거", "이미지 편집",
      "圖咧", "圖勒", "還沒看到圖", "圖有生出來嗎", "再丟一次圖片", "图嘞", "图咧", "还没看到图", "图片生成了吗", "再发一次图片", "pic?", "where's my pic", "did the image generate", "I don't see the image", "send the image again", "画像は？", "絵は？", "まだ画像見えない", "画像できた？", "画像をもう一回送って", "이미지는?", "그림은?", "아직 이미지가 안 보여", "이미지 만들어졌어?", "이미지 다시 보내 줘",
  ],
  sessionSearch: ["搜尋對話", "找以前的對話", "之前說過", "搜索对话", "找以前的对话", "之前说过", "search conversations", "what did we say", "会話を検索", "前に話した", "대화 검색", "전에 말한 것", "昨天聊了啥", "之前那段在哪", "之前那段在哪儿", "what did we talk about yesterday", "find that old chat", "昨日何話したっけ", "前の会話探して", "어제 뭐 얘기했지", "전에 한 말 찾아 줘"],
  skillList: ["技能列表", "列出技能", "可用技能", "技能列表", "列出技能", "可用技能", "skill list", "list skills", "スキル一覧", "利用可能なスキル", "스킬 목록", "사용 가능한 스킬", "你會啥", "有什麼技能", "你会啥", "有啥技能", "what can you do", "what skills are there", "何できる", "スキル何ある", "뭐 할 수 있어", "스킬 뭐 있어"],
  usage: ["用量統計", "花費統計", "使用量儀表板", "用量统计", "花费统计", "使用量仪表板", "usage dashboard", "usage statistics", "cost dashboard", "使用量ダッシュボード", "利用統計", "사용량 대시보드", "비용 통계", "最近用了多少", "花多少錢了", "花多少钱了", "how much have I used", "what did this cost", "どれくらい使った", "いくらかかった", "얼마나 썼어", "비용 얼마나 나왔어"],
} as const satisfies Record<string, readonly string[]>;

export const DATE_TIME_INTENTS = [
  "明天", "後天", "下週", "下周", "每天", "每週", "每周", "幾點", "點叫我", "每月", "下個月", "下禮拜",
  "后天", "几点", "点叫我", "每月", "下个月", "下星期",
  "tomorrow", "day after tomorrow", "next week", "every day", "every week", "what time", "next month",
  "明日", "明後日", "来週", "毎日", "毎週", "何時", "来月",
  "내일", "모레", "다음 주", "매일", "매주", "몇 시", "다음 달",
] as const;

export const IMAGE_EDIT_INTENTS = [
  "去背", "移除背景", "去掉背景", "背景去掉", "換背景", "修改圖片", "編輯圖片", "修圖",
  "移除背景", "去掉背景", "背景去掉", "换背景", "修改图片", "编辑图片", "修图",
  "edit this image", "edit this photo", "edit image", "edit photo", "remove the background", "remove background", "change the background",
  "背景を削除", "背景を消して", "背景を変更", "画像を編集", "写真を編集",
  "배경 제거", "배경 지워", "배경 바꿔", "이미지 편집", "사진 편집",
] as const;

export function intentKeywords(...packs: readonly (readonly string[])[]): string[] {
  return [...new Set(packs.flat())];
}

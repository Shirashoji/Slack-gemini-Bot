const GEMINI_API_KEY =
  PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const SLACK_BOT_TOKEN =
  PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${GEMINI_API_KEY}`;
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_UPDATE_MESSAGE_URL = 'https://slack.com/api/chat.update';
const SLACK_REPLIES_URL = 'https://slack.com/api/conversations.replies';
const DUP_EVENT_CACHE_TTL = 600; // 秒: 同一イベントIDを保持して再処理防止 (10分)

// --- Logger Function ---
function logToSheet(level, message) {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = spreadsheet.getSheetByName('Logs');
    if (!sheet) {
      sheet = spreadsheet.insertSheet('Logs');
    }
    const timestamp = new Date();
    const messageStr =
      typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
    sheet.appendRow([timestamp, level, messageStr]);
  } catch (e) {
    console.error('Failed to log to spreadsheet: ' + e.toString());
  }
}

// --- Main Functions (New Trigger-based Architecture) ---

/**
 * Step 1: Receives the initial request from Slack.
 * This function's only job is to be fast. It acknowledges the request,
 * posts a "Please wait" message, creates a trigger to do the slow work later,
 * and returns a 200 OK to Slack immediately to prevent timeouts and retries.
 */
function doPost(e) {
  // --- 受信生データ簡易ログ (できるだけ軽量) ---
  const raw = e && e.postData && e.postData.contents;
  try {
    console.log('Raw doPost payload:', raw && raw.substring(0, 500));
  } catch (_) {}

  // Slack が要求する URL Verification に最優先で応答できるよう最初に処理
  // Slack 仕様: body に { type: 'url_verification', challenge: 'xxxx' }
  // パース失敗時も challenge を単純抽出するフォールバック
  if (raw && raw.indexOf('challenge') !== -1) {
    try {
      const tmp = JSON.parse(raw);
      if (tmp && tmp.type === 'url_verification' && tmp.challenge) {
        // ここではシートアクセスを避け超高速応答
        console.log('Responding to Slack URL verification challenge');
        return ContentService.createTextOutput(tmp.challenge).setMimeType(
          ContentService.MimeType.TEXT,
        );
      }
    } catch (e2) {
      // フォールバック: 正規表現で challenge 文字列を拾う (念のため)
      try {
        const m = raw.match(/"challenge"\s*:\s*"([^"]+)"/);
        if (m && m) {
          console.log('Fallback regex challenge extraction success');
          return ContentService.createTextOutput(m).setMimeType(
            ContentService.MimeType.TEXT,
          );
        }
      } catch (_) {}
    }
  }

  // まずSlackへ即時ACKするための空JSONレスポンスを先に準備
  var ack = ContentService.createTextOutput('{}').setMimeType(
    ContentService.MimeType.JSON,
  );

  if (!raw) {
    logToSheet('ERROR', 'No postData.contents in request');
    return ack;
  }

  var json;
  try {
    json = JSON.parse(raw);
  } catch (parseErr) {
    logToSheet('ERROR', `JSON parse error (non-challenge): ${parseErr}`);
    return ack;
  }

  // --- 重複イベント抑止 (Slack再送による多重回答防止) ---
  try {
    if (json.event_id) {
      if (isDuplicateSlackEvent(json.event_id)) {
        logToSheet('INFO', `Duplicate event skipped: ${json.event_id}`);
        return ack;
      }
    } else {
      logToSheet('WARN', 'event_id not found (cannot deduplicate)');
    }
  } catch (dupErr) {
    logToSheet('ERROR', `Duplicate check error: ${dupErr}`);
  }

  // Bot自身のメッセージは無視 (ループ防止)
  if (json.event && json.event.bot_id) {
    logToSheet('INFO', "Ignored bot's own message");
    return ack;
  }

  // 想定イベントのみ処理
  if (
    json.event &&
    (json.event.type === 'app_mention' || json.event.type === 'message') &&
    json.event.text
  ) {
    var event = json.event;
    var text = event.text || '';
    var channel = event.channel;
    var thread_ts = event.thread_ts || event.ts;
    var files = event.files || []; // ファイル情報を取得

    // BotユーザーIDを推定
    var botUserIds = getBotUserIds(json);

    // メンションを除去してクエリを抽出
    var query = cleanQuery(text, botUserIds);

    logToSheet('INFO', `Parsed query: "${query}" with ${files.length} files.`);

    // --- Step 1.5: Post "Please wait" and start streaming ---
    try {
      // 最初に「思考中」のメッセージを投稿
      const waitMsgResponse = postThinkingMessage(channel, thread_ts);
      const message_ts = waitMsgResponse ? waitMsgResponse.ts : null;

      if (!message_ts) {
        throw new Error("Failed to get message_ts for 'wait' message.");
      }

      // --- スレッド履歴とファイル処理 ---
      const history = getThreadHistory(channel, thread_ts, botUserIds);
      const filesData = processSlackFiles(files); // ファイルを処理

      // --- Gemini API呼び出し (ストリーミング) ---
      streamGeminiResponseToSlack(
        query,
        history,
        filesData,
        channel,
        message_ts,
      );
    } catch (err) {
      logToSheet(
        'ERROR',
        `doPost processing error: ${err}\nStack: ${err && err.stack}`,
      );
      // エラーが発生した場合、待機メッセージをエラー表示に更新
      if (message_ts) {
        updateSlackMessage(
          channel,
          message_ts,
          'エラーが発生しました。詳細はログを確認してください。',
        );
      }
    }
  } else {
    logToSheet('INFO', 'Event ignored (unsupported type or missing text)');
  }

  return ack; // Slackへは即時ACK
}

// --- Helper Functions ---

/**
 * Calls the Gemini API with streaming enabled and updates the Slack message in real-time.
 */
function streamGeminiResponseToSlack(
  question,
  history,
  filesData,
  channel,
  message_ts,
  root_thread_ts,
) {
  const systemInstruction = `あなたは優秀なアシスタントです。Slackスレッドの文脈と与えられたテキスト/画像を考慮して日本語で簡潔・正確に回答してください。\n\nSlackで使用できる *mrkdwn* のサポート済み要素「のみ」を使い、未サポート記法は生成しないでください。mrkdwnも必要な場合のみ用いてください。装飾を使用する場合は前後に半角スペースを入れてください。\n\n[使ってよいもの]\n• 太字: *太字* (*は1つ)\n• 斜体: _斜体_ \n• 打ち消し: ~打ち消し~ \n• インラインコード: \`code\`\n• コードブロック: \`\`\` (言語指定は付けない)\n• 箇条書き: 行頭に • か - か数字+ピリオド (1.)\n• 引用: 行頭に >\n• リンク: <https://example.com|表示テキスト> または単純URL\n• 絵文字: :emoji_name: (標準的なもののみ)\n\n[禁止 / 生成しない]\n• 見出し記法 (#, ## など)\n• Markdown表( | と --- 区切り)\n• HTMLタグ (<div>, <span> など)\n• 脚注、数式、埋め込み画像タグ\n• 未サポートの装飾 (~~複雑な入れ子~~ 等過度な装飾)\n• 言語指定付きコードフェンス (例: \`\`\`javascript)\n\nテキストは自然な段落 (空行で区切り) を用い、不要に長い前置きは避けてください。事実が不確かなら「不確か」と明示し、推測は根拠を簡潔に述べます。`;

  let parts = [];
  if (question) {
    parts.push({ text: question });
  }
  if (filesData && filesData.length > 0) {
    parts = parts.concat(filesData);
  }
  if (parts.length === 0) {
    updateSlackMessage(
      channel,
      message_ts,
      '質問のテキストまたはファイルが見つかりませんでした。',
    );
    postSupplementaryBlocks(channel, root_thread_ts || message_ts);
    return;
  }

  const contents = history.concat([{ role: 'user', parts: parts }]);

  const payload = {
    contents: contents,
    system_instruction: {
      parts: [{ text: systemInstruction }],
    },
    generation_config: {
      temperature: 1,
      top_k: 0,
      top_p: 0.95,
      stop_sequences: [],
    },
    safety_settings: [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE',
      },
    ],
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    logToSheet(
      'INFO',
      'Sending stream request to Gemini: ' + JSON.stringify(payload),
    );
    const response = UrlFetchApp.fetch(GEMINI_API_URL, options);
    const responseText = response.getContentText();

    // ストリームデータを正規表現でパース
    const textRegex = /"text"\s*:\s*"((?:\\"|[^"])*)"/g;
    let match;
    let fullText = '';
    let buffer = '';
    const UPDATE_THRESHOLD = 30; // 更新頻度を少し上げる

    while ((match = textRegex.exec(responseText)) !== null) {
      // JSON文字列内のエスケープ文字（\" や \\ など）を元に戻す
      const textPart = JSON.parse(`"${match[1]}"`);
      buffer += textPart;

      if (buffer.length >= UPDATE_THRESHOLD) {
        fullText += buffer;
        buffer = '';
        // 末尾の不完全な文章を考慮し、句点や改行で区切る
        let lastCut = Math.max(
          fullText.lastIndexOf('。'),
          fullText.lastIndexOf('\n'),
        );
        if (lastCut === -1) lastCut = fullText.length;
        else lastCut++;

        let textToSend = fullText.substring(0, lastCut);
        buffer = fullText.substring(lastCut) + buffer; // 残りをバッファに戻す
        fullText = textToSend;
        updateSlackMessage(channel, message_ts, fullText);
      }
    }

    fullText += buffer; // 残りのバッファを追加

    if (fullText) {
      updateSlackMessage(channel, message_ts, fullText);
      postSupplementaryBlocks(channel, root_thread_ts || message_ts);
    } else {
      logToSheet(
        'ERROR',
        'No valid text received from Gemini stream. Response: ' + responseText,
      );
      let errorMessage = 'Geminiからの回答を正しく解析できませんでした。';
      try {
        // APIからの直接のエラーメッセージを抽出試行
        const errorJson = JSON.parse(responseText);
        if (errorJson.error && errorJson.error.message) {
          errorMessage += `\nReason: ${errorJson.error.message}`;
        } else if (errorJson.promptFeedback) {
          errorMessage = `回答を生成できませんでした。入力内容が安全性ポリシーに違反している可能性があります。 (Reason: ${errorJson.promptFeedback.blockReason || 'Unknown'})`;
        }
      } catch (e) {
        /* ignore parse error */
      }
      updateSlackMessage(channel, message_ts, errorMessage);
      postSupplementaryBlocks(channel, root_thread_ts || message_ts);
    }
  } catch (error) {
    logToSheet(
      'ERROR',
      `Error in streamGeminiResponseToSlack: ${error.toString()}\nStack: ${error.stack}`,
    );
    updateSlackMessage(
      channel,
      message_ts,
      'エラーが発生しました。時間をおいて再度お試しください。',
    );
    postSupplementaryBlocks(channel, root_thread_ts || message_ts);
  }
}

function getThreadHistory(channel, thread_ts, botUserIds = []) {
  if (!thread_ts) return [];

  try {
    const options = {
      method: 'get',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    };
    const response = UrlFetchApp.fetch(
      `${SLACK_REPLIES_URL}?channel=${channel}&ts=${thread_ts}&limit=10`, // 直近10件の履歴に制限
      options,
    );
    const json = JSON.parse(response.getContentText());

    if (json.ok && json.messages) {
      logToSheet(
        'INFO',
        `Fetched ${json.messages.length} messages from thread.`,
      );
      // Gemini APIの 'contents' 形式に変換
      // 最後のメッセージ（現在の質問）は履歴に含めない
      const messages = json.messages.slice(0, -1);

      return messages
        .map((msg) => {
          const isBot =
            (msg.bot_id && msg.bot_id !== null) ||
            (msg.user && botUserIds.includes(msg.user));
          const role = isBot ? 'model' : 'user';
          const text = cleanQuery(msg.text || '', botUserIds);

          // ファイルを処理
          const filesData = msg.files ? processSlackFiles(msg.files) : [];

          // テキストもファイルもないメッセージは履歴から除外
          if (!text && filesData.length === 0) {
            return null;
          }

          let parts = [];
          if (text) {
            parts.push({ text: text });
          }
          if (filesData.length > 0) {
            parts = parts.concat(filesData);
          }

          return { role: role, parts: parts };
        })
        .filter((m) => m !== null); // nullを除外
    } else {
      logToSheet('WARN', `Failed to fetch thread history: ${json.error}`);
      return [];
    }
  } catch (e) {
    logToSheet('ERROR', `Error in getThreadHistory: ${e}`);
    return [];
  }
}

function postToSlack(channel, text, thread_ts) {
  const payload = { channel: channel, text: text, thread_ts: thread_ts };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet('INFO', 'Posting message to Slack: ' + JSON.stringify(payload));
    const response = UrlFetchApp.fetch(SLACK_POST_MESSAGE_URL, options);
    const responseBody = response.getContentText();
    logToSheet('INFO', 'Response from Slack API: ' + responseBody);
    return JSON.parse(responseBody);
  } catch (error) {
    logToSheet('ERROR', `Error posting to Slack: ${error}`);
    return null;
  }
}

// --- Block Kit Support ---
// (Deprecated) buildAnswerBlocks: replaced by plain text streaming + separate supplementary blocks

function postThinkingMessage(channel, thread_ts) {
  return postToSlack(channel, '思考中です...', thread_ts);
}

function updateSlackMessage(channel, ts, text) {
  const payload = {
    channel: channel,
    ts: ts,
    text: (text || '').substring(0, 40000),
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet(
      'INFO',
      'Updating Slack message (plain text) len=' + (text || '').length,
    );
    const response = UrlFetchApp.fetch(SLACK_UPDATE_MESSAGE_URL, options);
    logToSheet(
      'INFO',
      'Response from Slack API (update): ' + response.getContentText(),
    );
  } catch (error) {
    logToSheet('ERROR', `Error updating Slack message: ${error}`);
  }
}

// Supplementary Block Kit (disclaimer + links)
function buildSupplementaryBlocks() {
  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'plain_text',
        text: '生成AIの返答にはハルシネーションと呼ばれる嘘が含まれている可能性があります。\nこの点に十分注意をして活用してください。',
        emoji: true,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':google-cloud: ハルシネーションとは？',
            emoji: true,
          },
          url: 'https://cloud.google.com/discover/what-are-ai-hallucinations',
          action_id: 'ai_hallucination_info',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':github: このBotのソースコード',
            emoji: true,
          },
          url: 'https://github.com/Shirashoji/Slack-gemini-Q_and_A',
          action_id: 'open_repo',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':google-gemini: GeminiをWebで使用',
            emoji: true,
          },
          url: 'https://gemini.google.com/app',
          action_id: 'open_gemini_web',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':mortar_board: 大学生のGemini Pro無料登録',
            emoji: true,
          },
          url: 'https://goo.gle/geministudentfree_graduate-school-of-nihon-university',
          action_id: 'student_gemini_free',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: ':heart: 開発者にお金をあげる',
            emoji: true,
          },
          url: 'https://github.com/sponsors/Shirashoji',
          action_id: 'sponsor_dev',
        },
      ],
    },
  ];
}

function postSupplementaryBlocks(channel, thread_ts) {
  const blocks = buildSupplementaryBlocks();
  const payload = { channel, thread_ts, text: '参考リンク', blocks };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet('INFO', 'Posting supplementary Block Kit message');
    UrlFetchApp.fetch(SLACK_POST_MESSAGE_URL, options);
  } catch (e) {
    logToSheet('ERROR', 'Failed to post supplementary blocks: ' + e);
  }
}

function fetchSlackFile(fileUrl) {
  try {
    const options = {
      headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    };
    const response = UrlFetchApp.fetch(fileUrl, options);
    return response.getBlob();
  } catch (e) {
    logToSheet('ERROR', `Failed to fetch Slack file at ${fileUrl}: ${e}`);
    return null;
  }
}

function processSlackFiles(files) {
  if (!files || files.length === 0) return [];

  const supportedMimeTypes = {
    'image/jpeg': true,
    'image/png': true,
    'image/gif': true,
    'image/webp': true,
  };

  return files
    .map((file) => {
      if (supportedMimeTypes[file.mimetype]) {
        logToSheet(
          'INFO',
          `Processing supported file: ${file.name} (${file.mimetype})`,
        );
        const blob = fetchSlackFile(file.url_private);
        if (blob) {
          return {
            inline_data: {
              mime_type: blob.getContentType(),
              data: Utilities.base64Encode(blob.getBytes()),
            },
          };
        }
      } else {
        logToSheet(
          'INFO',
          `Skipping unsupported file: ${file.name} (${file.mimetype})`,
        );
      }
      return null;
    })
    .filter((f) => f !== null);
}

function getBotUserIds(json) {
  let ids = [];
  if (json.authed_users) {
    ids = ids.concat(json.authed_users);
  }
  if (json.authorizations) {
    ids = ids.concat(json.authorizations.map((a) => a.user_id));
  }
  // 重複を排除して返す
  return [...new Set(ids.filter((id) => id))];
}

function cleanQuery(text, botUserIds) {
  if (!text) return '';
  let query = text;
  botUserIds.forEach((id) => {
    const re = new RegExp(`<@${id}>\\s*`, 'g');
    query = query.replace(re, '');
  });
  return query.trim();
}

function isDuplicateSlackEvent(eventId) {
  const cache = CacheService.getScriptCache();
  const key = 'evt_' + eventId;
  if (cache.get(key)) {
    return true;
  }
  cache.put(key, '1', DUP_EVENT_CACHE_TTL);
  return false;
}

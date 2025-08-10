const GEMINI_API_KEY =
  PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const SLACK_BOT_TOKEN =
  PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
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
        if (m && m[1]) {
          console.log('Fallback regex challenge extraction success');
          return ContentService.createTextOutput(m[1]).setMimeType(
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

    // --- Step 1.5: Post "Please wait" and create trigger ---
    try {
      // 先に「思考中」のメッセージを投稿
      const waitMsgResponse = postToSlack(channel, '思考中です...', thread_ts);
      const message_ts = waitMsgResponse ? waitMsgResponse.ts : null;

      if (!message_ts) {
        throw new Error("Failed to get message_ts for 'wait' message.");
      }

      // トリガーに渡すペイロードを準備
      const triggerPayload = {
        question: query,
        channel: channel,
        thread_ts: thread_ts,
        message_ts: message_ts, // 更新対象のメッセージTS
        files: files, // ファイル情報を追加
        botUserIds: botUserIds, // Bot IDリストを追加
      };

      // トリガーを作成して非同期処理へ
      const trigger = ScriptApp.newTrigger('triggeredGeminiHandler')
        .forUser(Session.getEffectiveUser())
        .timeBased()
        .after(1000) // 1秒後
        .create();

      // トリガーIDをキーにしてペイロードをキャッシュに保存
      const cache = CacheService.getScriptCache();
      cache.put(trigger.getUniqueId(), JSON.stringify(triggerPayload), 600);

      logToSheet(
        'INFO',
        `Trigger ${trigger.getUniqueId()} created for channel ${channel}.`,
      );
    } catch (err) {
      logToSheet(
        'ERROR',
        `doPost processing error: ${err}\nStack: ${err && err.stack}`,
      );
      // エラーが発生してもACKは返す
    }
  } else {
    logToSheet('INFO', 'Event ignored (unsupported type or missing text)');
  }

  return ack; // Slackへは即時ACK
}

/**
 * Step 2: Executed by the trigger a few seconds after doPost completes.
 * This function does the slow work of calling the Gemini API and posting the result.
 */
function triggeredGeminiHandler(e) {
  const triggerId = e.triggerUid;
  logToSheet('INFO', `Trigger ${triggerId} fired.`);

  try {
    // Retrieve the event data from the cache using the trigger ID.
    const cache = CacheService.getScriptCache();
    const cacheKey = triggerId;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
      logToSheet('INFO', `Found cached data for trigger ${triggerId}.`);
      const { question, channel, thread_ts, message_ts, files, botUserIds } =
        JSON.parse(cachedData);

      // --- スレッド履歴とファイル処理 ---
      const history = getThreadHistory(channel, thread_ts, botUserIds);
      const filesData = processSlackFiles(files); // ファイルを処理

      // --- Gemini API呼び出し ---
      const geminiResponse = getGeminiResponse(question, history, filesData);

      // --- Slackへ返信 (メッセージを更新) ---
      updateSlackMessage(channel, message_ts, geminiResponse);
    } else {
      logToSheet(
        'ERROR',
        `No cached data found for trigger ${triggerId}. It may have expired.`,
      );
    }
  } catch (error) {
    logToSheet(
      'ERROR',
      `Error in triggeredGeminiHandler: ${error.toString()}\nStack: ${error.stack}`,
    );
  } finally {
    // IMPORTANT: Delete the trigger so it doesn't run again.
    const allTriggers = ScriptApp.getProjectTriggers();
    for (const trigger of allTriggers) {
      if (trigger.getUniqueId() === triggerId) {
        ScriptApp.deleteTrigger(trigger);
        logToSheet('INFO', `Trigger ${triggerId} deleted.`);
        break;
      }
    }
  }
}

// --- Helper Functions ---

function getGeminiResponse(question, history = [], filesData = []) {
  const systemInstruction = `あなたは優秀なアシスタントです。Slackのスレッドでの会話の文脈を考慮し、提供された情報（テキストや画像）に基づいて回答を生成してください。回答はSlackで表示されるため、Slack独自のMarkdown形式である「mrkdwn」を使用してフォーマットしてください。例えば、太字は *テキスト* 、リストは • のような形式です。回答の最後には、"この回答はGoogle Geminiによって生成されており、不正確な場合があります。不明な点は講師にご質問ください。"という注意書きを必ず含めてください。`;

  let parts = [];
  // ユーザーの現在の質問(テキスト)を追加
  if (question) {
    parts.push({ text: question });
  }
  // 処理されたファイル(画像)を追加
  if (filesData && filesData.length > 0) {
    parts = parts.concat(filesData);
  }
  // テキストもファイルもない場合はエラー
  if (parts.length === 0) {
    return '質問のテキストまたはファイルが見つかりませんでした。';
  }

  // 履歴と今回の発言を結合
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
      max_output_tokens: 8192,
      stop_sequences: [],
    },
    safety_settings: [
      // 安全性設定は要件に応じて調整
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
  };

  try {
    logToSheet(
      'INFO',
      'Sending request to Gemini API: ' + JSON.stringify(payload, null, 2),
    );
    const response = UrlFetchApp.fetch(GEMINI_API_URL, options);
    const responseText = response.getContentText();
    logToSheet('INFO', 'Received response from Gemini API: ' + responseText);
    const data = JSON.parse(responseText);

    if (
      data.candidates &&
      data.candidates.length > 0 &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts.length > 0
    ) {
      return data.candidates[0].content.parts[0].text;
    } else if (data.promptFeedback) {
      // プロンプトフィードバックがある場合 (ブロックされたなど)
      logToSheet(
        'WARN',
        'Gemini API prompt feedback: ' +
          JSON.stringify(data.promptFeedback, null, 2),
      );
      return `回答を生成できませんでした。入力内容が安全性ポリシーに違反している可能性があります。 (Reason: ${data.promptFeedback.blockReason || 'Unknown'})`;
    } else {
      logToSheet(
        'ERROR',
        'Invalid Gemini API response format: ' + responseText,
      );
      return 'Geminiからの回答を正しく解析できませんでした。';
    }
  } catch (error) {
    logToSheet(
      'ERROR',
      `Error fetching from Gemini API: ${error.toString()}\nStack: ${error.stack}`,
    );
    return 'エラーが発生しました。時間をおいて再度お試しください。';
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
      `${SLACK_REPLIES_URL}?channel=${channel}&ts=${thread_ts}`,
      options,
    );
    const json = JSON.parse(response.getContentText());

    if (json.ok && json.messages) {
      logToSheet(
        'INFO',
        `Fetched ${json.messages.length} messages from thread.`,
      );
      // Gemini APIの 'contents' 形式に変換
      return json.messages
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

function updateSlackMessage(channel, ts, text) {
  const payload = { channel: channel, ts: ts, text: text };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet('INFO', 'Updating Slack message: ' + JSON.stringify(payload));
    const response = UrlFetchApp.fetch(SLACK_UPDATE_MESSAGE_URL, options);
    logToSheet(
      'INFO',
      'Response from Slack API (update): ' + response.getContentText(),
    );
  } catch (error) {
    logToSheet('ERROR', `Error updating Slack message: ${error}`);
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

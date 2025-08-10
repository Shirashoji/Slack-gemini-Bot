const GEMINI_API_KEY =
  PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
const SLACK_BOT_TOKEN =
  PropertiesService.getScriptProperties().getProperty("SLACK_BOT_TOKEN");
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_UPDATE_MESSAGE_URL = "https://slack.com/api/chat.update"; // 追加
const DUP_EVENT_CACHE_TTL = 600; // 秒: 同一イベントIDを保持して再処理防止 (10分)

// --- Logger Function ---
function logToSheet(level, message) {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = spreadsheet.getSheetByName("Logs");
    if (!sheet) {
      sheet = spreadsheet.insertSheet("Logs");
    }
    const timestamp = new Date();
    const messageStr =
      typeof message === "object" ? JSON.stringify(message, null, 2) : message;
    sheet.appendRow([timestamp, level, messageStr]);
  } catch (e) {
    console.error("Failed to log to spreadsheet: " + e.toString());
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
  // 受信内容ログ
  try {
    logToSheet(
      "INFO",
      `Raw doPost payload: ${e && e.postData && e.postData.contents}`,
    );
  } catch (_) {}

  // まずSlackへ即時ACKするための空JSONレスポンスを先に準備
  var ack = ContentService.createTextOutput("{}").setMimeType(
    ContentService.MimeType.JSON,
  );

  if (!e || !e.postData || !e.postData.contents) {
    logToSheet("ERROR", "No postData.contents in request");
    return ack;
  }

  var json;
  try {
    json = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    logToSheet("ERROR", `JSON parse error: ${parseErr}`);
    return ack;
  }

  // --- 重複イベント抑止 (Slack再送による多重回答防止) ---
  try {
    if (json.event_id) {
      if (isDuplicateSlackEvent(json.event_id)) {
        logToSheet("INFO", `Duplicate event skipped: ${json.event_id}`);
        return ack;
      }
    } else {
      logToSheet("WARN", "event_id not found (cannot deduplicate)");
    }
  } catch (dupErr) {
    logToSheet("ERROR", `Duplicate check error: ${dupErr}`);
  }

  // SlackのURL検証 (Events API) challenge
  if (json.challenge) {
    logToSheet("INFO", "Responding to Slack URL verification challenge");
    return ContentService.createTextOutput(json.challenge).setMimeType(
      ContentService.MimeType.TEXT,
    );
  }

  // Bot自身のメッセージは無視 (ループ防止)
  if (json.event && json.event.bot_id) {
    logToSheet("INFO", "Ignored bot's own message");
    return ack;
  }

  // 想定イベントのみ処理
  if (
    json.event &&
    (json.event.type === "app_mention" || json.event.type === "message") &&
    json.event.text
  ) {
    var event = json.event;
    var text = event.text;
    var channel = event.channel;
    var thread_ts = event.thread_ts || event.ts;

    // BotユーザーIDを推定: authed_users / authorizations / event.bot_id などの候補をまとめる
    var candidateIds = [];
    if (json.authed_users && json.authed_users.length) {
      candidateIds = candidateIds.concat(json.authed_users);
    }
    if (json.authorizations && json.authorizations.length) {
      candidateIds = candidateIds.concat(
        json.authorizations.map(function (a) {
          return a.user_id;
        }),
      );
    }
    // 重複排除
    candidateIds = candidateIds.filter(function (x, i, arr) {
      return x && arr.indexOf(x) === i;
    });

    var query = text;
    if (candidateIds.length) {
      // すべてのBot自身メンションを除去
      candidateIds.forEach(function (id) {
        var re = new RegExp(`<@${id}>\\s*`, "g");
        query = query.replace(re, "");
      });
      query = query.trim();
    } else {
      // 最低限: 先頭の1つ目のユーザー メンションを除去 (一般化)
      query = query.replace(/^<@[^>]+>\s*/, "").trim();
    }

    logToSheet("INFO", `Parsed query: ${query}`);

    try {
      var geminiResponse = callGeminiAPI(query);
      postMessageToSlack(channel, geminiResponse, thread_ts);
    } catch (err) {
      logToSheet(
        "ERROR",
        `Processing error: ${err}\nStack: ${err && err.stack}`,
      );
      postMessageToSlack(channel, "内部エラーが発生しました。", thread_ts);
    }
  } else {
    logToSheet("INFO", "Event ignored (unsupported type or missing text)");
  }

  return ack; // Slackへは即時ACK
}

/**
 * Step 2: Executed by the trigger a few seconds after doPost completes.
 * This function does the slow work of calling the Gemini API and posting the result.
 */
function triggeredGeminiHandler(e) {
  const triggerId = e.triggerUid;
  logToSheet("INFO", `Trigger ${triggerId} fired.`);

  try {
    // Retrieve the event data from the cache using the trigger ID.
    const cache = CacheService.getScriptCache();
    const cacheKey = triggerId;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
      logToSheet("INFO", `Found cached data for trigger ${triggerId}.`);
      const { question, channel, thread_ts, message_ts } =
        JSON.parse(cachedData);

      // Do the slow work.
      const geminiResponse = getGeminiResponse(question);

      // Update the original "Please wait" message with the Gemini response.
      if (message_ts) {
        updateSlackMessage(channel, message_ts, geminiResponse);
      } else {
        // Fallback in case message_ts was not found, post a new message.
        logToSheet(
          "WARN",
          `message_ts not found for trigger ${triggerId}. Posting a new message instead of updating.`,
        );
        postToSlack(channel, geminiResponse, thread_ts);
      }
    } else {
      logToSheet(
        "ERROR",
        `No cached data found for trigger ${triggerId}. It may have expired.`,
      );
    }
  } catch (error) {
    logToSheet(
      "ERROR",
      `Error in triggeredGeminiHandler: ${error.toString()}\nStack: ${error.stack}`,
    );
  } finally {
    // IMPORTANT: Delete the trigger so it doesn't run again.
    const allTriggers = ScriptApp.getProjectTriggers();
    for (const trigger of allTriggers) {
      if (trigger.getUniqueId() === triggerId) {
        ScriptApp.deleteTrigger(trigger);
        logToSheet("INFO", `Trigger ${triggerId} deleted.`);
        break;
      }
    }
  }
}

// --- Helper Functions ---

function getGeminiResponse(question) {
  const prompt = `
あなたは優秀なアシスタントです。以下の質問に対して、回答を生成してください。

質問:
${question}

---

回答を生成する際のルール:
- 回答はSlackで表示されるため、Slack独自のMarkdown形式である「mrkdwn」を使用してフォーマットしてください。例えば、太字は *テキスト* 、リストは • のような形式です。
- Google Geminiで回答を生成していて正確でない可能性があること、わからない場合は講師に質問をすることを伝えてください。
- 質問の意図が明瞭でない場合は、講師に伝わりやすいようにするため、質問としてどのようにすれば明瞭になるのかを具体的に伝えてください。
`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet("INFO", "Sending request to Gemini API...");
    const response = UrlFetchApp.fetch(GEMINI_API_URL, options);
    const responseText = response.getContentText();
    logToSheet("INFO", "Received response from Gemini API: " + responseText);
    const data = JSON.parse(responseText);
    if (
      data.candidates &&
      data.candidates.length > 0 &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts.length > 0
    ) {
      return data.candidates[0].content.parts[0].text;
    } else {
      logToSheet(
        "ERROR",
        "Invalid Gemini API response format: " + JSON.stringify(data, null, 2),
      );
      return "Geminiからの回答を正しく解析できませんでした。";
    }
  } catch (error) {
    logToSheet(
      "ERROR",
      `Error fetching from Gemini API: ${error.toString()}\nStack: ${error.stack}`,
    );
    return "エラーが発生しました。時間をおいて再度お試しください。";
  }
}

// 互換維持: 旧名称呼び出しのためのラッパー
function callGeminiAPI(query) {
  return getGeminiResponse(query);
}

// 修正: レスポンスをパースして返す
function postToSlack(channel, text, thread_ts) {
  const payload = { channel: channel, text: text, thread_ts: thread_ts };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet(
      "INFO",
      "Posting message to Slack: " + JSON.stringify(payload, null, 2),
    );
    const response = UrlFetchApp.fetch(SLACK_POST_MESSAGE_URL, options);
    const responseBody = response.getContentText();
    logToSheet("INFO", "Response from Slack API: " + responseBody);
    return JSON.parse(responseBody);
  } catch (error) {
    logToSheet(
      "ERROR",
      `Error posting to Slack: ${error.toString()}\nStack: ${error.stack}`,
    );
    return null;
  }
}

// 互換維持: 元コードで呼ばれている名称
function postMessageToSlack(channel, text, thread_ts) {
  return postToSlack(channel, text, thread_ts);
}

// --- Duplicate Event Control ---
function isDuplicateSlackEvent(eventId) {
  var cache = CacheService.getScriptCache();
  var key = "evt_" + eventId;
  var exists = cache.get(key);
  if (exists) return true;
  cache.put(key, "1", DUP_EVENT_CACHE_TTL);
  return false;
}

// 追加: Slackメッセージを更新する関数
function updateSlackMessage(channel, ts, text) {
  const payload = {
    channel: channel,
    ts: ts,
    text: text,
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload),
  };
  try {
    logToSheet(
      "INFO",
      "Updating Slack message: " + JSON.stringify(payload, null, 2),
    );
    const response = UrlFetchApp.fetch(SLACK_UPDATE_MESSAGE_URL, options);
    logToSheet(
      "INFO",
      "Response from Slack API (update): " + response.getContentText(),
    );
  } catch (error) {
    logToSheet(
      "ERROR",
      `Error updating Slack message: ${error.toString()}\nStack: ${error.stack}`,
    );
  }
}

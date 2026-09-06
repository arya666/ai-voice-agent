const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");
const { Vonage } = require("@vonage/server-sdk");

// =========================
// CONFIG
// =========================

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VONAGE_APPLICATION_ID = process.env.VONAGE_APPLICATION_ID;

const GEMINI_MODEL = "gemini-3.1-flash-live-preview";

const RENDER_URL =
  "https://ai-voice-agent-kvh8.onrender.com";

const PRIVATE_KEY_PATH = "/etc/secrets/private.key";

// =========================
// VONAGE
// =========================

let vonage = null;

try {
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");

  vonage = new Vonage({
    applicationId: VONAGE_APPLICATION_ID,
    privateKey: privateKey,
  });

  console.log("Vonage SDK initialized");
} catch (error) {
  console.error("Vonage SDK initialization error:", error);
}

// =========================
// OUTBOUND CALL
// =========================

async function makeTestCall(toNumber) {
  console.log("Starting outbound call to:", toNumber);

  if (!vonage) {
    throw new Error("Vonage SDK is not initialized");
  }

  const response = await vonage.voice.createOutboundCall({
    to: [
      {
        type: "phone",
        number: toNumber,
      },
    ],
    from: {
      type: "phone",
      number: "123456789",
    },
    answer_url: [
      `${RENDER_URL}/vonage/answer`,
    ],
  });

  console.log("Vonage call response:", response);

  return response;
}

// =========================
// GEMINI AUDIO RESAMPLING
// =========================

function resample24kTo16k(buffer) {
  const inputSamples = buffer.length / 2;

  if (inputSamples <= 1) {
    return buffer;
  }

  const outputSamples = Math.floor(inputSamples * 16000 / 24000);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sourcePosition = i * 24000 / 16000;

    const index = Math.floor(sourcePosition);
    const fraction = sourcePosition - index;

    const i1 = Math.min(index, inputSamples - 1);
    const i2 = Math.min(index + 1, inputSamples - 1);

    const sample1 = buffer.readInt16LE(i1 * 2);
    const sample2 = buffer.readInt16LE(i2 * 2);

    const sample =
      sample1 + (sample2 - sample1) * fraction;

    output.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(sample))),
      i * 2
    );
  }

  return output;
}

// =========================
// HTTP SERVER
// =========================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    // -------------------------
    // HEALTH
    // -------------------------

    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
      });

      res.end("AI Voice Agent is running");
      return;
    }

    // -------------------------
    // TEST OUTBOUND CALL
    // -------------------------

    if (
      url.pathname === "/test-call" &&
      req.method === "GET"
    ) {
      const to = url.searchParams.get("to");

      if (!to) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "Missing ?to=PHONE_NUMBER",
          })
        );

        return;
      }

      try {
        const result = await makeTestCall(to);

        res.writeHead(200, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: true,
            result: result,
          })
        );
      } catch (error) {
        console.error("Outbound call error:", error);

        res.writeHead(500, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: false,
            error: error.message,
            details: error.response?.data || null,
          })
        );
      }

      return;
    }

    // -------------------------
    // VONAGE ANSWER WEBHOOK
    // -------------------------

    if (
      url.pathname === "/vonage/answer" &&
      req.method === "GET"
    ) {
      const ncco = [
        {
          action: "connect",
          eventUrl: [
            `${RENDER_URL}/vonage/event`,
          ],
          endpoint: [
            {
              type: "websocket",
              uri: `${RENDER_URL.replace(
                "https://",
                "wss://"
              )}/vonage`,
              "content-type": "audio/l16;rate=16000",
            },
          ],
        },
      ];

      console.log("Vonage Answer NCCO sent");

      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      res.end(JSON.stringify(ncco));
      return;
    }

    // -------------------------
    // VONAGE EVENT WEBHOOK
    // -------------------------

    if (
      url.pathname === "/vonage/event" &&
      req.method === "POST"
    ) {
      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        console.log("Vonage event:", body);

        res.writeHead(200, {
          "Content-Type": "application/json",
        });

        res.end(JSON.stringify({ ok: true }));
      });

      return;
    }

    // -------------------------
    // 404
    // -------------------------

    res.writeHead(404, {
      "Content-Type": "text/plain",
    });

    res.end("Not found");
  } catch (error) {
    console.error("HTTP server error:", error);

    res.writeHead(500, {
      "Content-Type": "text/plain",
    });

    res.end("Internal server error");
  }
});

// =========================
// WEBSOCKET SERVER
// =========================

const wss = new WebSocket.Server({
  noServer: true,
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  if (url.pathname !== "/vonage") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(
    request,
    socket,
    head,
    (ws) => {
      wss.emit("connection", ws, request);
    }
  );
});

// =========================
// VONAGE <-> GEMINI
// =========================

wss.on("connection", (vonageWs) => {
  console.log("WebSocket connected: /vonage");

  let geminiWs = null;
  let vonageOpen = true;

  const audioQueue = [];

  function sendQueuedAudio() {
    while (
      audioQueue.length > 0 &&
      geminiWs &&
      geminiWs.readyState === WebSocket.OPEN
    ) {
      const audio = audioQueue.shift();

      geminiWs.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: audio.toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          },
        })
      );
    }
  }

  // =========================
  // CONNECT GEMINI
  // =========================

  const geminiUrl =
    `wss://generativelanguage.googleapis.com/ws/` +
    `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
    `?key=${GEMINI_API_KEY}`;

  geminiWs = new WebSocket(geminiUrl);

  geminiWs.on("open", () => {
    console.log("Gemini WebSocket connected");

    const setupMessage = {
      setup: {
        model: `models/${GEMINI_MODEL}`,

        generationConfig: {
          responseModalities: ["AUDIO"],

          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Kore",
              },
            },
          },

          thinkingConfig: {
            thinkingLevel: "minimal",
          },
        },

        systemInstruction: {
          parts: [
            {
              text:
                "You are a professional AI phone assistant " +
                "for a German construction and renovation company. " +
                "Speak naturally and briefly in German. " +
                "Be friendly, professional and helpful. " +
                "Ask clear questions about the customer's project. " +
                "Do not invent prices or promises.",
            },
          ],
        },
      },
    };

    geminiWs.send(
      JSON.stringify(setupMessage)
    );
  });

  // =========================
  // GEMINI MESSAGES
  // =========================

  geminiWs.on("message", (data) => {
    try {
      const message = JSON.parse(
        data.toString()
      );

      // -------------------------
      // SETUP COMPLETE
      // -------------------------

      if (message.setupComplete) {
        console.log("Gemini setup complete");

        sendQueuedAudio();

        geminiWs.send(
          JSON.stringify({
            realtimeInput: {
              text:
                "The phone call has just started. " +
                "Greet the caller briefly in German " +
                "and ask how you can help.",
            },
          })
        );

        return;
      }

      // -------------------------
      // INTERRUPTION
      // -------------------------

      if (
        message.serverContent &&
        message.serverContent.interrupted
      ) {
        if (
          vonageWs.readyState === WebSocket.OPEN
        ) {
          vonageWs.send(
            JSON.stringify({
              action: "clear",
            })
          );
        }

        return;
      }

      // -------------------------
      // GEMINI AUDIO OUTPUT
      // -------------------------

      const parts =
        message.serverContent?.modelTurn?.parts;

      if (!Array.isArray(parts)) {
        return;
      }

      for (const part of parts) {
        const inlineData = part.inlineData;

        if (
          inlineData &&
          inlineData.data
        ) {
          const audio24k = Buffer.from(
            inlineData.data,
            "base64"
          );

          const audio16k =
            resample24kTo16k(audio24k);

          if (
            vonageWs.readyState ===
            WebSocket.OPEN
          ) {
            vonageWs.send(audio16k);
          }
        }
      }
    } catch (error) {
      console.error(
        "Gemini message error:",
        error
      );
    }
  });

  // =========================
  // GEMINI ERROR
  // =========================

  geminiWs.on("error", (error) => {
    console.error(
      "Gemini WebSocket error:",
      error
    );
  });

  geminiWs.on("close", () => {
    console.log("Gemini disconnected");
  });

  // =========================
  // VONAGE MESSAGES
  // =========================

  vonageWs.on("message", (data, isBinary) => {
    try {
      // Vonage sends raw PCM audio as binary
      if (isBinary || Buffer.isBuffer(data)) {
        const audioBuffer = Buffer.from(data);

        if (
          geminiWs &&
          geminiWs.readyState ===
            WebSocket.OPEN
        ) {
          geminiWs.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data:
                    audioBuffer.toString(
                      "base64"
                    ),
                  mimeType:
                    "audio/pcm;rate=16000",
                },
              },
            })
          );
        } else {
          audioQueue.push(audioBuffer);
        }

        return;
      }

      // Vonage control messages
      const text = data.toString();

      console.log(
        "Vonage message:",
        text
      );
    } catch (error) {
      console.error(
        "Vonage message error:",
        error
      );
    }
  });

  // =========================
  // VONAGE DISCONNECT
  // =========================

  vonageWs.on("close", () => {
    vonageOpen = false;

    console.log(
      "Vonage disconnected"
    );

    if (
      geminiWs &&
      geminiWs.readyState ===
        WebSocket.OPEN
    ) {
      geminiWs.close();
    }
  });

  vonageWs.on("error", (error) => {
    console.error(
      "Vonage WebSocket error:",
      error
    );
  });
});

// =========================
// START SERVER
// =========================

server.listen(PORT, () => {
  console.log(
    `Server listening on port ${PORT}`
  );
});

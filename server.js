const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VONAGE_APPLICATION_ID = process.env.VONAGE_APPLICATION_ID;

const GEMINI_MODEL = "gemini-3.1-flash-live-preview";

const RENDER_URL = "https://ai-voice-agent-kvh8.onrender.com";

const PRIVATE_KEY_PATH = "/etc/secrets/private.key";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createVonageJWT() {
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");

  const now = Math.floor(Date.now() / 1000);

  const header = {
    typ: "JWT",
    alg: "RS256"
  };

  const payload = {
    application_id: VONAGE_APPLICATION_ID,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID()
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));

  const unsignedToken =
    encodedHeader + "." + encodedPayload;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer
    .sign(privateKey)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return unsignedToken + "." + signature;
}

async function makeTestCall(toNumber) {
  const jwt = createVonageJWT();

  const response = await fetch("https://api.nexmo.com/v1/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      to: [
        {
          type: "phone",
          number: toNumber
        }
      ],
      from: {
        type: "phone",
        number: "123456789"
      },
      answer_url: [
        `${RENDER_URL}/vonage/answer`
      ]
    })
  });

  const text = await response.text();

  console.log("Vonage call response:", response.status, text);

  return {
    status: response.status,
    body: text
  };
}

const server = http.createServer(async (req, res) => {

  // Health check
  if (req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("AI Voice Agent is running");
    return;
  }

  // Vonage Answer Webhook
  if (req.url.startsWith("/vonage/answer")) {

    const ncco = [
      {
        action: "connect",
        eventUrl: [
          `${RENDER_URL}/vonage/event`
        ],
        endpoint: [
          {
            type: "websocket",
            uri: `wss://ai-voice-agent-kvh8.onrender.com/vonage`,
            "content-type": "audio/l16;rate=16000"
          }
        ]
      }
    ];

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify(ncco));

    console.log("Vonage Answer NCCO sent");

    return;
  }

  // Vonage Event Webhook
  if (req.url.startsWith("/vonage/event")) {

    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", () => {
      console.log("Vonage event:", body);

      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        ok: true
      }));
    });

    return;
  }

  // TEST OUTBOUND CALL
  if (req.url.startsWith("/test-call")) {

    try {
      const parsedUrl = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      const toNumber = parsedUrl.searchParams.get("to");

      if (!toNumber) {
        res.writeHead(400, {
          "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
          error: "Missing ?to=NUMBER"
        }));

        return;
      }

      console.log("Starting outbound call to:", toNumber);

      const result = await makeTestCall(toNumber);

      res.writeHead(result.status >= 200 && result.status < 300 ? 200 : 500, {
        "Content-Type": "application/json"
      });

      res.end(result.body);

    } catch (error) {

      console.error("Outbound call error:", error);

      res.writeHead(500, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        error: error.message
      }));
    }

    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain"
  });

  res.end("Not found");
});


const wss = new WebSocket.Server({
  server
});


wss.on("connection", (vonageSocket, request) => {

  console.log("WebSocket connected:", request.url);

  if (!request.url.startsWith("/vonage")) {
    vonageSocket.close();
    return;
  }

  let geminiReady = false;
  let geminiSocket = null;

  const queuedAudio = [];

  function sendAudioToGemini(audioBuffer) {

    if (!geminiSocket ||
        geminiSocket.readyState !== WebSocket.OPEN ||
        !geminiReady) {

      queuedAudio.push(audioBuffer);
      return;
    }

    geminiSocket.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: audioBuffer.toString("base64"),
          mimeType: "audio/pcm;rate=16000"
        }
      }
    }));
  }


  function flushAudioQueue() {

    while (queuedAudio.length > 0) {

      const audio = queuedAudio.shift();

      sendAudioToGemini(audio);
    }
  }


  const geminiUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${GEMINI_API_KEY}`;


  geminiSocket = new WebSocket(geminiUrl);


  geminiSocket.on("open", () => {

    console.log("Gemini WebSocket connected");

    geminiSocket.send(JSON.stringify({
      setup: {
        model: `models/${GEMINI_MODEL}`,

        generationConfig: {
          responseModalities: ["AUDIO"],

          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Kore"
              }
            }
          },

          thinkingConfig: {
            thinkingLevel: "minimal"
          }
        },

        systemInstruction: {
          parts: [
            {
              text:
                "You are a professional AI phone assistant for a German construction and renovation company. " +
                "Speak naturally and briefly in German. " +
                "Be friendly, professional and helpful. " +
                "Ask clear questions about the customer's project. " +
                "Do not invent prices or promises."
            }
          ]
        }
      }
    }));
  });


  geminiSocket.on("message", data => {

    try {

      const message = JSON.parse(data.toString());

      if (message.setupComplete) {

        console.log("Gemini setup complete");

        geminiReady = true;

        flushAudioQueue();

        geminiSocket.send(JSON.stringify({
          realtimeInput: {
            text:
              "The phone call has just started. " +
              "Greet the caller briefly in German and ask how you can help."
          }
        }));

        return;
      }


      if (message.serverContent) {

        if (message.serverContent.interrupted) {

          console.log("Gemini interrupted");

          try {
            vonageSocket.send(
              JSON.stringify({
                action: "clear"
              })
            );
          } catch (e) {}

          return;
        }


        const parts =
          message.serverContent.modelTurn?.parts || [];


        for (const part of parts) {

          if (
            part.inlineData &&
            part.inlineData.data
          ) {

            const audio24k = Buffer.from(
              part.inlineData.data,
              "base64"
            );

            const audio16k =
              resample24kTo16k(audio24k);

            if (
              vonageSocket.readyState ===
              WebSocket.OPEN
            ) {
              vonageSocket.send(audio16k);
            }
          }
        }
      }

    } catch (error) {

      console.error(
        "Gemini message parse error:",
        error
      );
    }
  });


  geminiSocket.on("error", error => {

    console.error(
      "Gemini WebSocket error:",
      error.message
    );
  });


  geminiSocket.on("close", (code, reason) => {

    console.log(
      "Gemini disconnected:",
      code,
      reason.toString()
    );
  });


  vonageSocket.on("message", data => {

    if (Buffer.isBuffer(data)) {

      sendAudioToGemini(data);

      return;
    }


    try {

      const message = JSON.parse(
        data.toString()
      );

      console.log(
        "Vonage message:",
        message
      );

    } catch (error) {

      console.log(
        "Vonage non-JSON message:",
        data.toString()
      );
    }
  });


  vonageSocket.on("close", () => {

    console.log("Vonage disconnected");

    if (
      geminiSocket &&
      geminiSocket.readyState === WebSocket.OPEN
    ) {
      geminiSocket.close();
    }
  });


  vonageSocket.on("error", error => {

    console.error(
      "Vonage WebSocket error:",
      error.message
    );
  });

});


function resample24kTo16k(buffer) {

  const inputSamples = buffer.length / 2;

  const outputSamples =
    Math.floor(inputSamples * 16000 / 24000);

  const output = Buffer.alloc(
    outputSamples * 2
  );

  for (let i = 0; i < outputSamples; i++) {

    const sourcePosition =
      i * 24000 / 16000;

    const index =
      Math.floor(sourcePosition);

    const fraction =
      sourcePosition - index;

    const sample1 =
      buffer.readInt16LE(
        Math.min(index, inputSamples - 1) * 2
      );

    const sample2 =
      buffer.readInt16LE(
        Math.min(index + 1, inputSamples - 1) * 2
      );

    const sample =
      sample1 +
      (sample2 - sample1) * fraction;

    output.writeInt16LE(
      Math.max(
        -32768,
        Math.min(
          32767,
          Math.round(sample)
        )
      ),
      i * 2
    );
  }

  return output;
}


server.listen(PORT, () => {

  console.log(
    `Server listening on port ${PORT}`
  );

});

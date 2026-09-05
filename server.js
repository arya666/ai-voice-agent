const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const GEMINI_MODEL = "gemini-3.1-flash-live-preview";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("AI Voice Agent is running");
});

const wss = new WebSocket.Server({ server });

function muLawToPCM16(muLaw) {
  const out = Buffer.alloc(muLaw.length * 2);

  for (let i = 0; i < muLaw.length; i++) {
    let u = (~muLaw[i]) & 0xff;
    let sign = u & 0x80;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0f;

    let sample = ((mantissa << 3) + 132) << exponent;
    sample -= 132;

    if (sign) {
      sample = -sample;
    }

    out.writeInt16LE(sample, i * 2);
  }

  return out;
}

function pcm16ToMuLaw(pcm) {
  const out = Buffer.alloc(Math.floor(pcm.length / 2));

  for (let i = 0; i < out.length; i++) {
    let sample = pcm.readInt16LE(i * 2);

    let sign = sample < 0 ? 0x80 : 0;

    if (sample < 0) {
      sample = -sample;
    }

    if (sample > 32635) {
      sample = 32635;
    }

    sample += 132;

    let exponent = 7;

    for (
      let mask = 0x4000;
      (sample & mask) === 0 && exponent > 0;
      mask >>= 1
    ) {
      exponent--;
    }

    let mantissa = (sample >> (exponent + 3)) & 0x0f;
    let value = ~(sign | (exponent << 4) | mantissa);

    out[i] = value & 0xff;
  }

  return out;
}

function upsample8kTo16k(pcm8) {
  const samples = pcm8.length / 2;
  const out = Buffer.alloc(samples * 4);

  for (let i = 0; i < samples; i++) {
    const sample = pcm8.readInt16LE(i * 2);

    out.writeInt16LE(sample, i * 4);
    out.writeInt16LE(sample, i * 4 + 2);
  }

  return out;
}

function downsample24kTo8k(pcm24) {
  const samples = pcm24.length / 2;
  const outputSamples = Math.floor(samples / 3);
  const pcm8 = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sample = pcm24.readInt16LE(i * 3 * 2);
    pcm8.writeInt16LE(sample, i * 2);
  }

  return pcm16ToMuLaw(pcm8);
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  const geminiUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    "?key=" +
    GEMINI_API_KEY;

  const geminiWs = new WebSocket(geminiUrl);

  geminiWs.on("open", () => {
    console.log("Gemini connected");

    geminiWs.send(
      JSON.stringify({
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
            }
          },

          systemInstruction: {
            parts: [
              {
                text:
                  "Du bist ein freundlicher professioneller deutscher Telefonassistent. " +
                  "Sprich natürlich, kurz und menschlich. " +
                  "Unterbrich den Anrufer nicht. " +
                  "Antworte auf Deutsch. " +
                  "Wenn du etwas nicht weißt, sage es ehrlich."
              }
            ]
          }
        }
      })
    );
  });

  geminiWs.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      const parts =
        message?.serverContent?.modelTurn?.parts || [];

      for (const part of parts) {
        const audioBase64 = part?.inlineData?.data;

        if (!audioBase64 || !streamSid) {
          continue;
        }

        const pcm24 = Buffer.from(audioBase64, "base64");
        const mulaw8 = downsample24kTo8k(pcm24);

        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: {
                payload: mulaw8.toString("base64")
              }
            })
          );
        }
      }
    } catch (err) {
      console.error("Gemini message error:", err.message);
    }
  });

  twilioWs.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.event === "start") {
        streamSid = message.start.streamSid;
        console.log("Stream started:", streamSid);
      }

      if (
        message.event === "media" &&
        message.media?.payload &&
        geminiWs.readyState === WebSocket.OPEN
      ) {
        const mulaw8 = Buffer.from(
          message.media.payload,
          "base64"
        );

        const pcm8 = muLawToPCM16(mulaw8);
        const pcm16 = upsample8kTo16k(pcm8);

        geminiWs.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: pcm16.toString("base64"),
                mimeType: "audio/pcm;rate=16000"
              }
            }
          })
        );
      }

      if (message.event === "stop") {
        console.log("Twilio stream stopped");

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close();
        }
      }
    } catch (err) {
      console.error("Twilio message error:", err.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");

    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  geminiWs.on("close", () => {
    console.log("Gemini disconnected");
  });

  geminiWs.on("error", (err) => {
    console.error("Gemini WebSocket error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

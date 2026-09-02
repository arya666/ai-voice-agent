let sign = sample < 0 ? 0x80 : 0;
if (sample < 0) sample = -sample;

if (sample > 32635) sample = 32635;

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
geminiWs.send(JSON.stringify({
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
}));
});
geminiWs.on("message", (data) => { try { const message = JSON.parse(data.toString());
  const parts =
    message?.serverContent?.modelTurn?.parts || [];

  for (const part of parts) {
    const audioBase64 = part?.inlineData?.data;

    if (!audioBase64 || !streamSid) continue;

    const pcm24 = Buffer.from(audioBase64, "base64");

    const mulaw8 = downsample24kTo8k(pcm24);

    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload: mulaw8.toString("base64")
      }
    }));
  }
} catch (err) {
  console.error("Gemini message error:", err.message);
}
});
twilioWs.on("message", (data) => { try { const message = JSON.parse(data.toString());
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

    geminiWs.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: pcm16.toString("base64"),
          mimeType: "audio/pcm;rate=16000"
        }
      }
    }));
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
twilioWs.on("close", () => { console.log("Twilio disconnected");
if (geminiWs.readyState === WebSocket.OPEN) {
  geminiWs.close();
}
});
geminiWs.on("close", () => { console.log("Gemini disconnected"); });
geminiWs.on("error", (err) => { console.error("Gemini WebSocket error:", err.message); }); });
server.listen(PORT, () => { console.log(Server listening on port ${PORT}); });

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL = "gemini-3.1-flash-live-preview";

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

/*
============================================================
AI VOICE AGENT
Vonage <-> Render <-> Gemini Live
============================================================
*/


/*
============================================================
HTTP SERVER
============================================================
*/

const server = http.createServer((req, res) => {

  /*
  ----------------------------------------------------------
  Health check
  ----------------------------------------------------------
  */

  if (req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("AI Voice Agent is running");
    return;
  }


  /*
  ----------------------------------------------------------
  Vonage Answer Webhook
  ----------------------------------------------------------
  */

  if (req.url.startsWith("/vonage/answer")) {

    const ncco = [
      {
        action: "connect",

        eventUrl: [
          "https://ai-voice-agent-kvh8.onrender.com/vonage/event"
        ],

        endpoint: [
          {
            type: "websocket",
            uri: "wss://ai-voice-agent-kvh8.onrender.com/vonage",
            "content-type": "audio/l16;rate=16000"
          }
        ]
      }
    ];

    console.log("Vonage Answer NCCO sent");

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify(ncco));
    return;
  }


  /*
  ----------------------------------------------------------
  Vonage Event Webhook
  ----------------------------------------------------------
  */

  if (req.url.startsWith("/vonage/event")) {

    let body = "";

    req.on("data", chunk => {
      body += chunk;
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


  /*
  ----------------------------------------------------------
  404
  ----------------------------------------------------------
  */

  res.writeHead(404);
  res.end("Not Found");
});


/*
============================================================
WEBSOCKET SERVER
============================================================
*/

const wss = new WebSocket.Server({
  server: server
});


wss.on("connection", (vonageWs, request) => {

  const path = request.url || "";

  console.log("WebSocket connected:", path);


  /*
  ----------------------------------------------------------
  Only accept Vonage WebSocket
  ----------------------------------------------------------
  */

  if (!path.startsWith("/vonage")) {

    console.log("Unknown WebSocket path:", path);

    vonageWs.close();
    return;
  }


  /*
  ----------------------------------------------------------
  Connect to Gemini Live
  ----------------------------------------------------------
  */

  const geminiUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    "?key=" +
    encodeURIComponent(GEMINI_API_KEY);


  const geminiWs = new WebSocket(geminiUrl);

  let geminiReady = false;
  let vonageClosed = false;

  const audioQueue = [];


  /*
  ----------------------------------------------------------
  Gemini connected
  ----------------------------------------------------------
  */

  geminiWs.on("open", () => {

    console.log("Gemini WebSocket connected");


    const setupMessage = {

      setup: {

        model: `models/${GEMINI_MODEL}`,

        generationConfig: {

          responseModalities: [
            "AUDIO"
          ],

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
                "You are a professional AI phone assistant " +
                "for a German construction and renovation company. " +
                "Speak naturally, briefly and professionally. " +
                "Speak German unless the caller speaks another language. " +
                "Ask one question at a time. " +
                "Do not give long explanations unless requested. " +
                "You can discuss renovation, construction, tiling, " +
                "flooring, painting and related services. " +
                "If you do not know something, do not invent it."
            }

          ]

        }

      }

    };


    geminiWs.send(
      JSON.stringify(setupMessage)
    );

  });


  /*
  ==========================================================
  GEMINI MESSAGES
  ==========================================================
  */

  geminiWs.on("message", (data) => {

    try {

      const message =
        JSON.parse(data.toString());


      /*
      --------------------------------------------------------
      Setup complete
      --------------------------------------------------------
      */

      if (message.setupComplete) {

        console.log("Gemini setup complete");

        geminiReady = true;


        /*
        Send queued audio
        */

        while (audioQueue.length > 0) {

          const audio =
            audioQueue.shift();

          sendAudioToGemini(
            geminiWs,
            audio
          );

        }


        /*
        ------------------------------------------------------
        Initial greeting
        ------------------------------------------------------

        For Gemini 3.1, realtimeInput is used for
        text updates during the live conversation.
        */

        const greeting = {

          realtimeInput: {

            text:
              "The phone call has just started. " +
              "Greet the caller briefly in German " +
              "and ask how you can help."

          }

        };


        geminiWs.send(
          JSON.stringify(greeting)
        );

        return;
      }


      /*
      --------------------------------------------------------
      Server content
      --------------------------------------------------------
      */

      const serverContent =
        message.serverContent;


      if (!serverContent) {
        return;
      }


      /*
      --------------------------------------------------------
      Caller interrupted Gemini
      --------------------------------------------------------
      */

      if (serverContent.interrupted) {

        console.log(
          "Gemini interrupted"
        );


        if (
          vonageWs.readyState ===
          WebSocket.OPEN
        ) {

          vonageWs.send(
            JSON.stringify({
              action: "clear"
            })
          );

        }

        return;
      }


      /*
      --------------------------------------------------------
      Gemini model audio
      --------------------------------------------------------
      */

      const modelTurn =
        serverContent.modelTurn;


      if (
        !modelTurn ||
        !modelTurn.parts
      ) {

        return;
      }


      for (const part of modelTurn.parts) {

        if (
          !part.inlineData ||
          !part.inlineData.data
        ) {

          continue;
        }


        const mimeType =
          part.inlineData.mimeType || "";


        if (
          !mimeType.startsWith("audio/")
        ) {

          continue;
        }


        /*
        Gemini output:
        PCM16 / 24kHz
        */

        const audio24k =
          Buffer.from(
            part.inlineData.data,
            "base64"
          );


        /*
        Vonage expects:
        PCM16 / 16kHz
        */

        const audio16k =
          resamplePCM16(
            audio24k,
            24000,
            16000
          );


        if (
          vonageWs.readyState ===
          WebSocket.OPEN
        ) {

          vonageWs.send(
            audio16k
          );

        }

      }

    } catch (error) {

      console.error(
        "Gemini message error:",
        error.message
      );

    }

  });


  /*
  ----------------------------------------------------------
  Gemini error
  ----------------------------------------------------------
  */

  geminiWs.on("error", (error) => {

    console.error(
      "Gemini WebSocket error:",
      error.message
    );

  });


  /*
  ----------------------------------------------------------
  Gemini closed
  ----------------------------------------------------------
  */

  geminiWs.on("close", (code, reason) => {

    console.log(
      "Gemini disconnected:",
      code,
      reason.toString()
    );

    geminiReady = false;


    if (
      !vonageClosed &&
      vonageWs.readyState ===
      WebSocket.OPEN
    ) {

      vonageWs.close();

    }

  });


  /*
  ==========================================================
  VONAGE -> GEMINI
  ==========================================================
  */

  vonageWs.on("message", (data, isBinary) => {

    try {

      /*
      --------------------------------------------------------
      Vonage control message
      --------------------------------------------------------
      */

      if (!isBinary) {

        const text =
          data.toString();

        console.log(
          "Vonage message:",
          text
        );

        return;
      }


      /*
      --------------------------------------------------------
      Vonage audio
      --------------------------------------------------------

      PCM16
      16kHz
      */

      const audio =
        Buffer.from(data);


      /*
      Gemini not ready yet
      */

      if (!geminiReady) {

        audioQueue.push(audio);

        return;
      }


      /*
      Send audio to Gemini
      */

      sendAudioToGemini(
        geminiWs,
        audio
      );

    } catch (error) {

      console.error(
        "Vonage audio error:",
        error.message
      );

    }

  });


  /*
  ==========================================================
  VONAGE CLOSED
  ==========================================================
  */

  vonageWs.on("close", () => {

    console.log(
      "Vonage disconnected"
    );

    vonageClosed = true;


    if (
      geminiWs.readyState ===
      WebSocket.OPEN
    ) {

      geminiWs.close();

    }

  });


  /*
  ----------------------------------------------------------
  Vonage WebSocket error
  ----------------------------------------------------------
  */

  vonageWs.on("error", (error) => {

    console.error(
      "Vonage WebSocket error:",
      error.message
    );

  });

});


/*
============================================================
SEND AUDIO TO GEMINI
============================================================
*/

function sendAudioToGemini(
  geminiWs,
  audio
) {

  if (
    geminiWs.readyState !==
    WebSocket.OPEN
  ) {

    return;
  }


  const message = {

    realtimeInput: {

      audio: {

        data:
          audio.toString("base64"),

        mimeType:
          "audio/pcm;rate=16000"

      }

    }

  };


  geminiWs.send(
    JSON.stringify(message)
  );

}


/*
============================================================
PCM16 RESAMPLER
24kHz -> 16kHz
============================================================
*/

function resamplePCM16(
  input,
  inputRate,
  outputRate
) {

  if (
    inputRate === outputRate
  ) {

    return input;
  }


  const inputSamples =
    Math.floor(
      input.length / 2
    );


  const outputSamples =
    Math.floor(
      inputSamples *
      outputRate /
      inputRate
    );


  const output =
    Buffer.alloc(
      outputSamples * 2
    );


  const ratio =
    inputRate / outputRate;


  for (
    let i = 0;
    i < outputSamples;
    i++
  ) {

    const position =
      i * ratio;


    const index =
      Math.floor(position);


    const fraction =
      position - index;


    const index1 =
      Math.min(
        index,
        inputSamples - 1
      );


    const index2 =
      Math.min(
        index + 1,
        inputSamples - 1
      );


    const sample1 =
      input.readInt16LE(
        index1 * 2
      );


    const sample2 =
      input.readInt16LE(
        index2 * 2
      );


    const sample =
      sample1 +
      (sample2 - sample1) *
      fraction;


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


/*
============================================================
START SERVER
============================================================
*/

server.listen(
  PORT,
  () => {

    console.log(
      `Server listening on port ${PORT}`
    );

  }
);

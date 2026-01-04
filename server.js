import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";

// --------------------
// Email (Resend)
// --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// --------------------
// App setup
// --------------------
const app = express();

app.use(cors());

// ⚠️ IMPORTANT FOR TWILIO
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(path.join(process.cwd(), "public")));

// --------------------
// Static routes
// --------------------
app.get("/widget", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "widget", "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "widget", "index.html"));
});

// --------------------
// OpenAI
// --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// 🔊 Text-to-Speech (USED BY VOICE)
// --------------------
app.get("/tts", async (req, res) => {
  try {
    const text = req.query.text;
    if (!text) return res.status(400).send("Missing text");

    const speech = await openai.audio.speech.create({
      model: "tts-1-hd",
      voice: "nova",
      input: text,
      format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    console.error("TTS ERROR:", err.message);
    res.status(500).send("TTS failed");
  }
});

// --------------------
// Web / Widget Chat (UNCHANGED)
// --------------------
app.post("/chat", async (req, res) => {
  try {
    const userMessage =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (!userMessage) {
      return res.json({ reply: "How can I help you today?" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are AirAI, a professional AI assistant for service businesses.",
        },
        { role: "user", content: userMessage },
      ],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.json({ reply: "Sorry — something went wrong." });
  }
});

// --------------------
// SMS Receptionist (UNCHANGED)
// --------------------
app.post("/sms", async (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Message>Thanks! Someone will reach out shortly.</Message>
</Response>
  `);
});

// --------------------
// VOICE RECEPTIONIST
// --------------------

// STEP 1: Ask reason
app.post("/voice/incoming", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Hi%2C%20thank%20you%20for%20calling%20AirAI.</Play>
  <Play>https://${req.headers.host}/tts?text=How%20can%20I%20help%20you%20today%3F</Play>

  <Record
    action="/voice/reason"
    method="POST"
    maxLength="10"
    playBeep="true"
  />
</Response>
  `);
});

// STEP 2: Acknowledge + ask name
app.post("/voice/reason", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Got%20it.</Play>
  <Play>https://${req.headers.host}/tts?text=May%20I%20have%20your%20name%2C%20please%3F</Play>

  <Record
    action="/voice/name"
    method="POST"
    maxLength="5"
    playBeep="true"
  />
</Response>
  `);
});

// STEP 3: Close call + BACKGROUND AI
app.post("/voice/name", async (req, res) => {
  const from = req.body.From;
  const nameRecordingUrl = req.body.RecordingUrl;
  const reasonRecordingUrl = req.body.RecordingUrl?.replace("name", "reason");

  // ✅ Respond to Twilio immediately
  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Thank%20you%20for%20calling.</Play>
  <Play>https://${req.headers.host}/tts?text=Someone%20will%20get%20back%20to%20you%20shortly.</Play>
  <Hangup />
</Response>
  `);

  // --------------------
  // BACKGROUND AI (BEST EFFORT)
  // --------------------
  (async () => {
    try {
      const transcribe = async url => {
        const audioRes = await fetch(`${url}.mp3`);
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

        const transcript = await openai.audio.transcriptions.create({
          file: audioBuffer,
          model: "gpt-4o-transcribe",
        });

        return transcript.text || "";
      };

      const reasonText = reasonRecordingUrl
        ? await transcribe(reasonRecordingUrl)
        : "";

      const nameText = nameRecordingUrl
        ? await transcribe(nameRecordingUrl)
        : "";

      const summaryResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Summarize this phone call in 1–2 short sentences for a business owner.",
          },
          {
            role: "user",
            content: reasonText,
          },
        ],
      });

      const summary = summaryResponse.choices[0].message.content;

      await resend.emails.send({
        from: "AirAI Calls <onboarding@resend.dev>",
        to: ["bruce@airai.dev"],
        subject: "New AirAI Call (AI Summary)",
        text: `
Phone: ${from}

Caller Name (AI):
${nameText || "Not detected"}

Summary:
${summary}

Full Transcript:
${reasonText}
        `,
      });
    } catch (err) {
      console.error("POST-CALL AI FAILED:", err);
    }
  })();
});

// --------------------
// Server start (Railway)
// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

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
// 🔊 TTS ENDPOINT (PRODUCTION READY)
// --------------------
app.get("/tts", async (req, res) => {
  const text = typeof req.query.text === "string" ? req.query.text : "";

  if (!text.trim()) {
    return res.status(400).send("Missing text");
  }

  try {
    const speech = await openai.audio.speech.create({
      model: "tts-1-hd",
      voice: "alloy", // ✅ valid + reliable
      input: text,
      format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(buffer);
  } catch (err) {
    console.error("TTS ERROR:", err);
    res.status(500).send("TTS failed");
  }
});

// --------------------
// Helpers (Twilio-safe URLs)
// --------------------
function baseUrl(req) {
  const proto =
    (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  return `${proto}://${req.headers.host}`;
}

function tts(req, text) {
  return `${baseUrl(req)}/tts?text=${encodeURIComponent(text)}`;
}

// --------------------
// Lead state
// --------------------
let pendingLead = {
  name: null,
  phone: null,
  intentDetected: false,
};

const smsLeads = {};

const buyingIntentKeywords = [
  "quote",
  "price",
  "pricing",
  "estimate",
  "cost",
  "call",
  "contact",
  "book",
  "appointment",
  "service",
  "install",
];

// --------------------
// Web / Widget Chat
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

    return res.json({
      reply: completion.choices[0].message.content,
    });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.json({
      reply: "Sorry — something went wrong.",
    });
  }
});

// --------------------
// SMS Receptionist (Twilio)
// --------------------
app.post("/sms", async (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Message>Hi! How can I help you today?</Message>
</Response>
  `);
});

// --------------------
// VOICE RECEPTIONIST (TWILIO) — TTS ENABLED
// --------------------

// STEP 1: Greeting + reason
app.post("/voice/incoming", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Play>${tts(req, "Hi, thank you for calling AirAI.")}</Play>
  <Play>${tts(req, "How can I help you today?")}</Play>
  <Play>${tts(req, "Please tell me after the tone, then press the pound key.")}</Play>

  <Record
    action="/voice/reason"
    method="POST"
    maxLength="20"
    finishOnKey="#"
    playBeep="true"
  />
</Response>
  `);
});

// STEP 2: Ask for name
app.post("/voice/reason", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Play>${tts(req, "Okay, thank you.")}</Play>
  <Play>${tts(req, "May I have your name, please?")}</Play>
  <Play>${tts(req, "You can say it after the tone, then press the pound key.")}</Play>

  <Record
    action="/voice/name"
    method="POST"
    maxLength="6"
    finishOnKey="#"
    playBeep="true"
  />
</Response>
  `);
});

// STEP 3: Close call + email
app.post("/voice/name", async (req, res) => {
  const from = req.body.From;

  try {
    await resend.emails.send({
      from: "AirAI Calls <onboarding@resend.dev>",
      to: ["bruce@airai.dev"],
      subject: "New AirAI Call",
      text: `New call received.\n\nPhone: ${from}`,
    });
  } catch (err) {
    console.error("VOICE EMAIL FAILED:", err);
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Play>${tts(req, "Perfect, thank you.")}</Play>
  <Play>${tts(req, "Someone will get back to you as soon as possible.")}</Play>
  <Play>${tts(req, "Have a great day.")}</Play>
  <Hangup />
</Response>
  `);
});

// --------------------
// Server start (Railway)
// --------------------
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

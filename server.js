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
  // ✅ unchanged from your original
  res.sendFile(path.join(process.cwd(), "public", "widget", "index.html"));
});

// --------------------
// OpenAI
// --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// 🔊 NEW: Text-to-Speech Endpoint (returns MP3 Twilio can <Play>)
// --------------------
app.get("/tts", async (req, res) => {
  try {
    const text = typeof req.query.text === "string" ? req.query.text : "";

    if (!text.trim()) {
      return res.status(400).send("Missing text");
    }

    // Reliable TTS model. (Docs: Audio API + TTS guide.) :contentReference[oaicite:0]{index=0}
    const speech = await openai.audio.speech.create({
      model: "tts-1-hd",
      // Warmer, more human voices exist; "marin" is a great default for pleasant, natural tone. :contentReference[oaicite:1]{index=1}
      voice: "marin",
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

// Helper: build a safe absolute URL Twilio can reach
function getBaseUrl(req) {
  // If you ever want to hardcode this later, set PUBLIC_BASE_URL in Railway (recommended).
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;

  const proto =
    (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function ttsUrl(req, text) {
  const base = getBaseUrl(req);
  return `${base}/tts?text=${encodeURIComponent(text)}`;
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

    if (!pendingLead.intentDetected && /\b\d{10}\b/.test(userMessage)) {
      return res.json({
        reply:
          "Hi! I can help with pricing, estimates, or services. What can I assist you with?",
      });
    }

    const cleanedMessage = userMessage
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "");

    if (
      !pendingLead.intentDetected &&
      buyingIntentKeywords.some(word => cleanedMessage.includes(word))
    ) {
      pendingLead.intentDetected = true;
      return res.json({ reply: "I can help with that. What’s your name?" });
    }

    if (pendingLead.intentDetected && !pendingLead.name) {
      pendingLead.name = userMessage.split(" ")[0];
      return res.json({
        reply: `Thanks, ${pendingLead.name}! What’s the best phone number to reach you?`,
      });
    }

    if (pendingLead.name && !pendingLead.phone) {
      const phoneMatch = userMessage.match(/\b\d{10}\b/);

      if (!phoneMatch) {
        return res.json({
          reply: "Please enter a valid 10-digit phone number.",
        });
      }

      const leadName = pendingLead.name;
      const leadPhone = phoneMatch[0];

      pendingLead = {
        name: null,
        phone: null,
        intentDetected: false,
      };

      res.json({
        reply:
          "Thanks! Your info has been sent to the team. Someone will reach out shortly.",
      });

      setImmediate(async () => {
        try {
          await resend.emails.send({
            from: "AirAI Leads <onboarding@resend.dev>",
            to: ["bruce@airai.dev"],
            subject: "New AirAI Lead",
            text: `New lead received:\n\nName: ${leadName}\nPhone: ${leadPhone}`,
          });
        } catch (err) {
          console.error("RESEND EMAIL FAILED:", err);
        }
      });

      return;
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
      reply: "Sorry — something went wrong. Please try again.",
    });
  }
});

// --------------------
// SMS Receptionist (Twilio)
// --------------------
app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim();

    if (!from || !body) {
      res.type("text/xml");
      return res.send(`
<Response>
  <Message>Hi! How can I help you today?</Message>
</Response>
      `);
    }

    if (!smsLeads[from]) {
      smsLeads[from] = { name: null, intentDetected: false };
    }

    const lead = smsLeads[from];
    const cleanedMessage = body.toLowerCase().replace(/[^a-z0-9\s]/g, "");

    if (
      !lead.intentDetected &&
      buyingIntentKeywords.some(word => cleanedMessage.includes(word))
    ) {
      lead.intentDetected = true;
      res.type("text/xml");
      return res.send(`
<Response>
  <Message>I can help with that! What’s your name?</Message>
</Response>
      `);
    }

    if (lead.intentDetected && !lead.name) {
      lead.name = body.split(" ")[0];
      res.type("text/xml");
      return res.send(`
<Response>
  <Message>Thanks, ${lead.name}! Someone will reach out shortly.</Message>
</Response>
      `);
    }

    res.type("text/xml");
    res.send(`
<Response>
  <Message>Thanks! We’ve sent your info to the team.</Message>
</Response>
    `);

    delete smsLeads[from];
  } catch (err) {
    console.error("SMS ERROR:", err);
    res.type("text/xml");
    return res.send(`
<Response>
  <Message>Sorry — something went wrong.</Message>
</Response>
    `);
  }
});

// --------------------
// VOICE RECEPTIONIST (TWILIO)
// --------------------

// STEP 1: Answer call + ask reason
app.post("/voice/incoming", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <!-- 🎙️ Updated: <Say> → <Play> for natural, warm voice -->
  <Play>${ttsUrl(req, "Hi, thank you for calling AirAI.")}</Play>
  <Play>${ttsUrl(req, "How can I help you today?")}</Play>
  <Play>${ttsUrl(req, "Please tell me after the tone, then press the pound key.")}</Play>

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
  const reasonRecording = req.body.RecordingUrl;
  const from = req.body.From;

  console.log("CALL REASON RECORDING:", reasonRecording);
  console.log("CALL FROM:", from);

  res.type("text/xml");
  res.send(`
<Response>
  <Play>${ttsUrl(req, "Okay, thank you.")}</Play>
  <Play>${ttsUrl(req, "May I have your name, please?")}</Play>
  <Play>${ttsUrl(req, "You can say it after the tone, then press the pound key.")}</Play>

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

// STEP 3: Close call + email alert
app.post("/voice/name", async (req, res) => {
  const nameRecording = req.body.RecordingUrl;
  const from = req.body.From;

  console.log("CALL NAME RECORDING:", nameRecording);
  console.log("CALL FROM:", from);

  try {
    await resend.emails.send({
      from: "AirAI Calls <onboarding@resend.dev>",
      to: ["bruce@airai.dev"],
      subject: "New AirAI Call",
      text: `New call received.\n\nPhone: ${from}\n\nName Recording:\n${nameRecording}`,
    });
  } catch (err) {
    console.error("VOICE EMAIL FAILED:", err);
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Play>${ttsUrl(req, "Perfect, thank you.")}</Play>
  <Play>${ttsUrl(req, "I'll make sure this message gets passed along.")}</Play>
  <Play>${ttsUrl(req, "Someone will get back to you as soon as possible.")}</Play>
  <Play>${ttsUrl(req, "Have a great day.")}</Play>
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


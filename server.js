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
// 🔊 TTS ENDPOINT (WITH SAFE FALLBACK)
// --------------------
app.get("/tts", async (req, res) => {
  const text = typeof req.query.text === "string" ? req.query.text : "";

  if (!text.trim()) {
    return res.status(400).send("Missing text");
  }

  try {
    const speech = await openai.audio.speech.create({
      model: "tts-1-hd",
      voice: "marin",
      input: text,
      format: "mp3",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(buffer);
  } catch (err) {
    // ✅ SAFE FALLBACK — prevents Twilio application error
    console.error("TTS ERROR (fallback used):", err.message);

    res.setHeader("Content-Type", "audio/mpeg");
    res.status(200).send(Buffer.alloc(0));
  }
});

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
  <Play>https://${req.headers.host}/tts?text=Hi%2C%20thank%20you%20for%20calling%20AirAI.</Play>
  <Play>https://${req.headers.host}/tts?text=How%20can%20I%20help%20you%20today%3F</Play>
  <Play>https://${req.headers.host}/tts?text=Please%20tell%20me%20after%20the%20beep.</Play>

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
  <Play>https://${req.headers.host}/tts?text=Okay%2C%20thank%20you.</Play>
  <Play>https://${req.headers.host}/tts?text=May%20I%20have%20your%20name%2C%20please%3F</Play>
  <Play>https://${req.headers.host}/tts?text=You%20can%20say%20it%20after%20the%20beep.</Play>

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

// STEP 3: Close call
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
  <Play>https://${req.headers.host}/tts?text=Perfect%2C%20thank%20you.</Play>
  <Play>https://${req.headers.host}/tts?text=Someone%20will%20get%20back%20to%20you%20shortly.</Play>
  <Play>https://${req.headers.host}/tts?text=Have%20a%20great%20day.</Play>
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

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import { fileURLToPath } from "url";
import { File } from "node:buffer"; // ✅ REQUIRED for in-memory transcription
import twilio from "twilio"; // ✅ ADDED for owner SMS alerts

// --------------------
// ES Module __dirname fix
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// 🔀 Random MP3 Picker (RELIABILITY SAFE)
// --------------------
function pickRandom(prefix, count) {
  const n = Math.floor(Math.random() * count) + 1;
  return `/audio/${prefix}_${n}.mp3`;
}

// --------------------
// Email (Resend)
// --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// --------------------
// Twilio Client (Owner SMS Alerts)
// --------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const OWNER_SMS_ENABLED = process.env.OWNER_SMS_ENABLED === "true";
const OWNER_SMS_TO = process.env.OWNER_SMS_TO;
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

// --------------------
// 📲 Owner SMS Builder
// --------------------
function buildOwnerSms({ urgency, name, number, transcript }) {
  const clean = (text) =>
    (text || "")
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const safeUrgency = clean(urgency || "LOW").toUpperCase();
  const safeName = clean(name || "no name detected").slice(0, 25);
  const safeNumber = clean(number || "unknown number");
  const safeTranscript = clean(transcript || "no message detected").slice(0, 70);

  let msg =
    `Urgency: ${safeUrgency}\n` +
    `Name: ${safeName}\n` +
    `Number: ${safeNumber}\n` +
    `Msg: ${safeTranscript}`;

  if (msg.length > 150) msg = msg.slice(0, 150);
  return msg;
}

async function maybeSendOwnerSms({ urgency, name, number, transcript }) {
  if (!OWNER_SMS_ENABLED) return;
  if (!OWNER_SMS_TO) return;

  try {
    const body = buildOwnerSms({ urgency, name, number, transcript });

    if (TWILIO_MESSAGING_SERVICE_SID) {
      await twilioClient.messages.create({
        to: OWNER_SMS_TO,
        body,
        messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
      });
    } else {
      await twilioClient.messages.create({
        to: OWNER_SMS_TO,
        body,
        from: process.env.TWILIO_PHONE_NUMBER,
      });
    }
  } catch (err) {
    console.error("OWNER SMS FAILED:", err?.message || err);
  }
}

// --------------------
// App setup
// --------------------
const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget", "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget", "index.html"));
});

// --------------------
// OpenAI
// --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// 🔊 TTS
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
// CHAT INTAKE
// --------------------
app.post("/chat-intake", async (req, res) => {
  try {
    const { name, phone, reason } = req.body;

    const urgentKeywords = [
      "no heat","no ac","flood","leak","burst","smell gas","gas","fire","sparks","smoke","overflow","emergency","urgent","asap","immediately"
    ];

    let urgency = "LOW";
    const reasonLower = (reason || "").toLowerCase();

    if (urgentKeywords.some((word) => reasonLower.includes(word))) {
      urgency = "HIGH";
    } else if (reasonLower.length > 20) {
      urgency = "MEDIUM";
    }

    await resend.emails.send({
      from: "AIR AI Leads <leads@mail.airai.dev>",
      replyTo: "leads@airai.dev",
      to: ["bruce@airai.dev"],
      subject: `New AIR AI Chat Lead — Urgency: ${urgency}`,
      text: `
Name: ${name || "Not provided"}
Phone: ${phone || "Not provided"}

Urgency:
${urgency}

Reason:
${reason || "Not provided"}
`,
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("CHAT INTAKE ERROR:", err);
    res.status(500).json({ status: "error" });
  }
});

// --------------------
// SMS RECEPTIONIST
// --------------------
const smsLeads = {};
const buyingIntentKeywords = [
  "quote","price","pricing","estimate","cost","call","contact","book","appointment","service","install"
];

app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim();

    if (!from || !body) {
      res.type("text/xml");
      return res.send(`<Response><Message>Hi! How can I help you today?</Message></Response>`);
    }

    if (!smsLeads[from]) {
      smsLeads[from] = { name: null, intentDetected: false };
    }

    const lead = smsLeads[from];
    const cleanedMessage = body.toLowerCase().replace(/[^a-z0-9\s]/g, "");

    if (!lead.intentDetected && buyingIntentKeywords.some((word) => cleanedMessage.includes(word))) {
      lead.intentDetected = true;
      res.type("text/xml");
      return res.send(`<Response><Message>I can help with that! What’s your name?</Message></Response>`);
    }

    if (lead.intentDetected && !lead.name) {
      lead.name = body.split(" ")[0];
      res.type("text/xml");
      return res.send(`<Response><Message>Thanks, ${lead.name}! Someone will reach out shortly.</Message></Response>`);
    }

    res.type("text/xml");
    res.send(`<Response><Message>Thanks! We’ve sent your info to the team.</Message></Response>`);

    delete smsLeads[from];
  } catch (err) {
    console.error("SMS ERROR:", err);
  }
});

// --------------------
// VOICE RECEPTIONIST
// --------------------
const callRecordings = {};
const modelBCalls = new Map();

const MODEL_B_PARTIAL_DELAY_MS = Number(process.env.MODEL_B_PARTIAL_DELAY_MS || 45000);
const MODEL_B_TTL_MS = Number(process.env.MODEL_B_TTL_MS || 15 * 60 * 1000);

function modelBGet(callSid) {
  if (!callSid) return null;
  return modelBCalls.get(callSid) || null;
}

function modelBUpsert(callSid, patch) {
  if (!callSid) return null;
  const existing = modelBCalls.get(callSid) || {};
  const next = { ...existing, ...patch, lastTouch: Date.now() };
  modelBCalls.set(callSid, next);
  return next;
}

function modelBClearTimer(callSid) {
  const st = modelBGet(callSid);
  if (st?.partialTimer) {
    clearTimeout(st.partialTimer);
    st.partialTimer = null;
    modelBUpsert(callSid, st);
  }
}

function modelBCleanup(callSid) {
  modelBClearTimer(callSid);
  modelBCalls.delete(callSid);
}

setInterval(() => {
  const now = Date.now();
  for (const [callSid, st] of modelBCalls.entries()) {
    if (!st?.lastTouch) continue;
    if (now - st.lastTouch > MODEL_B_TTL_MS) {
      modelBCleanup(callSid);
    }
  }
}, 60000);

// --------------------
// STEP 1 — GREETING
// --------------------
app.post("/voice/incoming", (req, res) => {
  const { CallSid, From, To } = req.body;

  if (CallSid) {
    modelBUpsert(CallSid, {
      from: From,
      to: To,
      startedAt: Date.now(),
      partialSent: false,
      fullSent: false,
    });
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}${pickRandom("greeting", 3)}</Play>
  <Play>https://${req.headers.host}${pickRandom("help", 3)}</Play>
  <Record
    action="/voice/reason"
    method="POST"
    maxLength="10"
    playBeep="false"
    recordingStatusCallback="https://${req.headers.host}/twilio/recording-status?stage=reason"
    recordingStatusCallbackMethod="POST"
    recordingStatusCallbackEvent="completed"
  />
</Response>
  `);
});

// --------------------
// STEP 2 — NAME
// --------------------
app.post("/voice/reason", (req, res) => {
  const { CallSid, RecordingUrl } = req.body;

  if (CallSid && RecordingUrl) {
    callRecordings[CallSid] = { reason: RecordingUrl };
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}${pickRandom("name", 3)}</Play>
  <Record action="/voice/name" method="POST" maxLength="5" playBeep="false" />
</Response>
  `);
});

// --------------------
// STEP 3 — GOODBYE
// --------------------
app.post("/voice/name", async (req, res) => {

  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/goodbye.mp3</Play>
  <Hangup/>
</Response>
  `);
});

// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
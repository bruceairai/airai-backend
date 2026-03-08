import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import { fileURLToPath } from "url";
import { File } from "node:buffer";
import twilio from "twilio";

// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
function pickRandom(prefix, count) {
  const n = Math.floor(Math.random() * count) + 1;
  return `/audio/${prefix}_${n}.mp3`;
}

// --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// --------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const OWNER_SMS_ENABLED = process.env.OWNER_SMS_ENABLED === "true";
const OWNER_SMS_TO = process.env.OWNER_SMS_TO;
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

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
const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

// --------------------
app.get("/widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget", "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget", "index.html"));
});

// --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
// VOICE SYSTEM
// --------------------

const callRecordings = {};
const modelBCalls = new Map();

const MODEL_B_PARTIAL_DELAY_MS = Number(
  process.env.MODEL_B_PARTIAL_DELAY_MS || 45000
);

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
  const { CallSid, RecordingUrl, From, To } = req.body;

  if (CallSid && RecordingUrl) {
    callRecordings[CallSid] = { reason: RecordingUrl };

    modelBUpsert(CallSid, {
      from: From || modelBGet(CallSid)?.from,
      to: To || modelBGet(CallSid)?.to,
      reasonRecordingUrl: RecordingUrl,
    });
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
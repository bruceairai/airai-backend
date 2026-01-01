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
  res.sendFile(path.join(process.cwd(), "public", "public", "widget", "index.html"));
});

// --------------------
// OpenAI
// --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// 🔊 NEW: Text-to-Speech Endpoint
// --------------------
app.get("/tts", async (req, res) => {
  try {
    const text = req.query.text;

    if (!text) {
      return res.status(400).send("Missing text");
    }

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
    });

    res.set({
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error("TTS ERROR:", err);
    res.status(500).send("TTS failed");
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
// (UNCHANGED — omitted here for brevity, yours stays exactly the same)

// --------------------
// SMS Receptionist (Twilio)
// --------------------
// (UNCHANGED)

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
  const reasonRecording = req.body.RecordingUrl;
  const from = req.body.From;

  console.log("CALL REASON RECORDING:", reasonRecording);
  console.log("CALL FROM:", from);

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
  <Play>https://${req.headers.host}/tts?text=Perfect%2C%20thank%20you.</Play>
  <Play>https://${req.headers.host}/tts?text=I%E2%80%99ll%20make%20sure%20this%20message%20gets%20passed%20along.</Play>
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

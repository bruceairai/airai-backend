import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import { fileURLToPath } from "url";
import { File } from "node:buffer";
import twilio from "twilio"; // ✅ ADDED

// --------------------
// ES Module __dirname fix
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// 🔀 Random MP3 Picker
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
// Twilio (Owner SMS Alerts)
// --------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const OWNER_SMS_ENABLED = process.env.OWNER_SMS_ENABLED === "true";
const OWNER_SMS_TO = process.env.OWNER_SMS_TO;

// --------------------
// App setup
// --------------------
const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --------------------
// OpenAI
// --------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// 📲 Owner SMS Builder
// --------------------
function buildOwnerSms({ urgency, name, number, transcript }) {
  const clean = (text) =>
    (text || "")
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  let safeUrgency = clean(urgency || "LOW");
  let safeName = clean(name || "no name detected").slice(0, 25);
  let safeNumber = clean(number || "unknown number");
  let safeTranscript = clean(transcript || "no message detected").slice(0, 70);

  let message =
    `Urgency: ${safeUrgency}\n` +
    `Name: ${safeName}\n` +
    `Number: ${safeNumber}\n` +
    `Msg: ${safeTranscript}`;

  if (message.length > 150) {
    message = message.slice(0, 150);
  }

  return message;
}

// --------------------
// VOICE RECEPTIONIST
// --------------------
const callRecordings = {};
const modelBCalls = new Map();

app.post("/voice/name", async (req, res) => {
  const { CallSid, From, RecordingUrl } = req.body;
  const reasonUrl = callRecordings[CallSid]?.reason;
  const nameUrl = RecordingUrl;

  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/goodbye.mp3</Play>
  <Hangup/>
</Response>
  `);

  (async () => {
    let reasonText = "";
    let nameText = "";
    let summary = "";
    let urgency = "LOW";
    let isEmptyMessage = true;

    const authHeader =
      "Basic " +
      Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString("base64");

    const downloadBuffer = async (url) => {
      const r = await fetch(`${url}.mp3`, {
        headers: { Authorization: authHeader },
      });
      return Buffer.from(await r.arrayBuffer());
    };

    try {
      if (reasonUrl) {
        const buf = await downloadBuffer(reasonUrl);
        const audioFile = new File([buf], "reason.mp3", { type: "audio/mpeg" });

        const t = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "gpt-4o-transcribe",
        });

        reasonText = (t.text || "").trim();
      }

      if (nameUrl) {
        const buf = await downloadBuffer(nameUrl);
        const audioFile = new File([buf], "name.mp3", { type: "audio/mpeg" });

        const t = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "gpt-4o-transcribe",
        });

        const rawName = (t.text || "").trim();
        const cleanedName = rawName.replace(/[^a-zA-Z\s]/g, "").trim();
        nameText = cleanedName.length < 2 ? "" : cleanedName;
      }

      const wordCount = reasonText.split(/\s+/).filter(Boolean).length;
      isEmptyMessage = wordCount < 3;

      if (!isEmptyMessage) {
        const u = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Classify the urgency of this call as HIGH, MEDIUM, or LOW. Respond with one word only.",
            },
            { role: "user", content: reasonText },
          ],
        });
        urgency = (u.choices[0].message.content || "LOW")
          .toUpperCase()
          .trim();
      }
    } catch (err) {
      console.error("POST-CALL AI FAILED:", err);
    }

    const subject = isEmptyMessage
      ? "Missed Call – No Message Left"
      : `New AIR AI Call — Urgency: ${urgency}`;

    const body = isEmptyMessage
      ? `A call was received but no message was left.\n\nPhone: ${From}`
      : `
Phone: ${From}

Caller Name (AI):
${nameText || "Not detected"}

Urgency:
${urgency}

Transcript:
${reasonText || "Not available"}
`;

    await resend.emails.send({
      from: "AIR AI Calls <calls@mail.airai.dev>",
      replyTo: "calls@airai.dev",
      to: ["bruce@airai.dev"],
      subject,
      text: body,
    });

    // --------------------
    // 📲 OWNER SMS ALERT
    // --------------------
    if (OWNER_SMS_ENABLED && OWNER_SMS_TO) {
      try {
        const smsMessage = buildOwnerSms({
          urgency,
          name: nameText,
          number: From,
          transcript: reasonText,
        });

        await twilioClient.messages.create({
          body: smsMessage,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: OWNER_SMS_TO,
        });
      } catch (err) {
        console.error("OWNER SMS FAILED:", err.message);
      }
    }

    delete callRecordings[CallSid];
  })();
});

// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
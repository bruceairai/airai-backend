import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import fs from "fs";
import { fileURLToPath } from "url";

// --------------------
// ES Module __dirname fix
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// Email (Resend)
// --------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// --------------------
// App setup
// --------------------
const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve static files (goodbye.mp3, widget, etc)
app.use(express.static(path.join(__dirname, "public")));

// --------------------
// Static routes
// --------------------
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
// 🔊 Text-to-Speech
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
// CHAT INTAKE ENDPOINT
// --------------------
app.post("/chat-intake", async (req, res) => {
  try {
    const { name, phone, reason } = req.body;

    // Simple urgency detection
    const urgentKeywords = [
      "no heat",
      "no ac",
      "flood",
      "leak",
      "burst",
      "smell gas",
      "gas",
      "fire",
      "sparks",
      "smoke",
      "overflow",
      "emergency",
      "urgent",
      "asap",
      "immediately"
    ];

    let urgency = "LOW";
    const reasonLower = (reason || "").toLowerCase();

    if (urgentKeywords.some(word => reasonLower.includes(word))) {
      urgency = "HIGH";
    } else if (reasonLower.length > 20) {
      urgency = "MEDIUM";
    }

    await resend.emails.send({
      from: "AIR AI Leads <onboarding@resend.dev>",
      to: ["bruce@airai.dev"],
      subject: `New AIR AI Chat Lead — Urgency: ${urgency}`,
      text: `
Name: ${name || "Not provided"}
Phone: ${phone || "Not provided"}

Urgency:
${urgency}

Reason:
${reason || "Not provided"}
`
    });

    res.json({ status: "ok" });
  } catch (err) {
    console.error("CHAT INTAKE ERROR:", err);
    res.status(500).json({ status: "error" });
  }
});

// --------------------
// SMS RECEPTIONIST (UNCHANGED)
// --------------------
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
  }
});

// --------------------
// VOICE RECEPTIONIST
// --------------------
const callRecordings = {};

// STEP 1 — GREETING (AIR AI restored)
app.post("/voice/incoming", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Hi%2C%20thank%20you%20for%20calling%20AIR%20AI!</Play>
  <Play>https://${req.headers.host}/tts?text=How%20can%20I%20help%20you%20today%3F</Play>
  <Record action="/voice/reason" method="POST" maxLength="10" playBeep="true" />
</Response>
  `);
});

// STEP 2 — SILENCE-AWARE FLOW ✅
app.post("/voice/reason", (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body;

  if (CallSid && RecordingUrl) {
    callRecordings[CallSid] = { reason: RecordingUrl };
  }

  const isSilence = !RecordingDuration || RecordingDuration === "0";

  res.type("text/xml");

  if (isSilence) {
    // No speech → skip "Got it"
    res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=May%20I%20have%20your%20name%2C%20please%3F</Play>
  <Record action="/voice/name" method="POST" maxLength="5" playBeep="true" />
</Response>
    `);
  } else {
    // Speech detected → normal flow
    res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Got%20it.</Play>
  <Play>https://${req.headers.host}/tts?text=May%20I%20have%20your%20name%2C%20please%3F</Play>
  <Record action="/voice/name" method="POST" maxLength="5" playBeep="true" />
</Response>
    `);
  }
});

// STEP 3 — GOODBYE (reusable Nova MP3)
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

    const download = async (url, filename) => {
      const r = await fetch(`${url}.mp3`, {
        headers: { Authorization: authHeader },
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const filePath = `/tmp/${filename}`;
      fs.writeFileSync(filePath, buf);
      return filePath;
    };

    try {
      if (reasonUrl) {
        const p = await download(reasonUrl, `${CallSid}-reason.mp3`);
        const t = await openai.audio.transcriptions.create({
          file: fs.createReadStream(p),
          model: "gpt-4o-transcribe",
        });
        reasonText = (t.text || "").trim();
        fs.unlinkSync(p);
      }

      if (nameUrl) {
        const p = await download(nameUrl, `${CallSid}-name.mp3`);
        const t = await openai.audio.transcriptions.create({
          file: fs.createReadStream(p),
          model: "gpt-4o-transcribe",
        });
        nameText = (t.text || "").trim();
        fs.unlinkSync(p);
      }

      const wordCount = reasonText.split(/\s+/).filter(Boolean).length;
      isEmptyMessage = wordCount < 3;

      if (!isEmptyMessage) {
        const s = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Summarize this phone call in 1–2 sentences for a business owner.",
            },
            { role: "user", content: reasonText },
          ],
        });
        summary = s.choices[0].message.content;

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
        urgency = u.choices[0].message.content.toUpperCase();
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

Summary:
${summary || "Not available"}

Transcript:
${reasonText || "Not available"}
`;

    await resend.emails.send({
      from: "AIR AI Calls <onboarding@resend.dev>",
      to: ["bruce@airai.dev"],
      subject,
      text: body,
    });

    delete callRecordings[CallSid];
  })();
});

// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import { fileURLToPath } from "url";
import { File } from "node:buffer"; // ✅ REQUIRED for in-memory transcription

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
// App setup
// --------------------
const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve static files (goodbye.mp3, widget, audio, etc)
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
// 🔊 Text-to-Speech (UNCHANGED)
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
      "immediately",
    ];

    let urgency = "LOW";
    const reasonLower = (reason || "").toLowerCase();

    if (urgentKeywords.some((word) => reasonLower.includes(word))) {
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
`,
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
      buyingIntentKeywords.some((word) => cleanedMessage.includes(word))
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

// ====================
// ✅ MODEL B (PARTIAL CALL SAFETY NET)
// - No OpenAI during the live call
// - Uses Twilio recordingStatusCallback on the FIRST recording step
// - Sends a clean email even if caller never reaches /voice/name
// - If AI fails OR transcript is empty => "Missed Call – No Message Left"
// ====================
const modelBCalls = new Map(); // CallSid -> state

const MODEL_B_PARTIAL_DELAY_MS = Number(
  process.env.MODEL_B_PARTIAL_DELAY_MS || 45000
); // default 45s
const MODEL_B_TTL_MS = Number(process.env.MODEL_B_TTL_MS || 15 * 60 * 1000); // default 15 min

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
}, 60 * 1000);

// Twilio recording status callback for FIRST step only (reason recording)
app.post("/twilio/recording-status", async (req, res) => {
  try {
    const stage = (req.query.stage || "").toLowerCase(); // expect "reason"
    const callSid = req.body.CallSid;
    if (!callSid) return res.sendStatus(200);

    const from = req.body.From;
    const to = req.body.To;

    const recordingUrl = req.body.RecordingUrl; // base URL; often no extension
    const recordingSid = req.body.RecordingSid;

    const current = modelBUpsert(callSid, {
      from: from || modelBGet(callSid)?.from,
      to: to || modelBGet(callSid)?.to,
      startedAt: modelBGet(callSid)?.startedAt || Date.now(),
      ...(stage === "reason"
        ? {
            reasonRecordingUrl: recordingUrl,
            reasonRecordingSid: recordingSid, // stored for internal use only (not emailed)
          }
        : {}),
    });

    if (stage !== "reason") return res.sendStatus(200);

    // If full email already sent, do nothing
    if (current.fullSent) return res.sendStatus(200);

    // If already scheduled/sent partial, do nothing
    if (current.partialSent || current.partialTimer) return res.sendStatus(200);

    // Schedule partial email (post-call work only)
    const timer = setTimeout(async () => {
      const latest = modelBGet(callSid);
      if (!latest) return;

      // If full email got sent in the meantime, skip partial
      if (latest.fullSent) {
        modelBCleanup(callSid);
        return;
      }

      // Mark partial as sent first (prevents duplicates)
      modelBUpsert(callSid, { partialSent: true, partialTimer: null });

      const fromPhone = latest.from || "Not available";
      const reasonUrl = latest.reasonRecordingUrl;

      // Default behavior if anything fails: clean "no message" email (V1 simple)
      let reasonText = "";
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

        const wordCount = reasonText.split(/\s+/).filter(Boolean).length;
        isEmptyMessage = wordCount < 3;

        if (!isEmptyMessage) {
          const s = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "Summarize this phone call in 1–2 sentences for a business owner." },
              { role: "user", content: reasonText },
            ],
          });
          summary = (s.choices[0].message.content || "").trim();

          const u = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "Classify the urgency of this call as HIGH, MEDIUM, or LOW. Respond with one word only." },
              { role: "user", content: reasonText },
            ],
          });
          urgency = (u.choices[0].message.content || "LOW").toUpperCase().trim();
        }
      } catch (e) {
        console.error("MODEL B POST-CALL AI FAILED:", e);
        // Keep isEmptyMessage = true (simple V1 fallback)
        isEmptyMessage = true;
      }

      const subject = isEmptyMessage
        ? "Missed Call – No Message Left"
        : `New AIR AI Call — Urgency: ${urgency}`;

      const body = isEmptyMessage
        ? `A call was received but no message was left.\n\nPhone: ${fromPhone}`
        : `
Phone: ${fromPhone}

Caller Name (AI):
Not detected

Urgency:
${urgency}

Summary:
${summary || "Not available"}

Transcript:
${reasonText || "Not available"}
`;

      try {
        await resend.emails.send({
          from: "AIR AI Calls <onboarding@resend.dev>",
          to: ["bruce@airai.dev"],
          subject,
          text: body,
        });
      } catch (e) {
        console.error("MODEL B PARTIAL EMAIL FAILED:", e);
      }
    }, MODEL_B_PARTIAL_DELAY_MS);

    modelBUpsert(callSid, { partialTimer: timer });

    // Always 200 to avoid Twilio retry storms
    return res.sendStatus(200);
  } catch (err) {
    console.error("MODEL B /twilio/recording-status ERROR:", err);
    return res.sendStatus(200);
  }
});

// STEP 1 — GREETING
app.post("/voice/incoming", (req, res) => {
  const { CallSid, From, To } = req.body;

  // Initialize Model B state (safe no-op if repeated)
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
    playBeep="true"
    recordingStatusCallback="https://${req.headers.host}/twilio/recording-status?stage=reason"
    recordingStatusCallbackMethod="POST"
    recordingStatusCallbackEvent="completed"
  />
</Response>
  `);
});

// STEP 2 — NAME PROMPT
app.post("/voice/reason", (req, res) => {
  const { CallSid, RecordingUrl, From, To } = req.body;

  if (CallSid && RecordingUrl) {
    callRecordings[CallSid] = { reason: RecordingUrl };

    // Also store for Model B reference (harmless if callback already did)
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
  <Record action="/voice/name" method="POST" maxLength="5" playBeep="true" />
</Response>
  `);
});

// STEP 3 — GOODBYE
app.post("/voice/name", async (req, res) => {
  const { CallSid, From, RecordingUrl } = req.body;
  const reasonUrl = callRecordings[CallSid]?.reason;
  const nameUrl = RecordingUrl;

  // ✅ Model B: cancel any scheduled partial email and mark full sent
  if (CallSid) {
    modelBClearTimer(CallSid);
    modelBUpsert(CallSid, { fullSent: true });
    // cleanup later (keeps things safe if anything arrives late)
    setTimeout(() => modelBCleanup(CallSid), 2 * 60 * 1000);
  }

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

    // --------- NO-DISK BUFFER DOWNLOAD ---------
    const downloadBuffer = async (url) => {
      const r = await fetch(`${url}.mp3`, {
        headers: { Authorization: authHeader },
      });
      return Buffer.from(await r.arrayBuffer());
    };
    // ------------------------------------------

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

        if (cleanedName.length < 2) {
          nameText = "";
        } else {
          nameText = cleanedName;
        }
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

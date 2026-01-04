import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import { Resend } from "resend";
import fs from "fs";

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
// CHAT WIDGET (UNCHANGED)
// --------------------
let pendingLead = {
  name: null,
  phone: null,
  intentDetected: false,
};

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

      await resend.emails.send({
        from: "AirAI Leads <onboarding@resend.dev>",
        to: ["bruce@airai.dev"],
        subject: "New AirAI Chat Lead",
        text: `Name: ${leadName}\nPhone: ${leadPhone}`,
      });

      return;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: userMessage }],
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.json({ reply: "Sorry — something went wrong." });
  }
});

// --------------------
// SMS RECEPTIONIST (UNCHANGED)
// --------------------
const smsLeads = {};

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

// STEP 1
app.post("/voice/incoming", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Hi%2C%20thank%20you%20for%20calling%20AirAI.</Play>
  <Play>https://${req.headers.host}/tts?text=How%20can%20I%20help%20you%20today%3F</Play>
  <Record action="/voice/reason" method="POST" maxLength="10" playBeep="true" />
</Response>
  `);
});

// STEP 2
app.post("/voice/reason", (req, res) => {
  const { CallSid, RecordingUrl } = req.body;
  if (CallSid && RecordingUrl) {
    callRecordings[CallSid] = { reason: RecordingUrl };
  }

  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Got%20it.</Play>
  <Play>https://${req.headers.host}/tts?text=May%20I%20have%20your%20name%2C%20please%3F</Play>
  <Record action="/voice/name" method="POST" maxLength="5" playBeep="true" />
</Response>
  `);
});

// STEP 3
app.post("/voice/name", async (req, res) => {
  const { CallSid, From, RecordingUrl } = req.body;
  const reasonUrl = callRecordings[CallSid]?.reason;
  const nameUrl = RecordingUrl;

  res.type("text/xml");
  res.send(`
<Response>
  <Play>https://${req.headers.host}/tts?text=Thank%20you%20for%20calling.</Play>
  <Play>https://${req.headers.host}/tts?text=Someone%20will%20get%20back%20to%20you%20shortly.</Play>
  <Hangup />
</Response>
  `);

  (async () => {
    let reasonText = "";
    let nameText = "";
    let summary = "";
    let urgency = "UNKNOWN";

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
        reasonText = t.text || "";
        fs.unlinkSync(p);
      }

      if (nameUrl) {
        const p = await download(nameUrl, `${CallSid}-name.mp3`);
        const t = await openai.audio.transcriptions.create({
          file: fs.createReadStream(p),
          model: "gpt-4o-transcribe",
        });
        nameText = t.text || "";
        fs.unlinkSync(p);
      }

      if (reasonText) {
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

    await resend.emails.send({
      from: "AirAI Calls <onboarding@resend.dev>",
      to: ["bruce@airai.dev"],
      subject: `New AirAI Call — Urgency: ${urgency}`,
      text: `
Phone: ${From}

Caller Name (AI):
${nameText || "Not detected"}

Urgency:
${urgency}

Summary:
${summary || "Not available"}

Transcript:
${reasonText || "Not available"}
      `,
    });

    delete callRecordings[CallSid];
  })();
});

// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

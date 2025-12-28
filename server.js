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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    // Guard: contact info without intent
    if (!pendingLead.intentDetected && /\b\d{10}\b/.test(userMessage)) {
      return res.json({
        reply:
          "Hi! I can help with pricing, estimates, or services. What can I assist you with?",
      });
    }

    const cleanedMessage = userMessage
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "");

    // Detect buying intent
    if (
      !pendingLead.intentDetected &&
      buyingIntentKeywords.some(word =>
        cleanedMessage.includes(word)
      )
    ) {
      pendingLead.intentDetected = true;
      return res.json({
        reply: "I can help with that. What’s your name?",
      });
    }

    // Capture name
    if (pendingLead.intentDetected && !pendingLead.name) {
      pendingLead.name = userMessage.split(" ")[0];
      return res.json({
        reply: `Thanks, ${pendingLead.name}! What’s the best phone number to reach you?`,
      });
    }

    // Capture phone (NON-BLOCKING)
    if (pendingLead.name && !pendingLead.phone) {
      const phoneMatch = userMessage.match(/\b\d{10}\b/);

      if (!phoneMatch) {
        return res.json({
          reply: "Please enter a valid 10-digit phone number.",
        });
      }

      const leadName = pendingLead.name;
      const leadPhone = phoneMatch[0];

      // Reset state immediately
      pendingLead = {
        name: null,
        phone: null,
        intentDetected: false,
      };

      // Respond immediately
      res.json({
        reply:
          "Thanks! Your info has been sent to the team. Someone will reach out shortly.",
      });

      // Send email in background via Resend
      setImmediate(async () => {
        try {
          await resend.emails.send({
            from: "AirAI Leads <onboarding@resend.dev>",
            to: ["bruce@airai.dev"],
            subject: "New AirAI Lead",
            text: `New lead received:\n\nName: ${leadName}\nPhone: ${leadPhone}`,
          });
          console.log("EMAIL SENT SUCCESS (Resend)");
        } catch (err) {
          console.error("RESEND EMAIL FAILED:", err);
        }
      });

      return;
    }

    // Normal AI response
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are AirAI, a professional AI assistant for service businesses.
Answer questions clearly and concisely.`,
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
    const from = req.body.From;       // Customer phone number
    const body = (req.body.Body || "").trim();

    if (!from || !body) {
      res.set("Content-Type", "text/xml");
      return res.send(`
<Response>
  <Message>Hi! How can I help you today?</Message>
</Response>
      `);
    }

    // Initialize state for this phone number
    if (!smsLeads[from]) {
      smsLeads[from] = {
        name: null,
        intentDetected: false,
      };
    }

    const lead = smsLeads[from];
    const cleanedMessage = body.toLowerCase().replace(/[^a-z0-9\s]/g, "");

    // Detect buying intent
    if (
      !lead.intentDetected &&
      buyingIntentKeywords.some(word => cleanedMessage.includes(word))
    ) {
      lead.intentDetected = true;

      res.set("Content-Type", "text/xml");
      return res.send(`
<Response>
  <Message>I can help with that! What’s your name?</Message>
</Response>
      `);
    }

    // Capture name
    if (lead.intentDetected && !lead.name) {
      lead.name = body.split(" ")[0];

      res.set("Content-Type", "text/xml");
      return res.send(`
<Response>
  <Message>Thanks, ${lead.name}! Someone will reach out shortly.</Message>
</Response>
      `);
    }

    // Lead complete → send alert
    if (lead.intentDetected && lead.name) {
      const leadName = lead.name;
      const leadPhone = from;

      // Reset state immediately
      delete smsLeads[from];

      // Respond to user
      res.set("Content-Type", "text/xml");
      res.send(`
<Response>
  <Message>Thanks! We’ve sent your info to the team.</Message>
</Response>
      `);

      // Send email in background
      setImmediate(async () => {
        try {
          await resend.emails.send({
            from: "AirAI Leads <onboarding@resend.dev>",
            to: ["bruce@airai.dev"],
            subject: "New SMS Lead",
            text: `New SMS lead received:\n\nName: ${leadName}\nPhone: ${leadPhone}`,
          });
          console.log("SMS LEAD EMAIL SENT");
        } catch (err) {
          console.error("SMS EMAIL FAILED:", err);
        }
      });

      return;
    }

    // Fallback AI response
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are AirAI, a professional SMS receptionist for a service business. Keep responses short.",
        },
        { role: "user", content: body },
      ],
    });

    res.set("Content-Type", "text/xml");
    return res.send(`
<Response>
  <Message>${completion.choices[0].message.content}</Message>
</Response>
    `);
  } catch (err) {
    console.error("SMS ERROR:", err);
    res.set("Content-Type", "text/xml");
    return res.send(`
<Response>
  <Message>Sorry — something went wrong. Please try again.</Message>
</Response>
    `);
  }
});


// --------------------
// Server start (Railway)
// --------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

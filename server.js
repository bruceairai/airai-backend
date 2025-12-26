import dotenv from "dotenv";
dotenv.config({ path: "./.env" });






import express from "express";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import nodemailer from "nodemailer";






const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: false, // true only for port 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(process.cwd(), "public")));

app.get("/debug-files", (req, res) => {
  res.json({
    cwd: process.cwd(),
  });
});


app.get("/widget", (req, res) => {
  res.sendFile(
    path.join(process.cwd(), "public", "widget", "index.html")
  );
});


app.get("/", (req, res) => {
  res.sendFile(
    path.join(process.cwd(), "public", "widget", "index.html")
  );
});



const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});



let pendingLead = {
  name: null,
  phone: null,
  intentDetected: false
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
  "install"
];


// Web / widget chat
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message?.trim();

    if (!userMessage) {
      return res.json({ reply: "How can I help you today?" });
    }

    const lowerMessage = userMessage.toLowerCase();
const cleanedMessage = lowerMessage.replace(/[^a-z0-9\s]/g, "");


    // Detect buying intent
    if (
      !pendingLead.intentDetected &&
      buyingIntentKeywords.some(word => cleanedMessage.includes(word))

    ) {
      pendingLead.intentDetected = true;
      return res.json({
        reply: "I can help with that. What’s your name?"
      });
    }

    // Capture name
    if (pendingLead.intentDetected && !pendingLead.name) {
     pendingLead.name = userMessage.split(" ")[0];

      return res.json({
        reply: `Thanks, ${pendingLead.name}! What’s the best phone number to reach you?`
      });
    }

// Capture phone
if (pendingLead.name && !pendingLead.phone) {
  const phoneMatch = userMessage.match(/\b\d{10}\b/);

  if (!phoneMatch) {
    return res.json({
      reply: "Please enter a valid 10-digit phone number."
    });
  }

  pendingLead.phone = phoneMatch[0];

  console.log("LEAD TRIGGERED");
  console.log("NAME:", pendingLead.name);
  console.log("PHONE:", pendingLead.phone);

  try {
    console.log("ATTEMPTING TO SEND EMAIL");

    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: process.env.LEADS_TO_EMAIL || process.env.EMAIL_USER,
      subject: "New Lead from AirAI Chatbot",
      text: `New lead received:\n\nName: ${pendingLead.name}\nPhone: ${pendingLead.phone}`
    });

    console.log("EMAIL SENT SUCCESS:", info.response);
  } catch (err) {
    console.error("EMAIL FAILED:", err);
  }

  // Reset safely AFTER everything
  pendingLead = {
    name: null,
    phone: null,
    intentDetected: false
  };

  return res.json({
    reply: "Thanks! Your info has been sent to the team. Someone will reach out shortly."
  });
}




    // Normal AI response (no lead flow)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are AirAI, a professional AI assistant for service businesses.
Answer questions clearly and concisely.
DO NOT ask for name, phone number, or contact information unless explicitly instructed by the system.`


        },
        { role: "user", content: userMessage }
      ]
    });

    return res.json({
      reply: completion.choices[0].message.content
    });

  } catch (err) {
    console.error("Chat error:", err);
    res.json({
      reply: "Sorry — something went wrong. Please try again."
    });
  }
});


// SMS (Twilio webhook)
app.post("/sms", async (req, res) => {
  try {
    const incomingMessage = req.body.Body || "";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:`You are AirAI, a professional AI assistant for service businesses.
Answer questions clearly and concisely.
DO NOT ask for name, phone number, or contact information unless explicitly instructed by the system.`


        },
        { role: "user", content: incomingMessage }
      ]
    });

    const reply = completion.choices[0].message.content;

    res.set("Content-Type", "text/xml");
    res.send(`
<Response>
  <Message>${reply}</Message>
</Response>
    `);
  } catch (err) {
    console.error("SMS ERROR:", err);
    res.status(500).send("SMS error");
  }
});

// Railway-required port handling
const PORT = process.env.PORT || 3000;

  console.log("✅ Email sent:", info.messageId);
}





app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

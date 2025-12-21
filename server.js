import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.static("public"));


// IMPORTANT: support BOTH JSON and form-encoded (Twilio)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Health check (Railway uses this)
app.get("/", (req, res) => {
  res.status(200).send("AIrAI backend is running");
});

// Web / widget chat
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.json({ reply: "How can I help you today?" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are AIrAI, a professional AI assistant for service businesses. Be concise, friendly, and helpful. Ask for name and phone number when appropriate."
        },
        { role: "user", content: userMessage }
      ]
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ error: "AI error" });
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
          content:
            "You are AIrAI, an AI SMS assistant for service businesses. Be brief, friendly, and conversational. Ask for name and service needs."
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

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

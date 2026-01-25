(function () {
  // ✅ Railway backend base URL
  const BACKEND_BASE_URL = "https://airai-backend-production.up.railway.app";

  // Intake state
  let step = "START";

  const lead = {
    name: "",
    reason: "",
    urgency: ""
  };

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else e.setAttribute(k, v);
    });
    children.forEach((c) => e.appendChild(c));
    return e;
  }

  function addMessage(type, text) {
    const row = el("div", { class: `airai-msg ${type}` });
    const bubble = el("div", { class: "airai-bubble" });
    bubble.textContent = text;
    row.appendChild(bubble);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  function bot(text) {
    addMessage("bot", text);
  }

  function user(text) {
    addMessage("user", text);
  }

  async function submitLead() {
    try {
      await fetch(`${BACKEND_BASE_URL}/chat-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lead)
      });
    } catch (err) {
      console.error("Lead submit failed:", err);
    }
  }

  function handleInput(text) {
    user(text);

    switch (step) {
      case "START":
        step = "ASK_NAME";
        bot("May I have your name?");
        break;

      case "ASK_NAME":
        lead.name = text;
        step = "ASK_REASON";
        bot("Thanks. What can we help you with today?");
        break;

      case "ASK_REASON":
        lead.reason = text;
        step = "ASK_URGENCY";
        bot("Is this urgent? (yes or no)");
        break;

      case "ASK_URGENCY":
        lead.urgency = text.toLowerCase().startsWith("y") ? "urgent" : "not urgent";
        step = "CONFIRM";
        bot(
          `Got it. Here’s what I have:\n\nName: ${lead.name}\nReason: ${lead.reason}\nUrgency: ${lead.urgency}\n\nIs this correct? (yes or no)`
        );
        break;

      case "CONFIRM":
        if (text.toLowerCase().startsWith("y")) {
          step = "DONE";
          bot("Thank you. We’ve received your information and will get back to you shortly.");
          submitLead();
        } else {
          step = "ASK_NAME";
          bot("No problem. Let’s try again. What’s your name?");
        }
        break;

      case "DONE":
        bot("Someone from our team will follow up with you shortly.");
        break;
    }
  }

  // UI
  const launcher = el("button", { id: "airai-launcher", "aria-label": "Open AIR AI chat" }, [
    el("img", { src: "airai-logo.png", alt: "AIR AI" })
  ]);

  const panel = el("div", { id: "airai-panel" });
  const header = el("div", { id: "airai-header" });
  const left = el("div", { class: "left" }, [
    el("img", { src: "airai-logo.png", alt: "AIR AI" }),
    el("div", { html: "AIR AI Receptionist" })
  ]);
  const closeBtn = el("button", { id: "airai-close" });
  closeBtn.textContent = "Close";

  header.appendChild(left);
  header.appendChild(closeBtn);

  const messages = el("div", { id: "airai-messages" });
  const inputbar = el("div", { id: "airai-inputbar" });
  const input = el("input", { id: "airai-input", placeholder: "Type a message..." });
  const sendBtn = el("button", { id: "airai-send" });
  sendBtn.textContent = "Send";

  inputbar.appendChild(input);
  inputbar.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messages);
  panel.appendChild(inputbar);

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  function open() {
    panel.style.display = "block";
    if (messages.childElementCount === 0) {
      bot("Hi — this is AIR, the AI receptionist. How can I help you today?");
      step = "START";
    }
    input.focus();
  }

  function close() {
    panel.style.display = "none";
  }

  launcher.addEventListener("click", () => {
    panel.style.display === "block" ? close() : open();
  });

  closeBtn.addEventListener("click", close);

  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    handleInput(text);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      handleInput(text);
    }
  });
})();

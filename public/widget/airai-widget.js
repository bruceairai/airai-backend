(function () {
  const BACKEND_BASE_URL = "https://airai-backend-production.up.railway.app";

  let step = "INIT";

  const lead = {
    reason: "",
    name: "",
    phone: ""
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

  function bot(text) { addMessage("bot", text); }
  function user(text) { addMessage("user", text); }

  function isValidName(text) {
    const t = text.trim().toLowerCase();
    if (t.length < 2) return false;
    if (["yes", "no", "ok", "okay", "yep", "yeah", "nah", "hi", "hello"].includes(t)) return false;
    if (/^\d+$/.test(t)) return false;
    return true;
  }

  function normalizePhone(text) {
    const digits = text.replace(/\D/g, "");
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    return null;
  }

  async function submitLead() {
    try {
      await fetch(`${BACKEND_BASE_URL}/chat-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lead.name,
          phone: lead.phone,
          reason: lead.reason,
          urgency: "unknown"
        })
      });
    } catch (err) {
      console.error("Lead submit failed:", err);
    }
  }

  function handleInput(text) {
    user(text);

    // INIT → ask reason
    if (step === "INIT") {
      bot("How can I help you today?");
      step = "ASK_REASON";
      return;
    }

    // ASK_REASON → capture reason
    if (step === "ASK_REASON") {
      const cleaned = text.trim().toLowerCase();
      if (cleaned.length < 3 || ["hi", "hello", "hey"].includes(cleaned)) {
        bot("Please tell me what you need help with today.");
        return;
      }

      lead.reason = text;
      step = "ASK_NAME";
      bot("Thanks. May I have your name, please?");
      return;
    }

    // ASK_NAME → validate name
    if (step === "ASK_NAME") {
      if (!isValidName(text)) {
        bot("May I please have your name?");
        return;
      }

      lead.name = text;
      step = "ASK_PHONE";
      bot("Thanks, " + lead.name + ". What’s the best phone number to reach you?");
      return;
    }

    // ASK_PHONE → validate phone
    if (step === "ASK_PHONE") {
      const phone = normalizePhone(text);
      if (!phone) {
        bot("Please enter a valid 10-digit phone number.");
        return;
      }

      lead.phone = phone;
      step = "DONE";
      bot("Thank you. We’ve received your information and will get back to you shortly.");
      submitLead();
      return;
    }

    // DONE
    if (step === "DONE") {
      bot("Someone from our team will follow up with you shortly.");
    }
  }

  // UI
  const launcher = el("button", { id: "airai-launcher" }, [
    el("div", { html: "AIR AI" })
  ]);

  const panel = el("div", { id: "airai-panel" });
  const header = el("div", { id: "airai-header", html: "AIR AI Receptionist" });
  const messages = el("div", { id: "airai-messages" });
  const inputbar = el("div", { id: "airai-inputbar" });
  const input = el("input", { id: "airai-input", placeholder: "Type a message..." });
  const sendBtn = el("button", { id: "airai-send", html: "Send" });

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
      bot("Hi — this is the AIR AI assistant.");
      step = "INIT";
    }
    input.focus();
  }

  function close() {
    panel.style.display = "none";
  }

  launcher.onclick = () => {
    panel.style.display === "block" ? close() : open();
  };

  sendBtn.onclick = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    handleInput(text);
  };

  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      handleInput(text);
    }
  };
})();

(function () {
  const BACKEND_BASE_URL = "https://airai-backend-production.up.railway.app";

  let step = "START";

  const lead = {
    reason: "",
    name: ""
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

  async function submitLead() {
    try {
      await fetch(`${BACKEND_BASE_URL}/chat-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: lead.name,
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

    if (step === "START") {
      lead.reason = text;
      step = "ASK_NAME";
      bot("Thanks. May I have your name, please?");
      return;
    }

    if (step === "ASK_NAME") {
      lead.name = text;
      step = "DONE";
      bot("Thank you. We’ve received your information and will get back to you shortly.");
      submitLead();
      return;
    }

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
      bot("Hi — this is AIR, the AI receptionist. How can I help you today?");
      step = "START";
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

(function () {
  // ✅ SET THIS to your Railway backend base URL (no trailing slash)
const BACKEND_BASE_URL = window.location.origin;


  // Optional: greet message
  const GREETING = "Hi — I’m AIR. The artificial intelligence receptionist. What can I help you with today?";

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

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    addMessage("user", text);
    input.value = "";
    input.focus();

    try {
      const r = await fetch(`${BACKEND_BASE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      addMessage("bot", data.reply || "Sorry — I didn’t catch that. Try again?");
    } catch (err) {
      console.error(err);
      addMessage("bot", "Hmm — I’m having trouble connecting right now.");
    }
  }

  // UI
  const launcher = el("button", { id: "airai-launcher", "aria-label": "Open AIRAI chat" }, [
    el("img", { src: "airai-logo.png", alt: "AirAI" })
  ]);

  const panel = el("div", { id: "airai-panel" });
  const header = el("div", { id: "airai-header" });
  const left = el("div", { class: "left" }, [
    el("img", { src: "airai-logo.png", alt: "AIrAI" }),
    el("div", { html: "AirAI Assistant" })
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
    if (messages.childElementCount === 0) addMessage("bot", GREETING);
    input.focus();
  }
  function close() { panel.style.display = "none"; }

  launcher.addEventListener("click", () => {
    panel.style.display === "block" ? close() : open();
  });
  closeBtn.addEventListener("click", close);
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendMessage();
  });
})();

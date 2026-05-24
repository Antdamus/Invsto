(function () {
  "use strict";

  function renderMessageRows(messages = [], utils = window.EmailTriageRenderUtils) {
    if (!messages.length) {
      return `<tr><td colspan="4">No messages loaded.</td></tr>`;
    }

    return messages.map((message) => `
      <tr>
        <td class="email-sender">${utils.escapeHtml(message.from || "Unknown sender")}</td>
        <td class="email-subject">${utils.escapeHtml(message.subject || "(No subject)")}</td>
        <td class="email-received">${utils.escapeHtml(utils.formatDateTime(message.receivedDateTime))}</td>
        <td class="email-preview">${utils.escapeHtml(message.bodyPreview || "")}</td>
      </tr>
    `).join("");
  }

  window.EmailTriageInbox = {
    renderMessageRows,
  };
})();

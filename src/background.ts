chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'fetch') return false;

  fetch(message.url as string, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) {
        sendResponse({ error: `HTTP ${res.status}` });
        return;
      }
      sendResponse({ html: await res.text() });
    })
    .catch((err: unknown) => {
      sendResponse({ error: String(err) });
    });

  return true; // keep message channel open for async response
});

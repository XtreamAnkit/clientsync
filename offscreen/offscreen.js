// Offscreen document: performs clipboard writes on behalf of the service worker
// (which has no DOM / clipboard access). Uses the textarea + execCommand pattern,
// which is the reliable approach inside an offscreen document.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'copy') return;
  const ta = document.getElementById('t');
  ta.value = msg.text || '';
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
});

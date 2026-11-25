// Firefox serves extension pages from moz-extension:// URLs, Chrome from chrome-extension://.
export function isFirefox(): boolean {
  return chrome.runtime.getURL('').startsWith('moz-extension://');
}

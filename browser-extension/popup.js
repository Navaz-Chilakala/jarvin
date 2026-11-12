const $ = (id) => document.getElementById(id);
$('share').addEventListener('click', async () => {
  const button = $('share');
  const match = /^(\d{1,5}):([a-f0-9]{64})$/.exec($('code').value.trim());
  if (!match || +match[1] < 1 || +match[1] > 65535) { $('status').textContent = 'Enter the code shown in Jarvin.'; return; }
  button.disabled = true; $('status').textContent = 'Reading this tab…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '') || tab.incognito) throw new Error('Select a normal HTTP or HTTPS page outside private browsing.');
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const limit = 9000; let text = ''; let visited = 0; let truncated = false;
      const walk = (node) => {
        if (++visited > 20000 || text.length >= limit) { truncated = true; return; }
        if (node.nodeType === Node.TEXT_NODE) { const s = (node.nodeValue || '').replace(/\s+/g, ' ').trim(); if (s) text += s.slice(0, Math.max(0, limit - text.length - 1)) + ' '; return; }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node;
        if (element.matches('script,style,noscript,template,input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]')) return;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        for (const child of element.childNodes) { if (visited > 20000 || text.length >= limit) { truncated = true; break; } walk(child); }
      };
      if (document.body) walk(document.body);
      return { url: location.href, title: document.title.slice(0, 500), text: text.trim().slice(0, limit), truncated };
    } });
    const page = result?.result;
    if (!page || !/^https?:\/\//i.test(page.url)) throw new Error('Could not read this page.');
    const response = await fetch(`http://127.0.0.1:${match[1]}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvin-Token': match[2] }, body: JSON.stringify(page), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Jarvin rejected the code or page. Start a new share in Jarvin.');
    $('code').value = ''; $('status').textContent = 'Sent. Review the page in Jarvin.';
  } catch (error) { $('status').textContent = String(error?.message || error); }
  finally { button.disabled = false; }
});

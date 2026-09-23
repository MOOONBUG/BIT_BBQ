export {};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
type Challenge = {
  render(element: HTMLElement, options: { sitekey: string; action: string; size: string; language: string;
    callback: (token: string) => void; 'error-callback': () => void; 'expired-callback': () => void }): string;
  reset(id: string): void;
};
declare global { interface Window { turnstile?: Challenge } }
const builder = document.querySelector<HTMLElement>('[data-brief]');
if (builder) {
  builder.hidden = false;
  const copy = JSON.parse(builder.dataset.brief!) as {
    serviceType: string; policyVersion: string; configPath: string; price: string; paused: string; labels: string[]; locale: string; title: string; scope: string; details: string[]; fee: string;
    delivery: string; terms: string; copied: string; copyError: string; urlError: string;
    subject: string; email: string; sending: string; unknown: string; invalid: string;
    verification: string; rate: string; unavailable: string; conflict: string; consent: string;
    fallback: string; online: string;
  };
  const get = <T extends HTMLElement>(selector: string) => builder.querySelector<T>(selector)!;
  const form = get<HTMLFormElement>('#brief-form');
  const urlInput = get<HTMLInputElement>('#brief-url');
  const summary = get('#brief-summary'), output = get('#brief-output'), status = get('#brief-status');
  const send = get<HTMLButtonElement>('#brief-send'), edit = get<HTMLButtonElement>('#brief-edit');
  const ack = get<HTMLInputElement>('#brief-ack');
  let busy = false, token = '', widget: string | undefined, challengeLoading = false;
  let requestKey = '', lastPayload = '', payload: Record<string, string> = {};
  let config: { enabled: boolean; siteKey: string } = { enabled: false, siteKey: '' };
  const configure = async () => {
    try {
      const response = await fetch(copy.configPath, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const value = await response.json();
      if (isObject(value) && typeof value.weeklyLimit === 'number') document.querySelectorAll<HTMLElement>('[data-weekly-limit]').forEach(el => { el.textContent = (el.dataset.weeklyLimit || '').replace('{limit}', String(value.weeklyLimit)); });
      if (isObject(value) && value.enabled === true && typeof value.siteKey === 'string' && value.siteKey) config = { enabled: true, siteKey: value.siteKey };
    } catch { /* Existing email and copy flow remains available. */ }
    get('[data-step-total]').textContent = config.enabled ? '03' : '02';
    get('#brief-mode').textContent = config.enabled ? copy.online : copy.fallback;
  };
  const configured = configure();
  const renderChallenge = async () => {
    if (challengeLoading || widget !== undefined) return;
    challengeLoading = true;
    try {
      if (!window.turnstile) await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const timer = window.setTimeout(() => { script.remove(); reject(Error('timeout')); }, 10000);
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(Error('load')); };
        document.head.appendChild(script);
      });
      if (!window.turnstile) throw Error('unavailable');
      widget = window.turnstile.render(get('#brief-challenge'), {
        sitekey: config.siteKey, action: 'enquiry', size: 'compact', language: copy.locale === 'zh-hant' ? 'zh-tw' : copy.locale,
        callback: value => { token = value; if (status.textContent === copy.verification) status.textContent = ''; },
        'error-callback': () => { token = ''; status.textContent = copy.verification; },
        'expired-callback': () => { token = ''; status.textContent = copy.verification; },
      });
    } catch { status.textContent = copy.verification; }
    finally { challengeLoading = false; }
  };
  const resetChallenge = () => { token = ''; if (widget !== undefined) window.turnstile?.reset(widget); };
  const validateUrl = () => {
    let valid = false;
    try { const url = new URL(urlInput.value); valid = ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; } catch {}
    urlInput.setCustomValidity(valid || !urlInput.value ? '' : copy.urlError);
    get('#brief-url-error').textContent = valid || !urlInput.value ? '' : copy.urlError;
    return valid;
  };
  urlInput.addEventListener('input', validateUrl);
  for (const selector of ['#brief-market', '#brief-goal']) {
    get<HTMLInputElement | HTMLTextAreaElement>(selector).addEventListener('input', event => {
      (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).setCustomValidity('');
    });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !validateUrl() || !form.reportValidity()) return;
    const data = new FormData(form), names = ['email', 'pageUrl', 'market', 'goal', 'issue', 'preferredTime'];
    const next = Object.fromEntries(names.map(name => [name, String(data.get(name) || '').trim()]));
    if (!next.market || !next.goal) {
      const field = get<HTMLInputElement | HTMLTextAreaElement>(!next.market ? '#brief-market' : '#brief-goal');
      field.setCustomValidity(copy.invalid); field.reportValidity(); return;
    }
    busy = true;
    try {
      await configured;
      payload = { ...next, locale: copy.locale, acknowledgementVersion: '2026-09-23', ...(copy.serviceType === 'free_trial' ? { serviceType: copy.serviceType, policyVersion: copy.policyVersion } : {}) };
      const serialized = JSON.stringify(payload);
      if (lastPayload !== serialized) { requestKey = crypto.randomUUID(); lastPayload = serialized; }
      output.textContent = [copy.title, '', ...names.flatMap((name, i) => [copy.labels[i], next[name] || '—', '']), copy.scope, ...copy.details, '', `${copy.fee}: ${copy.price}`, copy.delivery, copy.terms].join('\n');
      get<HTMLAnchorElement>('#brief-email').href = `mailto:${copy.email}?subject=${encodeURIComponent(copy.subject)}&body=${encodeURIComponent(output.textContent)}`;
      ack.checked = false;
      status.textContent = '';
      form.hidden = true; summary.hidden = false;
      get('#brief-direct').hidden = send.hidden = !config.enabled;
      get('[data-step-label]').textContent = '02';
      get('#brief-summary-heading').focus();
      if (config.enabled) { resetChallenge(); await renderChallenge(); }
    } finally { busy = false; }
  });
  ack.addEventListener('change', () => { if (ack.checked && status.textContent === copy.consent) status.textContent = ''; });
  edit.addEventListener('click', () => {
    if (busy) return;
    summary.hidden = true; form.hidden = false; status.textContent = '';
    get('[data-step-label]').textContent = '01'; urlInput.focus();
  });
  send.addEventListener('click', async () => {
    if (busy) return;
    if (!ack.checked) { status.textContent = copy.consent; ack.focus(); return; }
    if (!token) { status.textContent = copy.verification; await renderChallenge(); return; }
    busy = true; send.disabled = edit.disabled = true; ack.disabled = true;
    summary.setAttribute('aria-busy', 'true'); status.textContent = copy.sending;
    try {
      const response = await fetch('/api/enquiries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestKey, turnstileToken: token }), signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!isObject(result)) throw Error('response');
      if (!response.ok) {
        const messages: Record<string, string> = { invalid: copy.invalid, too_large: copy.invalid, forbidden: copy.unavailable,
          verification: copy.verification, rate_limited: copy.rate, unavailable: copy.unavailable, conflict: copy.conflict, paused: copy.paused };
        status.textContent = (typeof result.error === 'string' && messages[result.error]) || copy.unavailable;
        resetChallenge(); return;
      }
      if (result.status !== 'received' || typeof result.id !== 'string' || !/^MSC-[0-9a-f-]{36}$/.test(result.id)) throw Error('receipt');
      get('#brief-reference').textContent = result.id;
      summary.hidden = true; get('#brief-received').hidden = false; get('#brief-mode').hidden = true;
      get('[data-step-label]').textContent = '03'; get('#brief-received-heading').focus();
    } catch { status.textContent = copy.unknown; resetChallenge(); }
    finally { busy = false; send.disabled = edit.disabled = ack.disabled = false; summary.removeAttribute('aria-busy'); }
  });
  get('#brief-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(output.textContent || ''); status.textContent = copy.copied; }
    catch { status.textContent = copy.copyError; const range = document.createRange(); range.selectNodeContents(output); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); output.focus(); }
  });
}

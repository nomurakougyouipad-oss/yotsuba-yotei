// よつば週間予定 service worker
// - 役目はプッシュ通知だけです。画面のファイルは保存しません(いつもどおり、毎回新しいものを読みます)
// - 通知は Cloud Functions(functions/index.js)から Firebase Cloud Messaging で届きます
// - 届いたら表示し、押したら確認用アプリ(yotei.html)の、変わった日の週を開きます
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// 届いたら表示する(中身は data の title / body / tag / url / chg)
//   chg … 変わった日と前後の行き先。押して開いた画面の「変更のお知らせ」に使います
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { body: e.data ? e.data.text() : '' } }; }
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  e.waitUntil(self.registration.showNotification(d.title || 'よつば週間予定', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: './icons/yotei-192.png',
    data: { url: d.url || './yotei.html', chg: d.chg || '' },
  }));
});

// 押したら:確認用アプリが開いていればそれを前に出して週と「変更のお知らせ」を渡し、なければ開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL(data.url || './yotei.html', self.registration.scope);
  const week = url.searchParams.get('week');
  if (data.chg) url.searchParams.set('chg', data.chg);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope) && c.url.includes('yotei.html') && 'focus' in c);
    if (!open) return self.clients.openWindow(url.href);
    open.postMessage({ type: 'openWeek', week, chg: data.chg || '' });
    return open.focus();
  }));
});

// よつば週間予定 service worker
// - 役目はプッシュ通知だけです。画面のファイルは保存しません(いつもどおり、毎回新しいものを読みます)
// - Firebase の部品は読みません。届いた通知をそのまま表示するので、Firebase の版とは関係ありません
// - 通知は Cloud Functions(functions/index.js)から Firebase Cloud Messaging で届きます
// - 届いた通知の「変更の中身」(chg)は、この端末の Cache Storage(yotei-notice)にも控えます。
//   確認用アプリ(yotei.html)は、開いたとき・前に出たときにここを読んで「変更のお知らせ」を出すので、
//   通知を押したときにアプリが閉じていても、裏で開いたままでも、同じように出ます
// - 押したら確認用アプリの、変わった日の週を開きます
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* ---- 届いた通知の控え ----
   [{ id, at, week, chg, clickedAt }] … id は通知の tag、at は届いた時刻、week は開く週(月曜)、
   clickedAt は押した時刻。確認用アプリが「閉じる」を押すと、出したぶんを消します */
const NOTICE_CACHE = 'yotei-notice';
const NOTICE_URL = new URL('notice.json', self.registration.scope).href;  // 控えの名前(このURLを読みに行くことはありません)
const NOTICE_KEEP_MS = 7 * 24 * 3600 * 1000;   // 7日たった控えは捨てます
const NOTICE_MAX = 20;

async function readNotices() {
  try {
    const r = await (await caches.open(NOTICE_CACHE)).match(NOTICE_URL);
    const a = r ? await r.json() : [];
    return Array.isArray(a) ? a : [];
  } catch (err) { return []; }
}
async function writeNotices(list) {
  const c = await caches.open(NOTICE_CACHE);
  await c.put(NOTICE_URL, new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } }));
}
/** 控えに1件足します(同じ id があれば入れ替え、古いものは捨てます) */
async function saveNotice(entry) {
  const now = Date.now();
  const list = (await readNotices()).filter(x => x && x.id !== entry.id && now - (x.at || 0) < NOTICE_KEEP_MS);
  list.push(entry);
  await writeNotices(list.slice(-NOTICE_MAX));
}
/** 押したことを控えます(画面がメッセージを受け取れなかったときも、前に出たときにその週へ移れるように) */
async function markClicked(id) {
  if (!id) return;
  const list = await readNotices();
  const x = list.find(n => n && n.id === id);
  if (!x) return;
  x.clickedAt = Date.now();
  await writeNotices(list);
}
/** 開いている確認用アプリに知らせます */
async function tellPages(msg) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => { try { c.postMessage(msg); } catch (err) { } });
}

// 届いたら表示する(中身は data の title / body / tag / url / chg)
//   chg … 変わった日と前後の行き先。「変更のお知らせ」に使います
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { body: e.data ? e.data.text() : '' } }; }
  const d = { ...(p.notification || {}), ...(p.data || {}) };
  const id = d.tag || ('n' + Date.now());
  const url = d.url || './yotei.html';
  const week = new URL(url, self.registration.scope).searchParams.get('week') || '';
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'よつば週間予定', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: './icons/yotei-192.png',
      data: { id, url, chg: d.chg || '' },
    }),
    // 変更の中身を控え、開いている画面にも知らせます(控えられなくても、通知の表示は止めません)
    d.chg
      ? saveNotice({ id, at: Date.now(), week, chg: d.chg }).then(() => tellPages({ type: 'noticeSaved' })).catch(() => { })
      : null,
  ]));
});

// 押したら:
//   閉じていた        → 変更の中身を付けた URL で開く
//   裏で開いたままだった → 前に出して、変更の中身を付けた URL で開き直す。
//                       開き直せない端末・画面では、中身をメッセージで渡す
//   どの場合も、押したことを控えに残す(画面は前に出たときに控えを読み直します)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL(data.url || './yotei.html', self.registration.scope);
  const week = url.searchParams.get('week') || '';
  if (data.chg) url.searchParams.set('chg', data.chg);
  if (data.id) url.searchParams.set('nid', data.id);
  const msg = { type: 'openWeek', week, chg: data.chg || '', id: data.id || '' };
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find(c => c.url.startsWith(self.registration.scope) && c.url.includes('yotei.html'));
    const marked = markClicked(data.id).catch(() => { });
    if (!open) {
      await self.clients.openWindow(url.href);
      return marked;
    }
    let c = open;
    try { c = (await open.focus()) || open; } catch (err) { }
    let moved = false;
    try { if (typeof c.navigate === 'function') moved = !!(await c.navigate(url.href)); } catch (err) { }
    await marked;
    if (!moved) c.postMessage(msg);
  })());
});

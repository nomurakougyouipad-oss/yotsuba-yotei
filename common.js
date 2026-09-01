/* =======================================================================
   よつば週間予定アプリ|共通ロジック  common.js
   hensyu.html(編集用) と yotei.html(確認用) の両方から読みます。

   ★ つなぐ先は yotsuba-yotei ひとつだけです。
      日報アプリ(yotsuba-nippo)とはつながっていません。
      メンバーも工事も、このアプリで登録・管理します。

        yotei/members  名簿   { id, name, kubun, shozoku, order, active }
        yotei/jobs     工事   { id, name, no, category, order, active }
        yotei/weeks    予定   週ごと。assign/{工事id}/{日付}/members/{名前}
   ======================================================================= */
(function (global) {
  'use strict';

  /* ===================================================================
     ■ 設定 ここだけ書き換えれば動きが変わります
     =================================================================== */

  /* --- ② 週間予定プロジェクト(読み書きする) ------------------------- */
  var yoteiConfig = {
    apiKey: "AIzaSyBiFyKq0D-CsZud44fHVWInKdK7qHzWCRU",
    authDomain: "yotsuba-yotei.firebaseapp.com",
    databaseURL: "https://yotsuba-yotei-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "yotsuba-yotei",
    storageBucket: "yotsuba-yotei.firebasestorage.app",
    messagingSenderId: "647082371270",
    appId: "1:647082371270:web:82f0791c482e9f6a3e8fc7"
  };

  /* --- メンバー(名簿)-------------------------------------------------
     日報アプリとはつながっていません。このアプリで登録・管理します。
        yotei/members/{id} : { id, name, kubun, shozoku, order, active }
     kubun は「自社」か「協力」の2つだけ(協力なら青文字で出します)。
     予定データは【名前】で持っているので、同じ名前で登録すればつながります。
     ------------------------------------------------------------------- */
  var MEMBERS_PATH = 'yotei/members';
  var MEMBER_NAME_MAX = 30;
  var MEMBER_SHOZOKU_MAX = 30;
  var KUBUN = ['自社', '協力'];

  /* --- カテゴリ --------------------------------------------------------
     工事を登録するときに、この3つから選びます。
     ------------------------------------------------------------------- */
  var CATEGORIES = {
    order: [1, 2, 3],
    labels: { 1: '① 東レ工事', 2: '② 常駐・工場', 3: '③ 外・出張ほか' }
  };

  /* --- 職長(◎)---------------------------------------------------------
     「その人はいつも職長」ではなく、マス(工事×日)ごとに決めます。
     しるしの1つとして mark:"◎" を付けるだけです。
     1つのマスに何人付けてもかまいません。
     ------------------------------------------------------------------- */
  var FOREMAN_MARK = '◎';

  /* --- 工事 -----------------------------------------------------------
     工事はこのアプリで登録します(日報の master/jobs は読みません)。
        yotei/jobs/{id} : { id, name, no, category, order, active }
     id は push() が発行するキー。注番(no)は任意で、あとから入れられます。
     予定データのキーもこの id です。
     ------------------------------------------------------------------- */
  var JOBS_PATH = 'yotei/jobs';
  var BILLED_PATH = 'yotei/billed';
  var LOGS_PATH = 'yotei/logs';
  var LOG_KEEP = 100;                        // 1つの週に残す履歴の件数
  var JOB_NAME_MAX = 60;
  var JOB_NO_MAX = 30;
  // 「前に使った工事」パネルが、何週さかのぼって探すか
  var JOB_KEEP_WEEKS = 4;

  /* --- そのほか ------------------------------------------------------- */
  var REST_KEY = 'REST';                     // 「休み」行の jobKey
  // しるし。よく使う5つはボタンで、それ以外は手で打てます(4文字まで)。
  // ◎だけは「そのマスの職長」を表し、名前を先頭に並べます。
  // ほかのしるしに意味は持たせません(集計では1人=1として数えます)
  var MARKS = ['', '◎', '△', '☆', '✕'];
  var MARK_MAX = 4;
  /* 選択シートの「🏭 工場の人」に出す工事。
     工事名で指しています。増減するときはここだけ直してください */
  /* 「週のすべて」タブで、分類を出す順番。
     表のふつうの並び(CATEGORIES.order)とは別にしています。
     集計など、ほかの並びには影響しません */
  var ALL_TAB_ORDER = [2, 1, 3];             // ②常駐・工場 → ①東レ工事 → ③外・出張ほか

  var FACTORY_JOBS = ['工場（入場あり）', '工場（応援入場あり）', '工場（応援）'];

  /* LINEの文面に出さない工事。工事名の「前のほう」で見ます。
     '緑化部' と書いておけば、「緑化部」「緑化部 応援」
     「緑化部 ハーモニープラザ 溶接」のように緑化部で始まる工事は
     すべて外れます。新しい緑化部の工事が増えても、直さずに済みます。
     「休み」の行も出しません(下の lineLines を参照) */
  var LINE_SKIP_PREFIXES = ['緑化部'];

  /** その工事名が、配信に出さない工事かどうか */
  function isLineSkipped(name) {
    var t = String(name == null ? '' : name);
    return LINE_SKIP_PREFIXES.some(function (p) { return t.indexOf(p) === 0; });
  }

  var OPERATOR = '事務所';                    // 名前をまだ決めていないときの既定
  var OPERATOR_KEY = 'yotsuba.yotei.operator';
  var OPERATOR_MAX = 20;                     // ルールの updatedBy と同じ上限
  var SAVE_DEBOUNCE_MS = 300;

  /* ===================================================================
     ■ 保存するときに残す名前(この端末に覚えます)
     =================================================================== */

  /** この端末で決めた名前。決めていなければ空文字 */
  function getOperator() {
    try {
      return String(window.localStorage.getItem(OPERATOR_KEY) || '').trim().slice(0, OPERATOR_MAX);
    } catch (e) { return ''; }
  }

  /** 名前を決め直します。空にすると忘れます。実際に入った文字を返します */
  function setOperator(name) {
    var v = String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, OPERATOR_MAX);
    try {
      if (v) window.localStorage.setItem(OPERATOR_KEY, v);
      else window.localStorage.removeItem(OPERATOR_KEY);
    } catch (e) { /* 保存できない端末でも、動きは止めません */ }
    return v;
  }

  /** updatedBy に入れる名前 */
  function operatorName() { return getOperator() || OPERATOR; }

  /* ===================================================================
     ■ Firebase 接続
     =================================================================== */

  var yoteiDb = null;

  function initFirebase() {
    if (yoteiDb) return;
    if (typeof firebase === 'undefined') {
      throw new Error('Firebase SDK が読み込まれていません');
    }
    var app = firebase.apps.length ? firebase.app() : firebase.initializeApp(yoteiConfig);
    yoteiDb = app.database();
  }

  /* ===================================================================
     ■ 日付(週は月曜はじまり)
     =================================================================== */

  var DOW = ['月', '火', '水', '木', '金', '土', '日'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Date → 'YYYY-MM-DD' */
  function toKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 'YYYY-MM-DD' → Date(時刻は 00:00 のローカル時間) */
  function parseKey(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function toDate(x) { return (typeof x === 'string') ? parseKey(x) : new Date(x.getTime()); }

  function addDays(x, n) {
    var d = toDate(x);
    d.setDate(d.getDate() + n);
    return d;
  }

  /** その日が属する週の月曜(Date) */
  function mondayOf(x) {
    var d = toDate(x);
    var diff = (d.getDay() + 6) % 7;   // 日=0 → 6, 月=1 → 0
    return addDays(d, -diff);
  }

  /** 月曜キー('YYYY-MM-DD')を n 週ずらす */
  function addWeeks(mondayKey, n) {
    return toKey(addDays(parseKey(mondayKey), n * 7));
  }

  /** 今週の月曜キー */
  function thisMonday() { return toKey(mondayOf(new Date())); }

  function todayKey() { return toKey(new Date()); }

  /** 月曜キー → 月〜日の7日ぶんのキー配列 */
  function weekDates(mondayKey) {
    var base = parseKey(mondayKey), out = [];
    for (var i = 0; i < 7; i++) out.push(toKey(addDays(base, i)));
    return out;
  }

  /** 月曜キー → { range:'6/29〜7/5', year:'2026年' } */
  function weekLabel(mondayKey) {
    var a = parseKey(mondayKey), b = addDays(a, 6);
    return {
      range: (a.getMonth() + 1) + '/' + a.getDate() + '〜' + (b.getMonth() + 1) + '/' + b.getDate(),
      year: a.getFullYear() + '年'
    };
  }

  /** その週がどの月のものか。木曜(週の真ん中)で決めます。
      こうすると、月をまたぐ週でも「どちらの月の週か」が素直に決まります */
  function weekMonth(mondayKey) {
    var t = addDays(parseKey(mondayKey), 3);   // 木曜
    return { y: t.getFullYear(), m: t.getMonth() };
  }

  /** その月の1日を含む週の月曜キー(m は 0〜11。はみ出しても年をまたいで計算します) */
  function monthTopMonday(y, m) {
    return toKey(mondayOf(new Date(y, m, 1)));
  }

  /** 前月(-1)・翌月(+1)の第1週(1日を含む週)の月曜キー。
      1日が今の週に入っていると同じ週になってしまうので、そのときはもう1か月ずらします */
  function moveMonth(mondayKey, step) {
    var w = weekMonth(mondayKey);
    var k = monthTopMonday(w.y, w.m + step);
    if (k === mondayKey) k = monthTopMonday(w.y, w.m + step * 2);
    return k;
  }

  /** 日付キー → '7/2(木)' */
  function dayLabel(dateKey) {
    var d = parseKey(dateKey);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[(d.getDay() + 6) % 7] + ')';
  }

  /** 日付キー → 曜日の並び順(月=0 … 日=6) */
  function dowIndex(dateKey) { return (parseKey(dateKey).getDay() + 6) % 7; }

  function isToday(dateKey) { return dateKey === todayKey(); }

  /* ===================================================================
     ■ 日報マスタ(読み取り専用・get() で1回だけ読んでキャッシュ)
     =================================================================== */

  var master = {
    // メンバー(名簿)。yotei/members から入れます
    workers: [],        // [{id,name,kubun,shozoku,order,active,coop}] order 順
    workerByName: {},
    membersLoaded: false,

    // 工事。yotei/jobs から入れます
    jobs: [],           // [{id,name,no,category,order,active}] カテゴリ→order 順
    jobById: {},
    jobsLoaded: false
  };

  function readOnce(ref) {
    // v9 compat は get() を持っています。無い環境のための保険で once() に落とします
    return ref.get ? ref.get() : ref.once('value');
  }

  /* ===================================================================
     ■ メンバー(yotei/members)
       このアプリで登録・管理します。日報とはつながっていません。
     =================================================================== */

  function applyMembers(v) {
    var list = [];
    Object.keys(v || {}).forEach(function (id) {
      var m = (v || {})[id] || {};
      if (!m.name) return;
      var kubun = (KUBUN.indexOf(m.kubun) >= 0) ? m.kubun : '自社';
      list.push({
        id: id,
        name: String(m.name),
        kubun: kubun,
        shozoku: m.shozoku ? String(m.shozoku) : '',
        order: (typeof m.order === 'number') ? m.order : 0,
        active: m.active !== false,
        coop: kubun === '協力'
      });
    });
    list.sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return a.name < b.name ? -1 : 1;
    });
    master.workers = list;
    master.workerByName = {};
    list.forEach(function (w) {
      if (master.workerByName[w.name]) {
        console.warn('[common] 同じ名前のメンバーが2人います:', w.name);
      }
      master.workerByName[w.name] = w;
    });
    master.membersLoaded = true;
  }

  /** メンバーを購読します。直すと全端末にその場で反映されます */
  function subscribeMembers(cb) {
    initFirebase();
    var ref = yoteiDb.ref(MEMBERS_PATH);
    var handler = ref.on('value',
      function (snap) { applyMembers(snap.val()); if (cb) cb(master.workers); },
      function (err) {
        console.warn('[common] メンバーを読めませんでした:', err);
        master.membersLoaded = true;
        if (cb) cb(master.workers);
      });
    return function () { ref.off('value', handler); };
  }

  /** 1回だけ読む版(確認用アプリなど) */
  function loadMembers() {
    initFirebase();
    return readOnce(yoteiDb.ref(MEMBERS_PATH)).then(function (snap) {
      applyMembers(snap.val());
      return master.workers;
    }).catch(function (e) {
      console.warn('[common] メンバーを読めませんでした:', e);
      master.membersLoaded = true;
      return master.workers;
    });
  }

  function cleanMemberName(s) { return String(s == null ? '' : s).trim().slice(0, MEMBER_NAME_MAX); }
  function cleanShozoku(s) { return String(s == null ? '' : s).trim().slice(0, MEMBER_SHOZOKU_MAX); }
  function cleanKubun(s) { return (KUBUN.indexOf(s) >= 0) ? s : '自社'; }

  function nextMemberOrder() {
    var max = -1;
    master.workers.forEach(function (w) { if (w.order > max) max = w.order; });
    return max + 1;
  }

  /** メンバーを1人足します。名前だけあれば登録できます */
  function addMember(name, kubun, shozoku) {
    initFirebase();
    var nm = cleanMemberName(name);
    if (!nm) return Promise.reject(new Error('名前を入れてください'));
    var ref = yoteiDb.ref(MEMBERS_PATH).push();
    var id = ref.key;
    return ref.set({
      id: id,
      name: nm,
      kubun: cleanKubun(kubun),
      shozoku: cleanShozoku(shozoku),
      order: nextMemberOrder(),
      active: true
    }).then(function () { return id; });
  }

  /**
   * まとめて足します。1行に1人。次の2通りを受け付けます。
   *     松高
   *     松高,自社,よつば建設
   * すでに同じ名前がいる行は飛ばします。
   * 戻り値 { added:[名前], skipped:[名前] }
   */
  function addMembersBulk(text, defaultKubun) {
    initFirebase();
    var lines = String(text || '').split(/\r?\n/);
    var added = [], skipped = [], seen = {};
    var patch = {};
    var order = nextMemberOrder();

    lines.forEach(function (raw) {
      var parts = String(raw).split(/[,、\t]/);
      var nm = cleanMemberName(parts[0]);
      if (!nm) return;
      if (master.workerByName[nm] || seen[nm]) { skipped.push(nm); return; }
      seen[nm] = true;

      var id = yoteiDb.ref(MEMBERS_PATH).push().key;
      patch[id] = {
        id: id,
        name: nm,
        kubun: cleanKubun(parts.length > 1 ? String(parts[1]).trim() : defaultKubun),
        shozoku: cleanShozoku(parts[2]),
        order: order++,
        active: true
      };
      added.push(nm);
    });

    if (!added.length) return Promise.resolve({ added: added, skipped: skipped });
    return yoteiDb.ref(MEMBERS_PATH).update(patch).then(function () {
      return { added: added, skipped: skipped };
    });
  }

  /** メンバーを直します。渡した項目だけ書き替えます */
  function updateMember(memberId, patch) {
    initFirebase();
    var w = master.workerByName && master.workers.filter(function (x) { return x.id === memberId; })[0];
    if (!w) return Promise.reject(new Error('そのメンバーが見つかりません'));

    var up = {};
    if (patch.name != null) {
      var nm = cleanMemberName(patch.name);
      if (!nm) return Promise.reject(new Error('名前を入れてください'));
      up.name = nm;
    }
    if (patch.kubun != null) up.kubun = cleanKubun(patch.kubun);
    if (patch.shozoku != null) up.shozoku = cleanShozoku(patch.shozoku);
    if (patch.active != null) up.active = !!patch.active;
    if (!Object.keys(up).length) return Promise.resolve();
    return yoteiDb.ref(MEMBERS_PATH + '/' + memberId).update(up);
  }

  function setMemberActive(memberId, on) {
    return updateMember(memberId, { active: !!on });
  }

  /** 1つ上/下へ動かします。dir は -1 か +1 */
  function moveMember(memberId, dir) {
    initFirebase();
    var list = master.workers;
    var i = -1;
    list.forEach(function (x, n) { if (x.id === memberId) i = n; });
    var k = i + (dir < 0 ? -1 : 1);
    if (i < 0 || k < 0 || k >= list.length) return Promise.resolve(false);

    var patch = {};
    list.forEach(function (x, n) { patch[x.id + '/order'] = n; });
    patch[list[i].id + '/order'] = k;
    patch[list[k].id + '/order'] = i;
    return yoteiDb.ref(MEMBERS_PATH).update(patch).then(function () { return true; });
  }

  /**
   * その人が、どの週の予定に何マス入っているかを調べます。
   * 予定は【名前】で持っているので、名前で探します。
   */
  function memberUsage(name) {
    initFirebase();
    return readOnce(yoteiDb.ref('yotei/weeks')).then(function (snap) {
      var v = snap.val() || {};
      var hits = [], cells = 0;
      Object.keys(v).forEach(function (wk) {
        var assign = (v[wk] || {}).assign || {};
        Object.keys(assign).forEach(function (jobId) {
          var days = assign[jobId] || {};
          Object.keys(days).forEach(function (d) {
            var mem = (days[d] || {}).members || {};
            if (mem[name] !== undefined) {
              hits.push({ week: wk, jobId: jobId, date: d });
              cells++;
            }
          });
        });
      });
      return { hits: hits, cells: cells };
    });
  }

  /**
   * メンバーを消します。予定に入っている分も一緒に消えます。
   * 記録を残したいときは setMemberActive(id, false) を使ってください。
   */
  function deleteMember(memberId, name) {
    initFirebase();
    if (!validKey(memberId)) return Promise.reject(new Error('このメンバーは消せません'));
    return memberUsage(name).then(function (u) {
      var patch = {};
      patch['members/' + memberId] = null;
      u.hits.forEach(function (h) {
        patch['weeks/' + h.week + '/assign/' + h.jobId + '/' + h.date + '/members/' + name] = null;
      });
      return yoteiDb.ref('yotei').update(patch).then(function () { return u; });
    });
  }

  /* --- 名簿の小道具 --------------------------------------------------- */

  function isCoop(name) {
    var w = master.workerByName[name];
    return !!(w && w.coop);
  }

  /** そのマスで職長かどうか。しるしが ◎ なら職長です */
  function isForemanMark(mark) { return mark === FOREMAN_MARK; }

  /**
   * しるしを整えます。ボタンの5つでも、手で打った文字でもかまいません。
   * 4文字まで。区切りに使う「・」と改行は、文面が崩れるので落とします。
   */
  function cleanMark(s) {
    return String(s == null ? '' : s)
      .replace(/[・\r\n\t]/g, '')
      .trim()
      .slice(0, MARK_MAX);
  }

  /** 名簿にいる人かどうか(予定にだけ残っている名前を見分けます) */
  function isKnown(name) { return !!master.workerByName[name]; }

  /**
   * カテゴリ番号 → その工事一覧(order 順)。
   * 非表示(active:false)にしていても、その週の予定に人が入っていれば残します。
   * 隠したとたんに予定が見えなくなる事故を防ぐためです。
   */
  function jobsByCat(cat, usedIds) {
    var used = usedIds || {};
    return master.jobs.filter(function (j) {
      return j.category === cat && (j.active || used[j.id]);
    });
  }

  /**
   * 選択シートに並べる顔ぶれ。
   *   ・名簿にいる人(active)
   *   ・非表示にしていても、いま使っている人(usedNames)は残す
   *   ・【名簿にいないのに予定へ入っている名前も必ず出す】
   *     出さないと、その人を外すこともしるしを付けることもできなくなります。
   *     unknown:true を付けて返すので、呼び出し側で分かるように出してください。
   */
  function selectableWorkers(usedNames) {
    var used = usedNames || {};
    var out = master.workers.filter(function (w) { return w.active || used[w.name]; });
    var have = {};
    out.forEach(function (w) { have[w.name] = true; });

    Object.keys(used).forEach(function (name) {
      if (have[name]) return;
      out.push({
        id: null, name: name, kubun: '', shozoku: '',
        order: 999999, active: true, coop: false, unknown: true
      });
    });
    return out;
  }

  /**
   * 工事の見出し。
   *   name … 工事名   sub … 注番(空のことがあります)
   * 消えた工事を指している古い予定でも、id をそのまま出して落ちません。
   */
  function jobLabel(jobId) {
    if (jobId === REST_KEY) return { id: REST_KEY, name: '休み', sub: '', missing: false };
    var j = master.jobById[jobId];
    if (!j) return { id: jobId, name: '(消された工事)', sub: '', missing: true };
    return { id: j.id, name: j.name, sub: j.no || '', missing: false };
  }

  /* ===================================================================
     ■ 工事(yotei/jobs)
       このアプリで登録・編集します。日報の master/jobs は読みません。
       件数に上限はありません。
     =================================================================== */

  function applyJobs(v) {
    var list = [];
    Object.keys(v || {}).forEach(function (id) {
      var j = (v || {})[id] || {};
      if (!j.name) return;
      list.push({
        id: id,
        name: String(j.name),
        no: j.no ? String(j.no) : '',
        start: cleanStart(j.start),      // 開始日(任意)。'' なら未設定
        category: (CATEGORIES.labels[j.category] ? j.category : 3),
        order: (typeof j.order === 'number') ? j.order : 0,
        active: j.active !== false
      });
    });
    // カテゴリ → order → 名前 の順に並べます
    list.sort(function (a, b) {
      if (a.category !== b.category) return a.category - b.category;
      if (a.order !== b.order) return a.order - b.order;
      return a.name < b.name ? -1 : 1;
    });
    master.jobs = list;
    master.jobById = {};
    list.forEach(function (j) { master.jobById[j.id] = j; });
    master.jobsLoaded = true;
  }

  /** 工事一覧を購読します。追加・編集が全端末にその場で反映されます */
  function subscribeJobs(cb) {
    initFirebase();
    var ref = yoteiDb.ref(JOBS_PATH);
    var handler = ref.on('value',
      function (snap) { applyJobs(snap.val()); if (cb) cb(master.jobs); },
      function (err) {
        console.warn('[common] 工事を読めませんでした:', err);
        master.jobsLoaded = true;
        if (cb) cb(master.jobs);
      });
    return function () { ref.off('value', handler); };
  }

  /** 1回だけ読む版(確認用アプリなど) */
  function loadJobs() {
    initFirebase();
    return readOnce(yoteiDb.ref(JOBS_PATH)).then(function (snap) {
      applyJobs(snap.val());
      return master.jobs;
    }).catch(function (e) {
      console.warn('[common] 工事を読めませんでした:', e);
      master.jobsLoaded = true;
      return master.jobs;
    });
  }

  function cleanJobName(s) { return String(s == null ? '' : s).trim().slice(0, JOB_NAME_MAX); }
  function cleanJobNo(s) { return String(s == null ? '' : s).trim().slice(0, JOB_NO_MAX); }

  /** 開始日。'YYYY-MM-DD' の形だけ通します。それ以外は '' にします */
  function cleanStart(s) {
    var t = String(s == null ? '' : s).trim();
    return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(t) ? t : '';
  }

  /**
   * その工事が、その日までに始まっているか。
   * 開始日が入っていなければ false(判定の材料が無いため)。
   */
  function jobStartedBy(job, dateKey) {
    return !!(job && job.start && job.start <= dateKey);
  }

  /**
   * その工事に人が入った、いちばん新しい日。渡した週の中だけで探します。
   * 見つからなければ '' を返します。
   */
  function lastUsedDate(weeks, jobId) {
    var last = '';
    Object.keys(weeks || {}).forEach(function (wk) {
      var days = (((weeks[wk] || {}).assign) || {})[jobId] || {};
      Object.keys(days).forEach(function (d) {
        var c = days[d] || {};
        if (Object.keys(c.members || {}).length || (c.extras || []).length) {
          if (d > last) last = d;
        }
      });
    });
    return last;
  }

  /** その工事の開始日が、その週の中にあるか(その週から始まる工事) */
  function jobStartsInWeek(job, mondayKey) {
    if (!job || !job.start) return false;
    var sun = toKey(addDays(parseKey(mondayKey), 6));
    return job.start >= mondayKey && job.start <= sun;
  }

  /**
   * 「使う工事だけ」で出すかどうか。次のどれかに当てはまれば出します。
   *   ・その週に1人でも入っている        (o.usedNow)
   *   ・先週に1人でも入っている(継続中)  (o.usedPrev)
   *   ・「今週出す工事」に入れてある      (o.shown)
   *   ・開始日がその週の中にある          (その週から始まる工事)
   * 2週間以上前に終わった工事は、どれにも当たらないので隠れます。
   */
  function jobVisible(job, o) {
    o = o || {};
    if (o.usedNow || o.usedPrev || o.shown) return true;
    return jobStartsInWeek(job, o.monday);
  }

  /** その工事が、その週(月曜キー)までに始まっているか。週の日曜で見ます */
  function jobStartedByWeek(job, mondayKey) {
    return jobStartedBy(job, toKey(addDays(parseKey(mondayKey), 6)));
  }

  /** そのカテゴリの最後に置くための order */
  function nextJobOrder(cat) {
    var max = -1;
    master.jobs.forEach(function (j) {
      if (j.category === cat && j.order > max) max = j.order;
    });
    return max + 1;
  }

  /**
   * 工事を1件起こします。工事名だけあれば登録できます。
   * 戻り値は新しい id(そのまま予定のキーになります)。
   */
  function addJob(name, cat, no, start) {
    initFirebase();
    var nm = cleanJobName(name);
    if (!nm) return Promise.reject(new Error('工事名を入れてください'));
    var c = CATEGORIES.labels[cat] ? cat : 3;
    var ref = yoteiDb.ref(JOBS_PATH).push();
    var id = ref.key;
    return ref.set({
      id: id,
      name: nm,
      no: cleanJobNo(no),
      start: cleanStart(start),
      category: c,
      order: nextJobOrder(c),
      active: true
    }).then(function () { return id; });
  }

  /**
   * 工事を直します。渡した項目だけ書き替えます。
   * カテゴリを変えたときは、移り先の最後に置きます。
   */
  function updateJob(jobId, patch) {
    initFirebase();
    var j = master.jobById[jobId];
    if (!j) return Promise.reject(new Error('その工事が見つかりません'));

    var up = {};
    if (patch.name != null) {
      var nm = cleanJobName(patch.name);
      if (!nm) return Promise.reject(new Error('工事名を入れてください'));
      up.name = nm;
    }
    if (patch.no != null) up.no = cleanJobNo(patch.no);
    if (patch.start != null) up.start = cleanStart(patch.start);
    if (patch.active != null) up.active = !!patch.active;
    if (patch.category != null && patch.category !== j.category) {
      var c = CATEGORIES.labels[patch.category] ? patch.category : 3;
      up.category = c;
      up.order = nextJobOrder(c);
    }
    if (!Object.keys(up).length) return Promise.resolve();
    return yoteiDb.ref(JOBS_PATH + '/' + jobId).update(up);
  }

  /** 表に出す・出さないを切り替えます(データは消しません) */
  function setJobActive(jobId, on) {
    return updateJob(jobId, { active: !!on });
  }

  /**
   * その工事が、どの週の予定に出てくるかを調べます。
   *   weeks … その工事のノードがある週(空の殻も含む。消すときに使います)
   *   cells … 人が入っているマスの数(0なら予定はありません)
   * 全部の週を1回読みます。削除のときだけ呼ぶ想定です。
   */
  function jobUsage(jobId) {
    initFirebase();
    return readOnce(yoteiDb.ref('yotei/weeks')).then(function (snap) {
      var v = snap.val() || {};
      var weeks = [], cells = 0;
      Object.keys(v).forEach(function (wk) {
        var days = ((v[wk] || {}).assign || {})[jobId];
        if (!days) return;
        weeks.push(wk);
        Object.keys(days).forEach(function (d) {
          var c = days[d] || {};
          if (Object.keys(c.members || {}).length || (c.extras || []).length) cells++;
        });
      });
      return { weeks: weeks, cells: cells };
    });
  }

  /**
   * 工事を消します。すべての週の予定(assign/{id})も一緒に消えます。
   * 記録を残したいときは setJobActive(id, false) を使ってください。
   */
  function deleteJob(jobId) {
    initFirebase();
    if (!validKey(jobId)) return Promise.reject(new Error('この工事は消せません'));
    return jobUsage(jobId).then(function (u) {
      var patch = {};
      patch['jobs/' + jobId] = null;
      u.weeks.forEach(function (w) { patch['weeks/' + w + '/assign/' + jobId] = null; });
      return yoteiDb.ref('yotei').update(patch).then(function () { return u; });
    });
  }

  /**
   * 同じカテゴリの中で1つ上/下へ動かします。dir は -1 か +1。
   * 入れ替える相手と order を交換します。
   */
  function moveJob(jobId, dir) {
    initFirebase();
    var j = master.jobById[jobId];
    if (!j) return Promise.reject(new Error('その工事が見つかりません'));

    var sibs = master.jobs.filter(function (x) { return x.category === j.category; });
    var i = -1;
    sibs.forEach(function (x, n) { if (x.id === jobId) i = n; });
    var k = i + (dir < 0 ? -1 : 1);
    if (i < 0 || k < 0 || k >= sibs.length) return Promise.resolve(false);

    var other = sibs[k];
    // order が同じ値で並んでいることがあるので、番号を振り直してから入れ替えます
    var patch = {};
    sibs.forEach(function (x, n) { patch[x.id + '/order'] = n; });
    patch[j.id + '/order'] = k;
    patch[other.id + '/order'] = i;
    return yoteiDb.ref(JOBS_PATH).update(patch).then(function () { return true; });
  }

  /* ===================================================================
     ■ 週データ(読み書き)
     =================================================================== */

  /** Firebaseのキーに使えない文字が入っていないか */
  function validKey(s) {
    return typeof s === 'string' && s.length > 0 && !/[.#$\[\]\/]/.test(s);
  }

  function normalizeWeek(v) {
    v = v || {};
    return {
      assign: v.assign || {},
      plan: v.plan || {},           // 予定日の印 { 工事id: { 日付: true } }
      show: v.show || {},          // 今週だけ表に出す工事 { 工事id: true }
      updatedAt: v.updatedAt || 0,
      updatedBy: v.updatedBy || ''
    };
  }

  /** そのセルの中身 { members:{名前:{mark}}, extras:[文字列] } */
  function cellOf(week, jobKey, dateKey) {
    var a = (week && week.assign) || {};
    var c = (a[jobKey] || {})[dateKey] || {};
    return { members: c.members || {}, extras: c.extras || [] };
  }

  /** そのセルの人数(名簿の人 + 名簿にない人) */
  function cellCount(week, jobKey, dateKey) {
    var c = cellOf(week, jobKey, dateKey);
    return Object.keys(c.members).length + c.extras.length;
  }

  /**
   * 表示用の並び順を作ります。
   *   ・◎の職長を先頭へ
   *   ・職長どうし / 職長以外どうし の中では【選んだ順】のまま
   * 保存されている中身は並べ替えません。表示のときだけ使います。
   * 戻り値: [{ name, mark, ord, foreman, coop }]
   *
   * 選んだ順は members[名前].ord(数値)で持っています。
   * ord が無い古いデータは、いまの並びのまま後ろに続けます。
   */
  function displayMembers(members) {
    members = members || {};
    var names = Object.keys(members);
    var rows = names.map(function (name, i) {
      var m = members[name] || {};
      var mark = m.mark || '';
      return {
        name: name,
        mark: mark,
        ord: (typeof m.ord === 'number') ? m.ord : (100000 + i),
        foreman: isForemanMark(mark),   // そのマスだけの職長
        coop: isCoop(name)
      };
    });
    // ord で安定に並べたあと、職長だけを前に出します(グループ内の順はそのまま)
    rows.sort(function (a, b) { return a.ord - b.ord; });
    var lead = rows.filter(function (r) { return r.foreman; });
    var others = rows.filter(function (r) { return !r.foreman; });
    return lead.concat(others);
  }

  /** そのセルの表示用の並び(名簿にない人 extras は最後にそのままの順で足します) */
  function displayCell(week, jobKey, dateKey) {
    var c = cellOf(week, jobKey, dateKey);
    return {
      rows: displayMembers(c.members),
      extras: c.extras.slice(),
      count: Object.keys(c.members).length + c.extras.length
    };
  }

  /** 名前に付ける飾り。しるしは名前の直前に出します */
  function nameWithMarks(row) {
    return (row.mark || '') + row.name;
  }

  /**
   * セルの中身を「しるし + 名前」の並びにします。
   * 画面では mark に色を付けて出せるよう、分けたまま返します。
   * [{ mark, name, coop, foreman, extra }]
   */
  function cellItems(cell) {
    return cell.rows.map(function (r) {
      return { mark: r.mark || '', name: r.name, coop: r.coop, foreman: r.foreman, extra: false };
    }).concat(cell.extras.map(function (x) {
      return { mark: '', name: x, coop: false, foreman: false, extra: true };
    }));
  }

  /** 次に選んだ人へ渡す ord(いまの最大 + 1) */
  function nextOrd(members) {
    var max = -1;
    Object.keys(members || {}).forEach(function (n) {
      var o = (members[n] || {}).ord;
      if (typeof o === 'number' && o > max) max = o;
    });
    return max + 1;
  }

  /**
   * 表示中の週を購読します。編集がもう一方の画面へすぐ映ります。
   * 戻り値を呼ぶと購読をやめます。
   */
  function subscribeWeek(mondayKey, cb) {
    initFirebase();
    var ref = yoteiDb.ref('yotei/weeks/' + mondayKey);
    var handler = ref.on('value',
      function (snap) {
        var w = normalizeWeek(snap.val());
        weekCache[mondayKey] = w;      // 履歴の「変更前」を出すのに使います
        cb(w);
      },
      function (err) {
        console.warn('[common] 週の購読に失敗:', err);
        cb(normalizeWeek(null));
      });
    return function () { ref.off('value', handler); };
  }

  /** 週を1回だけ読みます(先週からのコピー元として使います) */
  function loadWeek(mondayKey) {
    initFirebase();
    return readOnce(yoteiDb.ref('yotei/weeks/' + mondayKey))
      .then(function (s) { return normalizeWeek(s.val()); })
      .catch(function (e) {
        console.warn('[common] 週を読めませんでした:', e);
        return normalizeWeek(null);
      });
  }

  /* --- 保存(セル単位の update。週まるごとの set はしません) ----------- */

  var pending = {};          // 'week|job|date' → セル
  var saveTimer = null;
  var saveWaiters = [];

  /**
   * セル1つを保存します。300ms まとめてから書きます。
   * cell = { members:{名前:{mark}}, extras:[文字列] } / 空にするときは null
   */
  function saveCell(mondayKey, jobKey, dateKey, cell, kind) {
    initFirebase();
    if (!validKey(jobKey) || !validKey(dateKey)) {
      return Promise.reject(new Error('保存できない工事キーまたは日付です'));
    }
    var pk = mondayKey + '|' + jobKey + '|' + dateKey;
    // 同じマスに続けて書いても、いちばん最初の「変更前」だけを控えます
    if (!pending[pk]) {
      pending[pk] = { before: cellNames(cellOf(weekCache[mondayKey], jobKey, dateKey)) };
    }
    pending[pk].week = mondayKey;
    pending[pk].job = jobKey;
    pending[pk].date = dateKey;
    pending[pk].cell = cleanCell(cell);
    pending[pk].kind = kind || 'メンバー変更';

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, SAVE_DEBOUNCE_MS);
    return new Promise(function (resolve, reject) {
      saveWaiters.push({ resolve: resolve, reject: reject });
    });
  }

  /** 保存する形に整えます。中身が空ならセルごと消します(null) */
  function cleanCell(cell) {
    if (!cell) return null;
    var members = {}, n = 0;
    Object.keys(cell.members || {}).forEach(function (name) {
      if (!validKey(name)) { console.warn('[common] この名前はキーに使えません:', name); return; }
      var src = cell.members[name] || {};
      var mark = cleanMark(src.mark);
      // ord = 選んだ順。表示の並べ替えに使います
      members[name] = { mark: mark, ord: (typeof src.ord === 'number') ? src.ord : n };
      n++;
    });
    var extras = (cell.extras || [])
      .map(function (s) { return String(s).trim().slice(0, 40); })
      .filter(function (s) { return s.length > 0; });

    if (n === 0 && extras.length === 0) return null;
    var out = { members: members };
    if (extras.length) out.extras = extras;
    return out;
  }

  /** ためていた保存をいますぐ書きます */
  function flushSaves() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    var keys = Object.keys(pending);
    var waiters = saveWaiters;
    saveWaiters = [];
    if (!keys.length) {
      waiters.forEach(function (w) { w.resolve(); });
      return Promise.resolve();
    }

    var byWeek = {}, logRows = [];
    keys.forEach(function (k) {
      var p = pending[k];
      delete pending[k];
      byWeek[p.week] = byWeek[p.week] || {};
      byWeek[p.week]['assign/' + p.job + '/' + p.date] = p.cell;   // null なら削除

      // 中身が変わったマスだけ、履歴に残します
      var after = cellNames(p.cell);
      if (after !== p.before) {
        logRows.push({
          week: p.week, kind: p.kind, job: p.job, jn: jobLabel(p.job).name,
          date: p.date, from: p.before, to: after
        });
      }
    });

    var writes = Object.keys(byWeek).map(function (week) {
      var patch = byWeek[week];
      patch.updatedAt = firebase.database.ServerValue.TIMESTAMP;
      patch.updatedBy = operatorName();
      return yoteiDb.ref('yotei/weeks/' + week).update(patch);
    });

    return Promise.all(writes).then(function () {
      logRows.forEach(function (r) { addLog(r.week, r); });
      waiters.forEach(function (w) { w.resolve(); });
    }).catch(function (e) {
      console.warn('[common] 保存に失敗:', e);
      waiters.forEach(function (w) { w.reject(e); });
      throw e;
    });
  }

  /**
   * 「今週出す工事」を書き替えます。
   * ids は { 工事id: true } の形。true のものだけ残し、ほかは消します。
   * 週ノードの中に置くので、事務所の2人で共有され、翌週には持ち越しません。
   */
  function setWeekShow(mondayKey, ids) {
    initFirebase();
    var out = {};
    Object.keys(ids || {}).forEach(function (id) {
      if (validKey(id) && ids[id]) out[id] = true;
    });
    return yoteiDb.ref('yotei/weeks/' + mondayKey).update({
      show: Object.keys(out).length ? out : null,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
      updatedBy: operatorName()
    });
  }

  /* ===================================================================
     ■ 請求済み(月ごと)
       yotei/billed/{YYYY-MM}/{工事id} = true
       工事は月をまたぐので、「工事ごと」ではなく「工事×月ごと」に持ちます。
       集計ページは月ごとの表なので、画面に出ているものとそのまま対応します。
     =================================================================== */

  function ymKey(y, m) { return y + '-' + (m < 10 ? '0' + m : m); }

  /** その月の請求済み { 工事id: true } を見張ります。止める関数を返します */
  function subscribeBilled(y, m, cb) {
    initFirebase();
    var ref = yoteiDb.ref(BILLED_PATH + '/' + ymKey(y, m));
    var h = ref.on('value',
      function (s) { cb(s.val() || {}); },
      function (e) { console.warn('[common] 請求済みを読めません:', e); cb({}); });
    return function () { ref.off('value', h); };
  }

  /** その月の1件を、請求済み(true)/未請求(false)に切り替えます */
  function setBilled(y, m, jobId, on) {
    initFirebase();
    if (!validKey(jobId)) return Promise.reject(new Error('工事idが正しくありません'));
    var o = {};
    o[jobId] = on ? true : null;          // false のときは消します
    return yoteiDb.ref(BILLED_PATH + '/' + ymKey(y, m)).update(o);
  }

  /**
   * 全期間で、工事ごとに人が入っているいちばん早い日 { 工事id: 'YYYY-MM-DD' }
   * 開始日が入っていない工事の代わりに使います。
   */
  function jobFirstDates(weeks) {
    var out = {};
    Object.keys(weeks || {}).forEach(function (wk) {
      var assign = (weeks[wk] || {}).assign || {};
      Object.keys(assign).forEach(function (jobId) {
        if (jobId === REST_KEY) return;          // 休みは工事ではありません
        var days = assign[jobId] || {};
        Object.keys(days).forEach(function (d) {
          var c = days[d] || {};
          if (!Object.keys(c.members || {}).length && !(c.extras || []).length) return;
          if (!out[jobId] || d < out[jobId]) out[jobId] = d;
        });
      });
    });
    return out;
  }

  /**
   * 全期間の、工事ごとの総人工 { 工事id: 人工 }
   * 同じ日が複数の週ノードに入っていても二重に数えないよう、日付でまとめます。
   */
  function jobTotalsAll(weeks) {
    var out = {}, seen = {};
    Object.keys(weeks || {}).forEach(function (wk) {
      var assign = (weeks[wk] || {}).assign || {};
      Object.keys(assign).forEach(function (jobId) {
        if (jobId === REST_KEY) return;          // 休みは人工ではありません
        var days = assign[jobId] || {};
        Object.keys(days).forEach(function (d) {
          var k = jobId + '|' + d;
          if (seen[k]) return;
          seen[k] = true;
          var c = days[d] || {};
          var n = Object.keys(c.members || {}).length + (c.extras || []).length;
          if (n) out[jobId] = (out[jobId] || 0) + n;
        });
      });
    });
    return out;
  }

  /* ===================================================================
     ■ 編集履歴(yotei/logs/{週}/{自動キー})
       だれが・いつ・どのマスを・どう変えたかを1件ずつ残します。
       名前は「文字列」で持ちます。あとで工事名やメンバー名が変わっても、
       そのときの記録がそのまま読めるようにするためです。
       1件およそ200バイト。1つの週につき最新100件だけ残します。
     =================================================================== */

  var weekCache = {};        // 見張っている週の中身(「変更前」を出すのに使います)
  var logCount = {};         // { 週: 件数 } この端末が数えているぶん

  /** セルの中身を「◎松高・野村」の形にします。空なら '(なし)' */
  function cellNames(cell) {
    if (!cell) return '(なし)';
    var ms = cell.members || {};
    var list = Object.keys(ms).sort(function (a, b) {
      return ((ms[a] || {}).ord || 0) - ((ms[b] || {}).ord || 0);
    }).map(function (n) { return ((ms[n] || {}).mark || '') + n; });
    (cell.extras || []).forEach(function (x) { list.push(x); });
    if (!list.length) return '(なし)';
    var t = list.join('・');
    return t.length > 300 ? t.slice(0, 299) + '…' : t;
  }

  /**
   * 履歴を1件残します。
   * 履歴が書けなくても予定の保存は止めません(あくまで控えなので)。
   */
  function addLog(week, row) {
    initFirebase();
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(week || ''))) return Promise.resolve();
    var e = {
      at: firebase.database.ServerValue.TIMESTAMP,
      by: operatorName(),
      kind: String(row.kind || 'メンバー変更').slice(0, 20)
    };
    var lim = { job: 40, jn: 60, date: 10, from: 300, to: 300, note: 120 };
    Object.keys(lim).forEach(function (k) {
      if (row[k]) e[k] = String(row[k]).slice(0, lim[k]);
    });
    var ref = yoteiDb.ref(LOGS_PATH + '/' + week);
    return ref.push(e)
      .then(function () { trimLogs(week); })
      .catch(function (err) { console.warn('[common] 履歴を残せませんでした:', err); });
  }

  /** 100件を超えたぶんの古い記録を消します。件数はこの端末で数えます */
  function trimLogs(week) {
    var ref = yoteiDb.ref(LOGS_PATH + '/' + week);
    var after = function (n) {
      logCount[week] = n;
      if (n <= LOG_KEEP) return;
      // 自動キーは古い順に並ぶので、頭から溢れたぶんを消します
      ref.orderByKey().limitToFirst(n - LOG_KEEP).once('value').then(function (s) {
        var del = {};
        s.forEach(function (c) { del[c.key] = null; });
        if (Object.keys(del).length) ref.update(del);
        logCount[week] = LOG_KEEP;
      }).catch(function () { /* 消せなくても動きは止めません */ });
    };
    if (typeof logCount[week] === 'number') { after(logCount[week] + 1); return; }
    // その週にはじめて書いたときだけ、1回数えます
    ref.once('value')
      .then(function (s) { after(s.numChildren()); })
      .catch(function () { /* 数えられなくても動きは止めません */ });
  }

  /** その週の履歴を新しい順で読みます */
  function loadLogs(week) {
    initFirebase();
    return readOnce(yoteiDb.ref(LOGS_PATH + '/' + week).orderByKey().limitToLast(LOG_KEEP))
      .then(function (s) {
        var out = [];
        s.forEach(function (c) { var v = c.val() || {}; v.id = c.key; v.week = week; out.push(v); });
        return out.reverse();          // 新しい順
      })
      .catch(function (e) {
        console.warn('[common] 履歴を読めませんでした:', e);
        return [];
      });
  }

  /* ===================================================================
     ■ 予定日の印(yotei/weeks/{週}/plan/{工事id}/{日付} = true)
       メンバーが決まる前に「この工事は何日と何日にやる」と分かるように、
       マスに色を付けるための印です。人の出入りとは別に持ちます。
     =================================================================== */

  /** その工事・その日に、予定日の印が付いているか */
  function hasPlan(week, jobId, dateKey) {
    return !!(((week && week.plan) || {})[jobId] || {})[dateKey];
  }

  /** その工事に印が付いている日の一覧(その週のぶん) */
  function planDays(week, jobId) {
    return Object.keys(((week && week.plan) || {})[jobId] || {}).sort();
  }

  /**
   * 予定日の印を書き替えます。days は { 日付: true } の形。
   * 渡した日だけ残し、ほかは消します(その工事のその週ぶん)。
   */
  function setPlanDays(mondayKey, jobId, days) {
    initFirebase();
    if (!validKey(jobId)) return Promise.reject(new Error('工事idが正しくありません'));
    var week = weekDates(mondayKey), out = {};
    week.forEach(function (d) { if ((days || {})[d]) out[d] = true; });
    var patch = {};
    patch['plan/' + jobId] = Object.keys(out).length ? out : null;
    patch.updatedAt = firebase.database.ServerValue.TIMESTAMP;
    patch.updatedBy = operatorName();
    return yoteiDb.ref('yotei/weeks/' + mondayKey).update(patch);
  }

  /** その工事・その日の印だけを消します(選択シートから使います) */
  function clearPlanDay(mondayKey, jobId, dateKey) {
    initFirebase();
    if (!validKey(jobId) || !validKey(dateKey)) {
      return Promise.reject(new Error('工事idか日付が正しくありません'));
    }
    var patch = {};
    patch['plan/' + jobId + '/' + dateKey] = null;
    patch.updatedAt = firebase.database.ServerValue.TIMESTAMP;
    patch.updatedBy = operatorName();
    return yoteiDb.ref('yotei/weeks/' + mondayKey).update(patch);
  }

  /** その週に人が入っている工事id { id: true } */
  function usedJobsInWeek(week) {
    var u = {};
    var a = (week && week.assign) || {};
    Object.keys(a).forEach(function (id) {
      var days = a[id] || {};
      var has = Object.keys(days).some(function (d) {
        var c = days[d] || {};
        return Object.keys(c.members || {}).length > 0 || (c.extras || []).length > 0;
      });
      if (has) u[id] = true;
    });
    return u;
  }

  /** 最後に開いた週をおぼえておきます(任意) */
  function rememberWeek(mondayKey) {
    initFirebase();
    return yoteiDb.ref('yotei/meta/lastWeek').set(mondayKey).catch(function () { });
  }

  /* ===================================================================
     ■ 状態の計算(余 / 重複 / 休み)
     =================================================================== */

  /**
   * その日1日ぶんの状態をまとめて出します。
   *   placements : { 名前: [jobKey,...] }  ※休みも1か所として数えます
   *   rest       : [名前]                  休みの人
   *   dup        : [{name, jobs:[jobKey]}] 2か所以上に入っている人
   *   free       : [名前]                  どこにも入っていない人(=余)
   *   placedCount / totalCount             配置ずみ / 全員(active)
   */
  function computeDay(week, dateKey) {
    var assign = (week && week.assign) || {};
    var placements = {};

    Object.keys(assign).forEach(function (jobKey) {
      var cell = (assign[jobKey] || {})[dateKey];
      if (!cell || !cell.members) return;
      Object.keys(cell.members).forEach(function (name) {
        (placements[name] = placements[name] || []).push(jobKey);
      });
    });

    var rest = Object.keys(placements).filter(function (n) {
      return placements[n].indexOf(REST_KEY) >= 0;
    });

    var dup = Object.keys(placements).filter(function (n) {
      return placements[n].length >= 2;
    }).map(function (n) {
      return { name: n, jobs: placements[n].slice() };
    });

    var actives = master.workers.filter(function (w) { return w.active; });

    var free = actives.filter(function (w) { return !placements[w.name]; })
      .map(function (w) { return w.name; });

    var placedCount = actives.filter(function (w) {
      var p = placements[w.name];
      return p && p.some(function (k) { return k !== REST_KEY; });
    }).length;

    return {
      date: dateKey,
      placements: placements,
      rest: rest,
      dup: dup,
      free: free,
      placedCount: placedCount,
      totalCount: actives.length
    };
  }

  /** 週7日ぶんまとめて。{ 'YYYY-MM-DD': computeDay(...) } */
  function computeWeek(week, mondayKey) {
    var out = {};
    weekDates(mondayKey).forEach(function (d) { out[d] = computeDay(week, d); });
    return out;
  }

  /* ===================================================================
     ■ LINEに貼る文
       編集用・確認用の両方から使います(同じ文になるように1か所で作ります)
     =================================================================== */

  var LINE_PER_ROW = 6;   // 1行に入れる人数の上限(名前の途中では折りません)

  /**
   * 名前を複数行に分けます。
   * LINEは画面幅で勝手に折り返すので、こちらで名前単位に区切っておきます。
   * まず 6人で割って行数を決め、そのうえで各行に均等に配ります
   * (最後の行だけ極端に少なくならないように)。
   *   4名 → 4    7名 → 4+3    12名 → 6+6    13名 → 5+4+4    26名 → 6+5+5+5+5
   */
  function chunkNames(names) {
    var n = names.length;
    if (!n) return [];
    var rows = Math.ceil(n / LINE_PER_ROW);
    var base = Math.floor(n / rows);
    var extra = n % rows;            // 先頭から extra 行だけ1人多く
    var out = [], i = 0;
    for (var r = 0; r < rows; r++) {
      var take = base + (r < extra ? 1 : 0);
      out.push(names.slice(i, i + take));
      i += take;
    }
    return out;
  }

  /**
   * その日ぶんのLINE用の文を、行の種類つきで作ります。
   *
   *   【6/29(月)　予定】
   *   ■L-6 定修                     ← 工事名だけの行(後ろに : は付けません)
   *   ◎松平・井谷・本山・稲垣
   *   五百木・△西岡星・津田          ← 名前単位で折り返します
   *   ■休み:なし
   *
   *   ※変更あれば返信ください
   *
   * 工事の並びは表と同じ(カテゴリ→order)。名前の並びも表と同じで、
   * ◎の人が先頭、そのあとは選んだ順です。
   */
  function lineLines(week, dateKey) {
    var d = parseKey(dateKey);
    var out = [{
      kind: 'head',
      text: '【' + (d.getMonth() + 1) + '/' + d.getDate() +
        '(' + DOW[dowIndex(dateKey)] + ')　予定】'
    }];

    var shown = 0;

    function pushJob(id) {
      var c = displayCell(week, id, dateKey);
      if (!c.count) return;                       // 人がいない工事は出しません
      if (isLineSkipped(jobLabel(id).name)) return;       // 配信に出さない工事

      // 工事と工事のあいだに空行を入れます(LINEで読みやすくするため)
      if (shown) out.push({ kind: 'blank', text: '' });
      shown++;
      out.push({ kind: 'job', text: '■' + jobLabel(id).name });
      // text はコピーされる中身。items は画面で色を付けるためのものです
      chunkNames(cellItems(c)).forEach(function (row) {
        out.push({
          kind: 'names',
          items: row,
          text: row.map(function (it) { return it.mark + it.name; }).join('・')
        });
      });
    }

    master.jobs.forEach(function (j) { pushJob(j.id); });

    // 表にない工事(消された工事)に人が残っていたら、それも出します
    var assign = (week && week.assign) || {};
    Object.keys(assign).forEach(function (id) {
      if (id === REST_KEY || master.jobById[id]) return;
      pushJob(id);
    });

    // 「休み」は配信に出しません(社内で見るものなので)

    out.push({ kind: 'blank', text: '' });
    out.push({ kind: 'foot', text: '※変更あれば返信ください' });
    return out;
  }

  /** LINEに貼る文(そのままコピーされる中身) */
  function lineText(week, dateKey) {
    return lineLines(week, dateKey).map(function (x) { return x.text; }).join('\n');
  }

  /** その人がその日どこへ行くか(休みを除く最初の1件)。選択シートの「→行き先」用 */
  function whereIs(day, name) {
    var p = day.placements[name];
    if (!p) return null;
    var k = p.filter(function (x) { return x !== REST_KEY; })[0];
    return k || REST_KEY;
  }

  /* ===================================================================
     ■ 集計(工事別 × 日ごとの人工)
       予定は週ごとに置いてあるので、その月にかかる週を全部読んで、
       日付で振り分けます(月をまたぐ週があるため)。
     =================================================================== */

  /** その月(y年m月。mは1〜12)の日付キー一覧 */
  function monthDates(y, m) {
    var out = [], d = new Date(y, m - 1, 1);
    while (d.getMonth() === m - 1) {
      out.push(toKey(d));
      d = addDays(d, 1);
    }
    return out;
  }

  /** その月にかかる週(月曜キー)の一覧。月をまたぐ週も入ります */
  function monthMondays(y, m) {
    var first = new Date(y, m - 1, 1);
    var last = new Date(y, m, 0);
    var cur = mondayOf(first), out = [];
    while (cur <= last) {
      out.push(toKey(cur));
      cur = addDays(cur, 7);
    }
    return out;
  }

  /** その月にかかる週をまとめて読みます。{ 月曜キー: 週データ } */
  function loadMonthWeeks(y, m) {
    initFirebase();
    var keys = monthMondays(y, m);
    return Promise.all(keys.map(function (k) {
      return readOnce(yoteiDb.ref('yotei/weeks/' + k))
        .then(function (s) { return normalizeWeek(s.val()); })
        .catch(function () { return normalizeWeek(null); });
    })).then(function (list) {
      var out = {};
      keys.forEach(function (k, i) { out[k] = list[i]; });
      return out;
    });
  }

  /**
   * 人工を数えます。しるし(◎△☆✕)にかかわらず1人=1。
   * 名簿にない人(extras)も1人として数えます。休みの行は数えません。
   *
   * 戻り値
   *   dates    : その月の日付キー
   *   byJob    : { 工事id: { 日付: 人数 } }
   *   jobTotal : { 工事id: 月の合計 }
   *   dayTotal : { 日付: その日の合計 }
   *   total    : 月の総人工
   *   jobIds   : 1人でも出た工事id(表の並び順)
   */
  function monthCounts(weeks, y, m) {
    var dates = monthDates(y, m);
    var inMonth = {};
    dates.forEach(function (d) { inMonth[d] = true; });

    var byJob = {}, jobTotal = {}, dayTotal = {}, total = 0;
    dates.forEach(function (d) { dayTotal[d] = 0; });

    Object.keys(weeks || {}).forEach(function (wk) {
      var assign = (weeks[wk] || {}).assign || {};
      Object.keys(assign).forEach(function (jobId) {
        if (jobId === REST_KEY) return;            // 休みは人工ではありません
        var days = assign[jobId] || {};
        Object.keys(days).forEach(function (d) {
          if (!inMonth[d]) return;                 // 月をまたぐ週の、はみ出した日は飛ばします
          var c = days[d] || {};
          var n = Object.keys(c.members || {}).length + (c.extras || []).length;
          if (!n) return;
          byJob[jobId] = byJob[jobId] || {};
          byJob[jobId][d] = (byJob[jobId][d] || 0) + n;
          jobTotal[jobId] = (jobTotal[jobId] || 0) + n;
          dayTotal[d] += n;
          total += n;
        });
      });
    });

    // 並びは工事一覧の順。一覧に無い工事(消された分)は後ろへ
    var order = {};
    master.jobs.forEach(function (j, i) { order[j.id] = i; });
    var jobIds = Object.keys(byJob).sort(function (a, b) {
      var oa = order[a] == null ? 99999 : order[a];
      var ob = order[b] == null ? 99999 : order[b];
      return oa - ob;
    });

    return {
      dates: dates, byJob: byJob, jobTotal: jobTotal,
      dayTotal: dayTotal, total: total, jobIds: jobIds
    };
  }

  /** 予定の週をぜんぶ読みます。工事の「全期間」を出すときだけ使います */
  function loadAllWeeks() {
    initFirebase();
    return readOnce(yoteiDb.ref('yotei/weeks')).then(function (s) {
      var v = s.val() || {}, out = {};
      Object.keys(v).forEach(function (k) { out[k] = normalizeWeek(v[k]); });
      return out;
    });
  }

  /**
   * 工事1件ぶんの内訳。
   *   dateFilter … { 日付: true } を渡すとその日だけ。省くと全期間
   *
   *   days   : [{ date, rows, extras, count }]  日ごとに誰が入ったか
   *   people : [{ name, coop, extra, days[], count }]  人ごとに何日入ったか
   *   total  : 総人工(しるしにかかわらず1人=1)
   *   first / last : いちばん早い日・遅い日(予定が無ければ null)
   * 人の並びは日数の多い順、同数なら名簿の順です。
   */
  function jobDetail(weeks, jobId, dateFilter) {
    // 同じ日が複数の週ノードに入っていても数え落とさないよう、日付でまとめます
    var perDate = {};
    Object.keys(weeks || {}).forEach(function (wk) {
      var days0 = (((weeks[wk] || {}).assign) || {})[jobId] || {};
      Object.keys(days0).forEach(function (d) {
        if (dateFilter && !dateFilter[d]) return;
        var c = days0[d] || {};
        var t = perDate[d] = perDate[d] || { members: {}, extras: [] };
        Object.keys(c.members || {}).forEach(function (n) { t.members[n] = c.members[n]; });
        (c.extras || []).forEach(function (x) { if (t.extras.indexOf(x) < 0) t.extras.push(x); });
      });
    });

    var days = [], byPerson = {}, total = 0;
    Object.keys(perDate).sort().forEach(function (d) {
      var t = perDate[d];
      var rows = displayMembers(t.members);
      var count = rows.length + t.extras.length;
      if (!count) return;

      days.push({ date: d, rows: rows, extras: t.extras, count: count });
      total += count;

      rows.forEach(function (r) {
        if (!byPerson[r.name]) byPerson[r.name] = { name: r.name, coop: r.coop, extra: false, days: [] };
        byPerson[r.name].days.push(d);
      });
      t.extras.forEach(function (x) {
        if (!byPerson[x]) byPerson[x] = { name: x, coop: false, extra: true, days: [] };
        byPerson[x].days.push(d);
      });
    });

    var order = {};
    master.workers.forEach(function (w, i) { order[w.name] = i; });
    var people = Object.keys(byPerson).map(function (n) {
      byPerson[n].count = byPerson[n].days.length;
      return byPerson[n];
    }).sort(function (a, b) {
      if (a.count !== b.count) return b.count - a.count;
      var oa = order[a.name] == null ? 99999 : order[a.name];
      var ob = order[b.name] == null ? 99999 : order[b.name];
      return oa - ob;
    });

    return {
      days: days, people: people, total: total,
      first: days.length ? days[0].date : null,
      last: days.length ? days[days.length - 1].date : null
    };
  }

  /** 工事1件ぶんの、その月の内訳 */
  function jobMonthDetail(weeks, jobId, y, m) {
    var f = {};
    monthDates(y, m).forEach(function (d) { f[d] = true; });
    return jobDetail(weeks, jobId, f);
  }

  /** 土日かどうか(集計表で薄い帯にします) */
  function isWeekend(dateKey) {
    var i = dowIndex(dateKey);
    return i === 5 || i === 6;
  }

  /* ===================================================================
     ■ 接続状態(オフラインのとき編集を止めるため)
     =================================================================== */

  function onConnection(cb) {
    initFirebase();
    var ref = yoteiDb.ref('.info/connected');
    var h = ref.on('value', function (s) {
      cb(s.val() === true && navigator.onLine !== false);
    });
    window.addEventListener('online', function () { cb(true); });
    window.addEventListener('offline', function () { cb(false); });
    return function () { ref.off('value', h); };
  }

  /* ===================================================================
     ■ アプリアイコン(深緑の角丸 + 生成りの「予」)
     =================================================================== */

  /**
   * ホーム画面のアイコン。
   *   invert なし … 深緑の地に生成りの「予」(編集用)
   *   invert あり … 生成りの地に深緑の「予」(確認用)
   * 2つのアプリを並べたとき、見分けられるようにしています。
   */
  function iconDataUri(size, invert) {
    var s = size || 180;
    var bg = invert ? '#f5f1e8' : '#1c4b34';
    var fg = invert ? '#1c4b34' : '#f5f1e8';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '" viewBox="0 0 180 180">' +
      '<rect width="180" height="180" rx="40" fill="' + bg + '"/>' +
      (invert ? '<rect x="4" y="4" width="172" height="172" rx="37" fill="none" stroke="#1c4b34" stroke-width="8"/>' : '') +
      '<text x="90" y="126" font-family="Noto Sans JP,Hiragino Sans,Meiryo,sans-serif" font-size="112" font-weight="900" ' +
      'fill="' + fg + '" text-anchor="middle">予</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ===================================================================
     ■ 外に出すもの
     =================================================================== */

  global.YY = {
    // 設定
    CATEGORIES: CATEGORIES,
    FOREMAN_MARK: FOREMAN_MARK,
    KUBUN: KUBUN,
    MEMBERS_PATH: MEMBERS_PATH,
    MEMBER_NAME_MAX: MEMBER_NAME_MAX,
    JOBS_PATH: JOBS_PATH,
    JOB_NAME_MAX: JOB_NAME_MAX,
    JOB_NO_MAX: JOB_NO_MAX,
    REST_KEY: REST_KEY,
    MARKS: MARKS,
    MARK_MAX: MARK_MAX,
    cleanMark: cleanMark,
    cellItems: cellItems,
    DOW: DOW,

    // 選択シートとLINEの、対象にする/しない工事
    ALL_TAB_ORDER: ALL_TAB_ORDER,
    FACTORY_JOBS: FACTORY_JOBS,

    // 予定日の印
    hasPlan: hasPlan, planDays: planDays,
    setPlanDays: setPlanDays, clearPlanDay: clearPlanDay,
    LINE_SKIP_PREFIXES: LINE_SKIP_PREFIXES, isLineSkipped: isLineSkipped,

    // 保存するときの名前
    getOperator: getOperator, setOperator: setOperator, operatorName: operatorName,
    OPERATOR_MAX: OPERATOR_MAX,

    // 請求済み(月ごと)
    subscribeBilled: subscribeBilled, setBilled: setBilled,
    ymKey: ymKey, jobTotalsAll: jobTotalsAll, jobFirstDates: jobFirstDates,

    // 編集履歴
    addLog: addLog, loadLogs: loadLogs, cellNames: cellNames, LOG_KEEP: LOG_KEEP,

    // 接続
    init: initFirebase,
    onConnection: onConnection,

    // 日付
    toKey: toKey, parseKey: parseKey, addDays: addDays,
    mondayOf: mondayOf, addWeeks: addWeeks, thisMonday: thisMonday,
    todayKey: todayKey, weekDates: weekDates, weekLabel: weekLabel,
    dayLabel: dayLabel, dowIndex: dowIndex, isToday: isToday,
    weekMonth: weekMonth, monthTopMonday: monthTopMonday, moveMonth: moveMonth,

    // 名簿
    master: master,
    subscribeMembers: subscribeMembers,
    loadMembers: loadMembers,
    addMember: addMember,
    addMembersBulk: addMembersBulk,
    updateMember: updateMember,
    setMemberActive: setMemberActive,
    moveMember: moveMember,
    memberUsage: memberUsage,
    deleteMember: deleteMember,
    isCoop: isCoop, isForemanMark: isForemanMark, isKnown: isKnown,
    jobsByCat: jobsByCat, selectableWorkers: selectableWorkers, jobLabel: jobLabel,

    // 工事(このアプリで登録・編集します)
    subscribeJobs: subscribeJobs,
    loadJobs: loadJobs,
    addJob: addJob,
    updateJob: updateJob,
    setJobActive: setJobActive,
    jobUsage: jobUsage,
    deleteJob: deleteJob,
    moveJob: moveJob,
    nextJobOrder: nextJobOrder,
    cleanStart: cleanStart,
    jobStartedBy: jobStartedBy,
    jobStartedByWeek: jobStartedByWeek,
    JOB_KEEP_WEEKS: JOB_KEEP_WEEKS,
    lastUsedDate: lastUsedDate,
    jobStartsInWeek: jobStartsInWeek,
    jobVisible: jobVisible,

    // 週データ
    subscribeWeek: subscribeWeek,
    loadWeek: loadWeek,
    saveCell: saveCell,
    flushSaves: flushSaves,
    cellOf: cellOf,
    cellCount: cellCount,
    displayMembers: displayMembers,
    displayCell: displayCell,
    nameWithMarks: nameWithMarks,
    nextOrd: nextOrd,
    rememberWeek: rememberWeek,
    setWeekShow: setWeekShow,
    usedJobsInWeek: usedJobsInWeek,

    // 状態
    computeDay: computeDay,
    computeWeek: computeWeek,
    whereIs: whereIs,

    // LINEに貼る文
    lineText: lineText,
    lineLines: lineLines,

    // 集計(工事別 × 日ごとの人工)
    monthDates: monthDates,
    monthMondays: monthMondays,
    loadMonthWeeks: loadMonthWeeks,
    monthCounts: monthCounts,
    loadAllWeeks: loadAllWeeks,
    jobDetail: jobDetail,
    jobMonthDetail: jobMonthDetail,
    isWeekend: isWeekend,

    // その他
    iconDataUri: iconDataUri
  };

})(window);

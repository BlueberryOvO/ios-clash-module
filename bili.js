/**
 * bili-fix.js —— B站精简（修复版脚本）
 * ------------------------------------------------------------------
 * 运行环境：Clash-Client / Clash (ProjectClash) 1.0.19+ 的模块脚本引擎
 *          （Surge 兼容 http-response 脚本：$request / $response / $done / console.log）
 * 语言约束：纯 ES5.1。不用 let/const、箭头函数、模板字符串、可选链、async。
 *          goja / JSC / QuickJS 哪个运行时都能跑。
 *
 * 铁律：任何异常都不回写 body。解析失败、结构变了、字段没了 —— 一律 $done({})
 *      让内核原样放行，App 永远拿不到半截 JSON。这是"不炸 App"的唯一保证。
 *
 * 覆盖接口（全部在 app.bilibili.com）：
 *   /x/resource/show/tab/v2    首页 tab 全量配置
 *   /x/resource/patch/tab/v2   首页 tab 增量补丁（原模块漏了这个，所以会被改回去）
 *   /x/v2/splash/show          开屏广告（原模块完全没处理）
 *   /x/v2/splash/list          开屏广告预加载
 *   /x/v2/account/mine         我的页入口
 * ------------------------------------------------------------------
 */

var CFG = {
    // 顶部滑动分区只保留这三项（对应原脚本 keepTabNames）。
    // 命中数 < 2 时自动放弃白名单，退回黑名单，防止 B 站改名后把顶栏清空。
    KEEP_TAB: ['直播', '推荐', '热门'],
    // tab_id 兜底（91901100 实测：直播tab / 推荐tab / hottopic）
    KEEP_TAB_IDS: ['直播tab', '推荐tab', 'hottopic'],
    // 顶部/底部 tab 要删掉的条目（按 name / tab_id / title 子串匹配）
    DROP_TOP: ['会员购', '关注', '课堂', '漫画', '公益', '放映厅', '发布', '社区', '付费', '游戏中心', '活动'],
    // 底部导航栏只删这两个，别动「首页/动态/我的」，否则 App 可能闪退
    DROP_BOTTOM: ['会员购', '关注'],
    // 「我的」页要删掉的入口
    DROP_MINE: ['会员购', '我的课程', '游戏中心', '创作中心', '课堂', '漫画', '会员中心', '我的钱包', '客服'],
    // 推荐流广告卡类型（原脚本只认 ad/banner/mall 前缀，漏了 B 站真在用的 cm_v2）
    AD_CARD_TYPES: ['cm_v2', 'cm', 'ad', 'ads', 'advert', 'banner_v1', 'banner_v2', 'live_ad', 'pgc_card', 'mall'],
    AD_GOTO: ['ad', 'cm', 'mall', 'banner', 'activity'],
    // 递归深度上限，防止畸形 JSON 把运行时拖死
    MAX_DEPTH: 6,
    // 排查问题时改 true，客户端日志里能看到 [bili-fix] 输出
    DEBUG: true
};

function say(msg) {
    try {
        if (CFG.DEBUG && typeof console !== 'undefined' && console.log) {
            console.log('[bili-fix] ' + msg);
        }
    } catch (e) { /* 日志失败不影响业务 */ }
}

function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
}

/* 取出一个条目的可读标识：name / title / tab_id / sub_title 拼起来 */
function labelOf(el) {
    if (!el || typeof el !== 'object') return '';
    var parts = [];
    var keys = ['name', 'title', 'tab_id', 'sub_title', 'desc'];
    for (var i = 0; i < keys.length; i++) {
        var v = el[keys[i]];
        if (typeof v === 'string' && v) parts.push(v);
    }
    return parts.join(' ');
}

function hitAny(label, list) {
    if (!label) return false;
    for (var i = 0; i < list.length; i++) {
        if (label.indexOf(list[i]) !== -1) return true;
    }
    return false;
}

/* 按 key 名判断该用哪张黑名单：bottom 用 DROP_BOTTOM，其余用当前接口的清单 */
function dropListFor(key, fallback) {
    if (!key) return fallback;
    var k = String(key).toLowerCase();
    if (k === 'bottom' || k === 'bottombar' || k === 'bottom_tab') return CFG.DROP_BOTTOM;
    return fallback;
}

/* 顶部滑动分区用白名单：只留 KEEP_TAB */
function keepListFor(key) {
    if (!key) return null;
    var k = String(key).toLowerCase();
    if (k === 'tab' || k === 'tab_v2' || k === 'top_tab') return CFG.KEEP_TAB;
    return null;
}

/* 精确比对白名单（name / title / tab_id 全等），不用子串，避免"直播中心"误判成"直播" */
function keepHit(el) {
    if (!el || typeof el !== 'object') return false;
    var names = [el.name, el.title];
    var i, j;
    for (i = 0; i < names.length; i++) {
        if (typeof names[i] !== 'string') continue;
        for (j = 0; j < CFG.KEEP_TAB.length; j++) {
            if (names[i] === CFG.KEEP_TAB[j]) return true;
        }
    }
    // tab_id 兜底：91901100 实测 直播tab / 推荐tab / hottopic
    if (typeof el.tab_id === 'string') {
        for (j = 0; j < CFG.KEEP_TAB_IDS.length; j++) {
            if (el.tab_id === CFG.KEEP_TAB_IDS[j]) return true;
        }
    }
    return false;
}

/**
 * 白名单过滤：命中 >= 2 项才动手（B 站一旦改名导致 0 命中，就整体放弃，
 * 绝不清空顶栏）。返回是否发生改动。
 */
function applyKeep(arr, stats) {
    var matched = 0, i;
    for (i = 0; i < arr.length; i++) {
        if (keepHit(arr[i])) matched++;
    }
    if (matched < 2) {
        say('tab 白名单只命中 ' + matched + ' 项，放弃过滤（保留原样）');
        return false;
    }

    var kept = [];
    for (i = 0; i < arr.length; i++) {
        if (keepHit(arr[i])) {
            kept.push(arr[i]);
        } else {
            stats.dropped.push('tab=' + (labelOf(arr[i]) || '?'));
        }
    }
    arr.length = 0;
    for (i = 0; i < kept.length; i++) arr.push(kept[i]);
    return true;
}

/**
 * 递归过滤：只处理数组里的对象条目，命中黑名单就整条删除。
 * stats.dropped 记录删了什么，便于在日志里核对。
 */
function prune(node, key, depth, list, stats) {
    if (!node || typeof node !== 'object' || depth > CFG.MAX_DEPTH) return;

    if (isArray(node)) {
        if (keepListFor(key)) applyKeep(node, stats);   // 顶栏先走白名单

        var kept = [];
        for (var i = 0; i < node.length; i++) {
            var el = node[i];
            var label = labelOf(el);
            if (label && hitAny(label, dropListFor(key, list))) {
                stats.dropped.push(String(key) + '=' + label);
                continue;
            }
            kept.push(el);
            prune(el, key, depth + 1, list, stats);
        }
        if (kept.length !== node.length) {
            node.length = 0;
            for (var j = 0; j < kept.length; j++) node.push(kept[j]);
        }
        return;
    }

    for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        prune(node[k], k, depth + 1, list, stats);
    }
}

/* ---------- 推荐流广告卡 ---------- */

function inSet(v, arr) {
    if (typeof v !== 'string') return false;
    var s = v.toLowerCase();
    for (var i = 0; i < arr.length; i++) {
        if (s === String(arr[i]).toLowerCase()) return true;
    }
    return false;
}

/**
 * 广告卡判定（按 91901100 实测 + 官方字段表）：
 *   card_goto 以 ad 开头   -> ad_web_s / ad_av / ad_web_gif / ad_player / ad_inline_3d / ad_inline_av …
 *   card_type cm_v2/cm_double_v9/cm -> 商业推广卡
 *   card_type banner_v8 等          -> 横幅卡（内层 banner_item 里 ad/static_banner.is_ad_loc 都是推广）
 *   small_cover_v10 + game          -> 游戏推广
 *   带 ad_info 对象                  -> 推广
 */
function isAdItem(el) {
    if (!el || typeof el !== 'object' || isArray(el)) return false;

    var ct = typeof el.card_type === 'string' ? el.card_type.toLowerCase() : '';
    var cg = typeof el.card_goto === 'string' ? el.card_goto.toLowerCase() : '';
    var gt = typeof el.goto === 'string' ? el.goto.toLowerCase() : '';

    if (el.ad_info && typeof el.ad_info === 'object') return true;
    if (cg.indexOf('ad') === 0) return true;
    if (ct === 'cm_v2' || ct === 'cm' || ct === 'cm_double_v9') return true;
    if (ct === 'banner_v8' || ct === 'banner_v1' || ct === 'banner_v2') return true;
    if (ct === 'small_cover_v10' && cg === 'game') return true;
    if (ct === 'live_ad' || ct === 'pgc_card' || ct === 'mall') return true;
    if (gt === 'ad' || gt === 'cm' || gt === 'mall') return true;
    return false;
}

function prunePredicate(node, key, depth, pred, stats) {
    if (!node || typeof node !== 'object' || depth > CFG.MAX_DEPTH) return;

    if (isArray(node)) {
        var kept = [];
        for (var i = 0; i < node.length; i++) {
            var el = node[i];
            if (pred(el, key)) {
                stats.dropped.push('ad=' + (el.card_type || el.card_goto || el.goto || '?'));
                continue;
            }
            kept.push(el);
            prunePredicate(el, key, depth + 1, pred, stats);
        }
        if (kept.length !== node.length) {
            node.length = 0;
            for (var j = 0; j < kept.length; j++) node.push(kept[j]);
        }
        return;
    }

    for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        prunePredicate(node[k], k, depth + 1, pred, stats);
    }
}

/* 首页推荐流（REST 版接口；9.19.1 走的是 gRPC，这条一般不会命中） */
function handleFeed(body) {
    var obj = null;
    try { obj = JSON.parse(body); } catch (e) { return null; }
    var target = (obj && obj.data && typeof obj.data === 'object') ? obj.data : obj;
    if (!target) return null;

    var stats = { dropped: [] };
    prunePredicate(target, 'data', 0, isAdItem, stats);
    if (!stats.dropped.length) return null;

    say('feed ads dropped: ' + stats.dropped.join(' | '));
    return JSON.stringify(obj);
}

/**
 * 分段收尾（只动 tab 配置这 4 个数组，绝不碰其它结构）：
 *   1. pos 按 1..n 重排，否则 iOS 按 pos 摆位会出现空洞
 *   2. data.tab 里的 default_selected 必须恰好一个 —— 被删掉的那项若本来是默认选中，
 *      不补一个就会出现"启动停在无效 tab"
 */
var SEGMENT_KEYS = { tab: 1, top: 1, top_more: 1, bottom: 1 };

function fixSegments(data) {
    if (!data || typeof data !== 'object') return;
    var key, i;
    for (key in SEGMENT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(SEGMENT_KEYS, key)) continue;
        var arr = data[key];
        if (!isArray(arr)) continue;
        for (i = 0; i < arr.length; i++) {
            if (arr[i] && typeof arr[i] === 'object' && typeof arr[i].pos === 'number') {
                arr[i].pos = i + 1;
            }
        }
    }

    var tabs = data.tab;
    if (!isArray(tabs) || !tabs.length) return;
    var hasDefault = false;
    for (i = 0; i < tabs.length; i++) {
        var it = tabs[i];
        if (!it || typeof it !== 'object') continue;
        if (it.default_selected === 1) {
            if (hasDefault) it.default_selected = 0;
            else hasDefault = true;
        }
    }
    if (!hasDefault && tabs[0] && typeof tabs[0] === 'object') {
        tabs[0].default_selected = 1;
    }
}

function handleSplash(url, body) {
    var obj = null;
    try { obj = JSON.parse(body); } catch (e) { return null; }

    var d = obj && obj.data;
    if (!d || typeof d !== 'object') return null;

    // 91901100 实测：/splash/show 的 data.show 是数组（无广告时就是 []），不是 bool
    var hasAd = false;
    if (isArray(d.show)) {
        if (d.show.length > 0) hasAd = true;
    } else if (d.show === true) {
        hasAd = true;
    }
    if (isArray(d.list) && d.list.length > 0) hasAd = true;
    if (isArray(d.splash) && d.splash.length > 0) hasAd = true;
    if (!hasAd) return null;              // 本来就没广告，不动它

    // 直接复刻"服务端说没广告"时的那份形状，兼容性最好
    var nd = { show: [] };
    if (typeof d.splash_request_id === 'string' && d.splash_request_id) {
        nd.splash_request_id = d.splash_request_id;
    }
    if (typeof d.max_time === 'number') nd.max_time = 0;
    if (typeof d.min_interval === 'number') nd.min_interval = 0;
    if (typeof d.pull_interval === 'number') nd.pull_interval = 0;
    if (typeof d.list !== 'undefined') nd.list = [];
    if (typeof d.splash !== 'undefined') nd.splash = [];

    obj.data = nd;
    say('splash cleared: ' + url);
    return JSON.stringify(obj);
}

/* 日志用：去掉域名和 query，只留路径 */
function shortPath(u) {
    return String(u || '').replace(/^https?:\/\/[^\/]+/, '').split('?')[0];
}

/* 日志用：列出对象前 n 个键，用来看数据结构有没有变 */
function keyList(o, n) {
    if (!o || typeof o !== 'object') return '-';
    var out = [];
    for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        out.push(k);
        if (out.length >= (n || 8)) break;
    }
    return out.join(',') || '-';
}

function handleJson(url, body, list) {
    var obj = null;
    try { obj = JSON.parse(body); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;

    var target = (obj.data && typeof obj.data === 'object') ? obj.data : obj;
    say('hit ' + shortPath(url) + ' | keys: ' + keyList(target));

    var stats = { dropped: [] };
    prune(target, 'data', 0, list, stats);

    if (!stats.dropped.length) return null;   // 没有命中就不回写，日志里显示 unchanged

    fixSegments(target);
    say('dropped: ' + stats.dropped.join(' | '));
    return JSON.stringify(obj);
}

(function main() {
    var url = (typeof $request !== 'undefined' && $request && $request.url) ? $request.url : '';
    var body = (typeof $response !== 'undefined' && $response && $response.body) ? $response.body : '';
    var out = null;

    try {
        if (body) {
            if (/\/x\/v2\/splash\/(show|list)/.test(url)) {
                out = handleSplash(url, body);
            } else if (/\/x\/resource\/(show|patch)\/tab(\/v2)?/.test(url)) {
                out = handleJson(url, body, CFG.DROP_TOP);
            } else if (/\/x\/v2\/account\/mine/.test(url)) {
                out = handleJson(url, body, CFG.DROP_MINE);
            } else if (/\/x\/v2\/feed\/index/.test(url)) {
                out = handleFeed(body);
            }
        }
    } catch (e) {
        say('exception swallowed: ' + e);
        out = null;                            // 异常 → 原样放行
    }

    if (out) {
        $done({ body: out });
    } else {
        $done({});
    }
})();

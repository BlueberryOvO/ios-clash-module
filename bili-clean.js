/**
 * bili-clean.js  v5
 * 功能:
 *   1. 底部栏: 删「会员购」「关注」(只留 首页 / 我的)
 *   2. 顶部区: 只保留「直播 / 推荐 / 热门」, 其余分区全删
 *   3. 「我的」页: 只留 历史 / 收藏 / 稍后再看 / 关注 / 设置, 删掉钱包、游戏、课程、任务等
 *   4. 推荐流: 删广告卡、会员购卡、轮播 banner
 *   5. 开屏广告置空 / 搜索热词清空
 *
 * 兼容: Surge/Shadowrocket 模块、Loon 插件、Stash 覆写
 */

(function () {
  'use strict';

  var CFG = {
    DEBUG: false,                        // 想看命中日志改成 true(会发系统通知)

    // 底部/顶部要删的入口(名字精确匹配, 或跳转链接兜底)
    dropTabNames: ['会员购', '关注'],
    dropTabUris: ['bilibili://mall', 'bilibili://following'],

    // 顶部区白名单: 只保留这几项, 其余删除
    // 想只留两项就删掉 '热门'; 想全删就设成 []
    keepTabNames: ['直播', '推荐', '热门'],

    // 「我的」页要清掉的入口(精确匹配 + 必须带 bilibili:// 链接, 不会误伤稿件标题)
    mineDropWords: [
      '会员购', '会员中心', '大会员', '我的钱包', '钱包', 'B币', '充值',
      '游戏中心', '我的游戏', '课堂', '课程', '我的课程', '免费课程',
      '充电', '任务中心', '领福利', '商城', '电商', '直播中心',
      '创作者中心', '创作中心', '客服中心'
    ],
    // 「我的」页要清掉的卡片类型(横幅/推广位)
    mineDropCards: /^(ad|ads|banner|mall|game|activity|promo)/i,

    removeFeedAds: true,
    removeBanner: true,
    killSplash: true,
    cleanSearch: true,
    cleanMine: true
  };

  var AD_CARD_TYPE = /^(ad|ads|advert|advertisement|banner|mall|activity|pgc_card|live_ad)/i;

  var url = (typeof $request !== 'undefined' && $request && $request.url) || '';
  var body = (typeof $response !== 'undefined' && $response && $response.body) || '';

  function notify(sub, text) {
    if (!CFG.DEBUG) return;
    try {
      if (typeof $notification !== 'undefined' && $notification) $notification.post('BiliClean', sub, text);
    } catch (e) {}
  }

  function hitName(o) {
    if (!o || typeof o !== 'object') return false;
    if (typeof o.name === 'string' && CFG.dropTabNames.indexOf(o.name) >= 0) return true;
    if (typeof o.title === 'string' && CFG.dropTabNames.indexOf(o.title) >= 0) return true;
    return false;
  }

  function hitUri(o) {
    if (!o || typeof o !== 'object') return false;
    var u = '';
    if (typeof o.uri === 'string') u = o.uri;
    else if (typeof o.url === 'string') u = o.url;
    else if (typeof o.tab_url === 'string') u = o.tab_url;
    else return false;
    for (var i = 0; i < CFG.dropTabUris.length; i++) {
      if (u.indexOf(CFG.dropTabUris[i]) === 0) return true;
    }
    return false;
  }

  function isDropTab(o) { return hitName(o) || hitUri(o); }

  function isKeepTab(o) {
    if (!o || typeof o !== 'object') return false;
    if (typeof o.name === 'string' && CFG.keepTabNames.indexOf(o.name) >= 0) return true;
    if (typeof o.title === 'string' && CFG.keepTabNames.indexOf(o.title) >= 0) return true;
    return false;
  }

  function isAdCard(o) {
    if (!o || typeof o !== 'object') return false;
    if (o.goto === 'mall') return true;
    if (!CFG.removeFeedAds) return false;
    var t = o.card_type || o.card_goto || o.goto || '';
    if (typeof t !== 'string') return false;
    if (AD_CARD_TYPE.test(t)) return true;
    if (CFG.removeBanner && /^banner/i.test(t)) return true;
    return false;
  }

  // 「我的」页杂项: 必须带 bilibili:// 链接或属于推广卡片, 避免误伤稿件标题
  function mineJunk(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;

    var uri = (typeof o.uri === 'string' && o.uri) ||
              (typeof o.url === 'string' && o.url) || '';
    var isJump = uri.indexOf('bilibili://') === 0;

    if (isJump) {
      var names = [o.title, o.name, o.tab_name, o.sub_title, o.main_title, o.card_title];
      for (var i = 0; i < names.length; i++) {
        if (typeof names[i] === 'string' && CFG.mineDropWords.indexOf(names[i]) >= 0) return true;
      }
    }

    if (typeof o.card_type === 'string' && CFG.mineDropCards.test(o.card_type)) return true;
    return false;
  }

  function filterDeep(node, predicate) {
    if (Array.isArray(node)) {
      var out = [];
      for (var i = 0; i < node.length; i++) {
        if (predicate(node[i])) continue;
        out.push(filterDeep(node[i], predicate));
      }
      return out;
    }
    if (node && typeof node === 'object') {
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var v = node[k];
        // 值本身就是要删的对象(比如 banner: {...}) -> 连键一起删
        if (v && typeof v === 'object' && !Array.isArray(v) && predicate(v)) { delete node[k]; continue; }
        node[k] = filterDeep(v, predicate);
      }
      return node;
    }
    return node;
  }

  function done(obj) { $done({ body: JSON.stringify(obj) }); }

  if (!/^https?:\/\/(app|api)\.bilibili\.com\//.test(url)) { $done({}); return; }

  try {
    // 1) 开屏
    if (/splash\/(list|event\/list)/.test(url) && CFG.killSplash) {
      done({ code: 0, message: '0', ttl: 1,
             data: { max_time: 0, min_interval: 31536000, pull_interval: 31536000,
                     keep_ids: [], show: [], list: [], splash_request_id: '' } });
      return;
    }

    if (!body) { $done({}); return; }

    var raw = String(body);
    var hadTarget = raw.indexOf('会员购') >= 0 || raw.indexOf('关注') >= 0;
    var json = JSON.parse(raw);

    // 2) 搜索热词
    if (/search\/square/.test(url) && CFG.cleanSearch && json.data && json.data.trending) {
      if (Array.isArray(json.data.trending.list)) json.data.trending.list = [];
      if (json.data.trending.tracking_id) json.data.trending.tracking_id = '';
      notify('搜索热词已清空', url);
      done(json);
      return;
    }

    // 3) 推荐流
    if (/feed\/index/.test(url)) {
      json = filterDeep(json, isAdCard);
      notify('推荐流已过滤', url);
      done(json);
      return;
    }

    // 4) tab 配置
    if (/\/resource\/show\/tab/.test(url) ||
        (json.data && (Array.isArray(json.data.bottom) || Array.isArray(json.data.tab)))) {
      var log = [];

      if (json.data) {
        // 4a) 底部/顶部: 删指定入口
        ['bottom', 'top'].forEach(function (k) {
          if (Array.isArray(json.data[k])) {
            var n = json.data[k].length;
            json.data[k] = json.data[k].filter(function (it) { return !isDropTab(it); });
            if (json.data[k].length !== n) log.push(k + ' -' + (n - json.data[k].length));
          }
        });

        // 4b) 顶部区: 白名单, 只留 keepTabNames
        if (Array.isArray(json.data.tab) && CFG.keepTabNames.length) {
          var kept = json.data.tab.filter(isKeepTab);
          // 一项都没匹配上就不动, 避免版本改名后把顶部清空
          if (kept.length > 0) {
            log.push('tab 只留 ' + kept.length + ' 项');
            json.data.tab = kept;
          } else {
            log.push('tab 白名单未命中, 保持原样');
          }
        }
      }

      notify('tab 配置', log.join(' / ') || url);
      if (log.length) { done(json); return; }
    }

    // 5) 「我的」页等接口: 清掉钱包/游戏/课程/任务/推广卡
    if (CFG.cleanMine) {
      var lenBefore = raw.length;
      json = filterDeep(json, mineJunk);
      if (JSON.stringify(json).length !== lenBefore) {
        notify('「我的」页已精简', url);
        done(json);
        return;
      }
    }

    // 6) 兜底: 任何带 uri/tab_url 的目标项都删(接口改名也不怕)
    if (hadTarget) {
      json = filterDeep(json, function (o) {
        return o && typeof o === 'object' &&
          (typeof o.uri === 'string' || typeof o.tab_url === 'string') && isDropTab(o);
      });
      notify('兜底过滤', url);
      done(json);
      return;
    }

    $done({});
  } catch (e) {
    notify('脚本异常', String((e && e.message) || e));
    $done({});
  }
})();

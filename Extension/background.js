// FrictionLayer — background service worker.
//
// 1) Fallback injection for the floating focus overlay (unchanged behaviour).
// 2) Session-scoped customization: the website's customization (goal / strictness / filter
//    toggles) is applied ONLY while a focus session is running or paused. The extension's own
//    settings are backed up when the session starts and restored when the timer ends, the
//    session is ended, or it is dismissed. Nothing from the website is saved permanently into the
//    extension's own Search / Feed filter settings.

const OVERLAY_FILE = 'content/focus-overlay.js';
const WEB_URL = /^https?:\/\//i;

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !WEB_URL.test(details.url)) return;
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    files: [OVERLAY_FILE],
    world: 'ISOLATED'
  }).catch(() => {
    // Chrome internal pages, Web Store and other restricted pages reject injection; unsupported by design.
  });
});

// ---------------------------------------------------------------------------------------------
// Session-scoped customization
// ---------------------------------------------------------------------------------------------
const SESSION_KEY = 'flFocusOverlaySession_v1';        // written by content/focus-overlay.js
const SEARCH_KEY  = 'frictionLayerSearchSettings';
const FEED_KEY    = 'frictionLayerFeedSettings';
const PROFILE_KEY = 'frictionLayerWebsitePreferences'; // website customization (stored, NOT applied on its own)
const BACKUP_KEY  = 'flSessionSettingsBackup_v1';      // extension's own settings while a session overrides them
const END_ALARM   = 'flFocusSessionEnd';

// Same defaults the content scripts use when a key is missing.
const SEARCH_DEFAULTS = { enabled: true, hideBelowCutoff: false, cutoff: 35 };
const FEED_DEFAULTS   = { enabled: false, blockedCategories: [] };

const WEBSITE_GOAL_CATEGORIES = {
  'Study & Learning': ['Study'],
  'Research & Projects': ['Study', 'Technology', 'News'],
  'Skill Development': ['Study', 'Technology'],
  'General Focused Browsing': ['Study', 'Technology']
};
const CUTOFFS = { Relaxed: 30, Balanced: 60, Strict: 90 };
const TAB_URLS = [
  'https://www.google.com/*', 'https://www.google.co.in/*', 'https://www.google.co.uk/*',
  'https://www.google.ca/*', 'https://www.google.com.au/*', 'https://www.bing.com/*',
  'https://duckduckgo.com/*', 'https://search.brave.com/*', 'https://search.yahoo.com/*',
  'https://www.ecosia.org/*', 'https://www.youtube.com/*'
];

const get = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
const set = (obj) => new Promise((resolve) => chrome.storage.local.set(obj, resolve));
const remove = (keys) => new Promise((resolve) => chrome.storage.local.remove(keys, resolve));

// A session customizes the browser while it is running, or paused (timer not finished yet).
function isActive(s, now = Date.now()) {
  if (!s) return false;
  if (s.status === 'paused') return true;
  return s.status === 'running' && Number(s.endAt) > now;
}

function deriveOverrides(prefs) {
  const p = prefs || {};
  const categories = WEBSITE_GOAL_CATEGORIES[p.goal] ?? ['Study'];
  return {
    search: { enabled: p.intentFilter !== false, hideBelowCutoff: true, cutoff: CUTOFFS[p.strictness] ?? 35 },
    feed:   { enabled: p.recommendationFilter !== false, blockedCategories: categories }
  };
}

function notifyTabs(search, feed) {
  chrome.tabs.query({ url: TAB_URLS }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'FL_SEARCH_SETTINGS_UPDATED', settings: { ...SEARCH_DEFAULTS, ...(search || {}) } }, () => void chrome.runtime.lastError);
      if (tab.url?.includes('youtube.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'FL_FEED_SETTINGS_UPDATED', settings: { ...FEED_DEFAULTS, ...(feed || {}) } }, () => void chrome.runtime.lastError);
      }
    }
  });
}

// All changes run one after another so two events can never interleave a backup/restore.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch(() => {}));

async function applySession(session) {
  const data = await get([BACKUP_KEY, PROFILE_KEY]);
  const prefs = session.preferences || data[PROFILE_KEY];
  const applied = deriveOverrides(prefs);
  let backup = data[BACKUP_KEY];
  if (!backup) {
    // First moment of the session: remember the extension's own settings exactly as they are.
    const current = await get([SEARCH_KEY, FEED_KEY]);
    backup = {
      hadSearch: SEARCH_KEY in current, search: current[SEARCH_KEY],
      hadFeed: FEED_KEY in current, feed: current[FEED_KEY]
    };
  }
  backup.applied = applied;
  await set({ [BACKUP_KEY]: backup, [SEARCH_KEY]: applied.search, [FEED_KEY]: applied.feed });
  notifyTabs(applied.search, applied.feed);
  if (session.status === 'running') chrome.alarms.create(END_ALARM, { when: Number(session.endAt) + 250 });
  else chrome.alarms.clear(END_ALARM);
}

async function restoreOwnSettings() {
  chrome.alarms.clear(END_ALARM);
  const { [BACKUP_KEY]: backup } = await get(BACKUP_KEY);
  if (!backup) return;
  if (backup.hadSearch) await set({ [SEARCH_KEY]: backup.search }); else await remove(SEARCH_KEY);
  if (backup.hadFeed) await set({ [FEED_KEY]: backup.feed }); else await remove(FEED_KEY);
  await remove(BACKUP_KEY);
  notifyTabs(backup.hadSearch ? backup.search : null, backup.hadFeed ? backup.feed : null);
}

async function reconcile() {
  const { [SESSION_KEY]: session } = await get(SESSION_KEY);
  if (isActive(session)) await applySession(session);
  else await restoreOwnSettings();
}

// Session started / paused / resumed / completed / ended (overlay writes or removes the key).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SESSION_KEY]) enqueue(reconcile);
  // The user edited the extension popup while a session is active: keep the session customization
  // in force, but remember their edit as the settings to restore afterwards.
  if (changes[SEARCH_KEY] || changes[FEED_KEY]) {
    enqueue(async () => {
      const { [BACKUP_KEY]: backup } = await get(BACKUP_KEY);
      if (!backup?.applied) return;
      let edited = false;
      if (changes[SEARCH_KEY] && JSON.stringify(changes[SEARCH_KEY].newValue) !== JSON.stringify(backup.applied.search)) {
        backup.hadSearch = changes[SEARCH_KEY].newValue !== undefined; backup.search = changes[SEARCH_KEY].newValue; edited = true;
      }
      if (changes[FEED_KEY] && JSON.stringify(changes[FEED_KEY].newValue) !== JSON.stringify(backup.applied.feed)) {
        backup.hadFeed = changes[FEED_KEY].newValue !== undefined; backup.feed = changes[FEED_KEY].newValue; edited = true;
      }
      if (!edited) return;
      await set({ [BACKUP_KEY]: backup, [SEARCH_KEY]: backup.applied.search, [FEED_KEY]: backup.applied.feed });
      notifyTabs(backup.applied.search, backup.applied.feed);
    });
  }
});

// Timer ran out while no FrictionLayer tab was open to mark it complete, or the browser restarted.
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === END_ALARM) enqueue(reconcile); });
chrome.runtime.onStartup.addListener(() => enqueue(reconcile));
chrome.runtime.onInstalled.addListener(() => enqueue(reconcile));
enqueue(reconcile); // also whenever the service worker wakes up

// ---------------------------------------------------------------------------------------------
// Website → extension. The website only hands over its customization profile; it no longer
// changes the extension's filter settings. The profile is used by sessions (see applySession).
// ---------------------------------------------------------------------------------------------
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Accept messages only from the local development website.
  const senderHost = sender.url ? new URL(sender.url).hostname : '';
  if (!['localhost', '127.0.0.1'].includes(senderHost)) {
    sendResponse({ ok: false, error: 'Unapproved website origin' });
    return;
  }
  if (message?.type !== 'FL_SYNC_PREFERENCES' || !message.preferences) {
    sendResponse({ ok: false, error: 'Invalid message' });
    return;
  }
  chrome.storage.local.set({ [PROFILE_KEY]: message.preferences }, () => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ ok: true, appliesDuring: 'focus-session' });
  });
  return true;
});

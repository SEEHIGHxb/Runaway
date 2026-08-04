// ============================================================================
//  Runaway — App orchestrator
//  Startup, auth flow, tab navigation, the profile page, run logging/import,
//  and the PWA share-target. Feature logic lives in the sibling modules:
//  leaderboard.js, friends.js, clubs.js, theme.js, cropper.js — all sharing
//  util.js helpers and the cross-module state in state.js.
// ============================================================================

import {
  isConfigured,
  loginWithGoogle,
  logout,
  onAuthChange,
  getCurrentUser,
  fetchRuns,
  addRun,
  subscribeToRuns,
  subscribeToFriends,
  subscribeToClubs,
  fetchProfile,
  createProfile,
  updateProfile,
  uploadAvatar,
} from './db.js?v=4';
import { parseActivityFile } from './parse.js';
import { state } from './state.js';
import { $, todayISO, formatDisplayName } from './util.js';
import { initThemeSwitch } from './theme.js';
import { initAvatarCropper } from './cropper.js';
import { initNotifications, resyncNotifyHandle, teardownPushOnLogout } from './notifications.js';
import { initShare, openShareRun, openShareLeaderboard } from './share.js';
import {
  initLbiBridge,
  refreshLbiBridge,
  resyncLbiHandle,
  clearLbiBridge,
} from './lbi-bridge.js';
import {
  initLeaderboard,
  resetLeaderboardFilters,
  renderLeaderboard,
  renderRuns,
} from './leaderboard.js';
import {
  initFriends,
  loadFriends,
  setPendingFriendAction,
  handlePendingFriendAction,
} from './friends.js';
import {
  initClubs,
  loadClubs,
  hasActiveClub,
  setPendingClubAction,
  handlePendingClubAction,
} from './clubs.js';


// ---- App-level state ---------------------------------------------------------
let unsubscribe = null;         // runs realtime teardown
let unsubscribeFriends = null;  // friends realtime teardown
let unsubscribeClubs = null;    // clubs realtime teardown
let activeTab = 'runs';         // runs | friends | clubs | profile
let pendingSharedFile = null;   // watch activity files from Android share sheet
let sharedHandled = false;
let authResolved = false;       // has Supabase emitted its first auth event yet?
let pendingAvatarBlob = null;   // cropped avatar awaiting profile save

// ---------------------------------------------------------------------------
//  Startup
// ---------------------------------------------------------------------------
init();

function init() {
  registerServiceWorker();

  // Initialize Draggable Theme Switch
  initThemeSwitch();

  // Initialize Push Notifications Switch
  initNotifications();

  // Consume any watch activity shared from Android PWA targets
  consumeSharedFile().then((f) => {
    pendingSharedFile = f;
    maybeImportShared();
  });

  // If Supabase isn't configured, halt and show setup instructions
  if (!isConfigured) {
    showSetupNotice();
    return;
  }

  // 1. Check URL query parameters for links first
  checkUrlParams();

  // 2. Auth state change listener
  onAuthChange(async (event, session) => {
    authResolved = true;
    if (session) {
      try {
        state.me = await fetchProfile(session.user.id);
      } catch (err) {
        console.warn('Profile not found, attempting auto-creation:', err.message);
        try {
          const userMeta = session.user.user_metadata || {};
          state.me = await createProfile({
            id: session.user.id,
            display_name: userMeta.full_name || userMeta.name || 'Runner',
            avatar_url: userMeta.avatar_url || userMeta.picture || '',
          });
        } catch (insertErr) {
          console.error('Failed to create fallback profile:', insertErr.message);
          alert('Could not set up user profile: ' + insertErr.message);
          return;
        }
      }
      enterApp();
    } else {
      exitApp();
    }
  });

  // Safety net: if Supabase never emits an auth event (network stalls, etc.),
  // stop showing the boot loader after a few seconds and fall back to the gate
  // instead of leaving the user staring at a spinner forever.
  setTimeout(() => {
    if (!authResolved) {
      hideBoot();
      exitApp();
    }
  }, 6000);

  // 3. Bind standard UI event listeners
  $('#btn-login-google').addEventListener('click', loginWithGoogle);
  $('#btn-logout').addEventListener('click', onLogoutClick);
  $('#run-form').addEventListener('submit', onAddRun);
  $('#f-file').addEventListener('change', onFilePicked);
  $('#f-date').value = todayISO();

  // Floating Action Button (FAB) triggers for logging runs
  $('#btn-open-log').addEventListener('click', () => {
    $('#run-log-modal').hidden = false;
    $('#run-msg').textContent = '';
  });
  $('#btn-close-log').addEventListener('click', () => {
    $('#run-log-modal').hidden = true;
  });

  // Tabs navigation
  document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Profile navigation triggers
  $('.user-profile').addEventListener('click', () => switchTab('profile'));

  // Profile page actions — the cropper owns the avatar file input; the cropped
  // blob waits here until the profile form is saved.
  initAvatarCropper((blob) => {
    pendingAvatarBlob = blob;
    $('#profile-edit-avatar').src = URL.createObjectURL(blob);
  });
  $('#profile-form').addEventListener('submit', onProfileSubmit);

  // Feature modules (deps injected to keep the import graph acyclic)
  initShare();
  // Binds the Profile-tab export switch. Safe before auth: with no session it
  // writes nothing, and the payload is refreshed on every successful runs fetch.
  initLbiBridge();
  initLeaderboard({
    switchTab,
    reloadRuns: loadRuns,
    onShareRun: openShareRun,
    onShareLeaderboard: openShareLeaderboard,
  });
  initFriends();
  initClubs({
    switchTab,
    reloadRuns: loadRuns,
    onShareRun: openShareRun,
    onShareLeaderboard: openShareLeaderboard,
  });
}

// ---------------------------------------------------------------------------
//  URL Query Parameters (Friend & club invite links)
// ---------------------------------------------------------------------------
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const friendCode = params.get('f');          // new short link: ?f=AB12CD
  const addFriend = params.get('add-friend');   // legacy link: ?add-friend=<uuid>
  const clubCode = params.get('c');            // club invite link: ?c=XY12AB

  if (friendCode) {
    setPendingFriendAction({ type: 'friend', code: friendCode });
  } else if (addFriend) {
    setPendingFriendAction({ type: 'friend', id: addFriend });
  }

  if (clubCode) {
    setPendingClubAction({ type: 'club', code: clubCode });
  }

  // Clear query parameters from address bar to keep things tidy
  if (friendCode || addFriend || clubCode) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ---------------------------------------------------------------------------
//  Auth Flow Controls
// ---------------------------------------------------------------------------
async function enterApp() {
  resetLeaderboardFilters();
  hideBoot();
  $('#gate').style.display = 'none';
  $('#app').hidden = false;
  // Set up profile displays
  $('#who-name').textContent = formatDisplayName(state.me.display_name);
  if (state.me.avatar_url) {
    const avatar = $('#who-avatar');
    avatar.src = state.me.avatar_url;
    avatar.hidden = false;
  }

  // Display user's own shareable friend link. Prefer the short friend code
  // (?f=AB12CD); fall back to the full UUID only if the code is somehow missing
  // (e.g. a profile created before the friend_code column existed).
  const shareId = state.me.friend_code || state.me.id;
  const link = window.location.origin + window.location.pathname + '?f=' + shareId;
  $('#my-friend-link').value = link;
  $('#my-uid').textContent = state.me.friend_code || state.me.id;

  maybeImportShared();

  // Load all initial segments
  await Promise.all([
    loadRuns(),
    loadFriends(),
    loadClubs(),
  ]);

  // Handle URL requests if they exist (each is a no-op without one pending)
  handlePendingFriendAction();
  handlePendingClubAction();

  // Subscribe to realtime changes. Runs drive the live feed; friend changes
  // refresh the requests list, the tab badge, and the pool (a new friend's runs
  // become visible).
  unsubscribe = subscribeToRuns(
    async () => { await loadRuns(); if (hasActiveClub()) await loadClubs(); },
    (status) => setLive(status === 'SUBSCRIBED'),
  );
  unsubscribeFriends = subscribeToFriends(async () => {
    await Promise.all([loadFriends(), loadRuns()]);
  });
  unsubscribeClubs = subscribeToClubs(async () => {
    await loadClubs();
  });
}

function exitApp() {
  hideBoot();
  $('#app').hidden = true;
  $('#gate').style.display = '';
  $('#gate-error').hidden = true;
  state.me = null;
  // Signing out revokes the export. Anything else would leave one account's
  // running readable to whoever signs in next on this browser.
  clearLbiBridge();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeFriends) {
    unsubscribeFriends();
    unsubscribeFriends = null;
  }
  if (unsubscribeClubs) {
    unsubscribeClubs();
    unsubscribeClubs = null;
  }
}

async function onLogoutClick() {
  if (confirm('Are you sure you want to sign out?')) {
    // Remove this device's push subscription FIRST, while the session is still
    // valid (the DB delete is RLS-scoped to the signed-in user). Otherwise the
    // logged-out device keeps receiving this account's club notifications — and
    // a different account signing in on the same browser would collide with it.
    await teardownPushOnLogout();
    await logout();
  }
}

// ---------------------------------------------------------------------------
//  Tab Switching Navigation
// ---------------------------------------------------------------------------
function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.app-nav .nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${tabId}`;
  });

  // Manage visibility of the Floating log button (only visible on Runs tab)
  $('#btn-open-log').hidden = tabId !== 'runs';

  if (tabId === 'friends') {
    loadFriends();
  } else if (tabId === 'runs') {
    loadRuns();
  } else if (tabId === 'clubs') {
    loadClubs();
  } else if (tabId === 'profile') {
    loadProfileTab();
  }
}

// ---------------------------------------------------------------------------
//  Profile tab
// ---------------------------------------------------------------------------
async function loadProfileTab() {
  if (!state.me) return;
  // A crop picked but not saved shouldn't linger into a fresh visit.
  pendingAvatarBlob = null;
  $('#f-display-name').value = state.me.display_name || '';

  const editAvatar = $('#profile-edit-avatar');
  editAvatar.src = state.me.avatar_url || 'https://authjs.dev/img/providers/google.svg';

  // The notification toggle's slider was positioned at startup while this panel
  // was hidden (offsetWidth 0), so snap it to the right spot now that it's shown.
  resyncNotifyHandle();
  // Same hidden-panel measurement problem for the LBI switch, and it re-reads
  // the week: the ledger may not change all session, but the ISO week it is
  // measured over rolls over at midnight on Sunday.
  resyncLbiHandle();

  try {
    const user = await getCurrentUser();
    if (user) {
      $('#info-email').textContent = user.email || 'N/A';
      $('#info-uid').textContent = user.id || 'N/A';

      const createdDate = new Date(user.created_at);
      $('#info-joined').textContent = createdDate.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }) || 'N/A';
    }
  } catch (err) {
    console.error('Error fetching account details:', err);
  }
}

async function onProfileSubmit(e) {
  e.preventDefault();
  const msg = $('#profile-msg');
  const nameField = $('#f-display-name');
  const submitBtn = $('#profile-form button[type="submit"]');

  const displayName = nameField.value.trim();
  if (!displayName) {
    msg.textContent = 'Display name is required.';
    return;
  }

  submitBtn.disabled = true;
  msg.textContent = 'Saving changes...';
  msg.style.color = 'var(--muted)';

  try {
    let avatarUrl = state.me.avatar_url;

    if (pendingAvatarBlob) {
      msg.textContent = 'Uploading avatar image...';
      avatarUrl = await uploadAvatar(pendingAvatarBlob, state.me.id);
    }

    msg.textContent = 'Updating profile details...';
    state.me = await updateProfile({
      display_name: displayName,
      avatar_url: avatarUrl
    });
    pendingAvatarBlob = null;

    // Update header displays
    $('#who-name').textContent = formatDisplayName(state.me.display_name);
    if (state.me.avatar_url) {
      const avatar = $('#who-avatar');
      avatar.src = state.me.avatar_url;
      avatar.hidden = false;
    }

    msg.textContent = 'Profile saved successfully!';
    msg.style.color = '#22c55e'; // Green

    // Refresh leaderboards/runs lists in case the name changed
    loadRuns();

    setTimeout(() => { msg.textContent = ''; }, 3000);
  } catch (err) {
    console.error('Error saving profile:', err);
    msg.textContent = 'Failed to save: ' + err.message;
    msg.style.color = 'var(--danger)';
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
//  Runs · loading and logging
// ---------------------------------------------------------------------------
async function loadRuns() {
  try {
    state.runs = await fetchRuns();
    setLive(true);
    renderLeaderboard();
    renderRuns();
    // Only on the success path: the catch below leaves state.runs untouched, so
    // publishing there would export the PREVIOUS fetch's runs — or an empty
    // array on the first failed load, which reads as "ran nothing this week".
    refreshLbiBridge();
  } catch (err) {
    setLive(false);
    const connNote = $('#conn-note');
    if (connNote) connNote.textContent = 'Could not fetch runs: ' + err.message;
  }
}

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await importFile(file);
  e.target.value = '';
}

async function importFile(file) {
  const msg = $('#import-msg');
  msg.textContent = `Reading ${file.name}…`;
  try {
    let { distanceKm, durationMin, dateISO } = await parseActivityFile(file);
    let capped = false;
    if (distanceKm >= 100) {
      distanceKm = 99.99;
      capped = true;
    }
    if (distanceKm > 0) $('#f-distance').value = distanceKm;
    if (durationMin != null) $('#f-duration').value = durationMin;
    if (dateISO) $('#f-date').value = dateISO;

    const bits = [];
    if (distanceKm > 0) bits.push(`${distanceKm} km`);
    if (durationMin != null) bits.push(`${durationMin} min`);

    let info = bits.join(' · ');
    if (capped) info += ' (capped at 99.99 km)';
    msg.textContent = bits.length
      ? `Imported ${info} · review and press Add run.`
      : 'File read, but no distance found. Enter it manually.';
  } catch (err) {
    msg.textContent = err.message;
  }
}

async function onAddRun(e) {
  e.preventDefault();
  const msg = $('#run-msg');
  const distance = Number($('#f-distance').value);
  const date = $('#f-date').value;
  const durationRaw = $('#f-duration').value.trim();
  const notes = $('#f-notes').value.trim();

  if (!(distance > 0 && distance < 100)) { msg.textContent = 'Enter a distance between 0.01 and 99.99 km.'; return; }
  if (!date) { msg.textContent = 'Pick a date.'; return; }
  if (durationRaw && !(Number(durationRaw) > 0)) {
    msg.textContent = 'Duration must be greater than 0, or leave it blank.';
    return;
  }

  const run = {
    distance_km: distance,
    run_date: date,
    duration_min: durationRaw ? Number(durationRaw) : null,
    notes: notes || null,
  };

  const btn = $('#run-form button[type="submit"]');
  btn.disabled = true;
  msg.textContent = 'Saving…';
  try {
    await addRun(run);
    await loadRuns();
    e.target.reset();
    $('#f-date').value = todayISO();

    // Close the floating modal log dialog
    $('#run-log-modal').hidden = true;
    alert('Added!');
  } catch (err) {
    msg.textContent = 'Save failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
//  App chrome helpers
// ---------------------------------------------------------------------------
function showSetupNotice() {
  hideBoot();
  $('#gate').innerHTML = `
    <div class="gate-card">
      <div class="gate-emoji">🛠️</div>
      <h1>Almost there</h1>
      <p class="gate-sub">Add your Supabase URL and anon key in <code>config.js</code>,
      then run the SQL in <code>schema.sql</code>. See <code>README.md</code> for the setup.</p>
    </div>`;
}

function hideBoot() {
  const boot = $('#boot');
  if (boot) boot.hidden = true;
}

function setLive(on) {
  const dot = $('#live-dot');
  if (dot) {
    dot.classList.toggle('on', on);
    dot.classList.toggle('off', !on);
  }
  const note = $('#conn-note');
  if (note) note.textContent = on ? 'Connected · updates live' : 'Offline · retrying…';
}

// ---------------------------------------------------------------------------
//  PWA · Web Share Target
// ---------------------------------------------------------------------------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

async function consumeSharedFile() {
  const params = new URLSearchParams(location.search);
  if (!params.has('share-target')) return null;
  history.replaceState({}, '', location.pathname);
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open('runclub-shared');
    const res = await cache.match('shared-activity');
    if (!res) return null;
    const name = res.headers.get('x-filename') || 'activity';
    const blob = await res.blob();
    await cache.delete('shared-activity');
    return new File([blob], name);
  } catch (_) {
    return null;
  }
}

function maybeImportShared() {
  if (sharedHandled || !pendingSharedFile) return;
  if ($('#app').hidden) return;
  sharedHandled = true;
  const file = pendingSharedFile;
  pendingSharedFile = null;
  importFile(file);
  // Show the log modal since we have a shared file to import!
  $('#run-log-modal').hidden = false;
}

/* Social Hub Studio — SocialBee-style Queue Manager & GitHub Sync UI */
const GH_STORE_KEY = 'martin_social_hub_gh_v1';

let state = {
  posts: [],
  config: {
    enabled_platforms: { LinkedIn: true, Facebook: true, Instagram: true, X: false },
    max_posts_per_run: 2,
    min_hours_per_platform: 36,
    shuffle: true,
    random_jitter_max_minutes: 35,
    media_base_url: '',
  },
  postLog: [],
  tab: 'scheduled',
  platformFilter: 'All',
  search: '',
  dirty: false,
  editingId: null,
  gh: loadGhSettings(),
};

function loadGhSettings() {
  const saved = JSON.parse(localStorage.getItem(GH_STORE_KEY) || '{}');
  // Auto-detect owner/repo when served from GitHub Pages (https://<owner>.github.io/<repo>/)
  let autoOwner = saved.owner || '';
  let autoRepo = saved.repo || '';
  if (!autoOwner && location.hostname.endsWith('.github.io')) {
    autoOwner = location.hostname.replace('.github.io', '');
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg) autoRepo = seg;
  }
  return {
    owner: autoOwner,
    repo: autoRepo || 'social-hub',
    branch: saved.branch || 'main',
    token: saved.token || '',
  };
}

function saveGhSettings(gh) {
  state.gh = gh;
  localStorage.setItem(GH_STORE_KEY, JSON.stringify(gh));
  updateSyncUI();
}

function toast(msg, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function markDirty() {
  state.dirty = true;
  updateSyncUI();
}

function updateSyncUI() {
  const btn = document.getElementById('btn-sync');
  const badge = document.getElementById('gh-status-text');
  const banner = document.getElementById('setup-banner');
  const hasGh = Boolean(state.gh.owner && state.gh.repo && state.gh.token);

  if (hasGh) {
    badge.textContent = `GitHub: ${state.gh.owner}/${state.gh.repo}`;
    banner.style.display = 'none';
  } else {
    badge.textContent = 'Read-only mode (connect GitHub token to save)';
    banner.style.display = 'flex';
  }

  if (state.dirty) {
    btn.classList.add('btn-sync-dirty');
    btn.textContent = hasGh ? '💾 Save & Sync to GitHub *' : '⬇ Save / Export Changes *';
  } else {
    btn.classList.remove('btn-sync-dirty');
    btn.textContent = hasGh ? '💾 Synced with GitHub' : '💾 Save & Sync';
  }
}

// ---------------- GitHub REST API Helpers ---------------- //

async function ghFetch(path, options = {}) {
  const { owner, repo, token } = state.gh;
  if (!owner || !repo || !token) throw new Error('Connect your GitHub repo & Personal Access Token in Settings first.');
  const url = `https://api.github.com/repos/${owner}/${repo}/${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${txt.slice(0, 220)}`);
  }
  return resp.status === 204 ? null : resp.json();
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghPutFile(repoPath, contentBase64, commitMsg) {
  let sha = undefined;
  try {
    const cur = await ghFetch(`contents/${repoPath}?ref=${encodeURIComponent(state.gh.branch)}`);
    sha = cur.sha;
  } catch (_) {}
  return ghFetch(`contents/${repoPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: commitMsg,
      content: contentBase64,
      branch: state.gh.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function loadData() {
  const hasGh = Boolean(state.gh.owner && state.gh.repo && state.gh.token);
  try {
    if (hasGh) {
      // Load directly from GitHub API to bypass GitHub Pages CDN caching
      const [qRes, cRes, lRes] = await Promise.all([
        ghFetch(`contents/data/queue.json?ref=${encodeURIComponent(state.gh.branch)}`),
        ghFetch(`contents/data/config.json?ref=${encodeURIComponent(state.gh.branch)}`),
        ghFetch(`contents/data/post_log.json?ref=${encodeURIComponent(state.gh.branch)}`).catch(() => null),
      ]);
      state.posts = JSON.parse(base64ToUtf8(qRes.content)).posts || [];
      state.config = JSON.parse(base64ToUtf8(cRes.content));
      state.postLog = lRes ? JSON.parse(base64ToUtf8(lRes.content)) : [];
    } else {
      const bust = `?t=${Date.now()}`;
      const [qRes, cRes, lRes] = await Promise.all([
        fetch(`data/queue.json${bust}`, { cache: 'no-store' }),
        fetch(`data/config.json${bust}`, { cache: 'no-store' }),
        fetch(`data/post_log.json${bust}`, { cache: 'no-store' }).catch(() => null),
      ]);
      if (!qRes.ok) throw new Error('Could not load data/queue.json');
      state.posts = (await qRes.json()).posts || [];
      if (cRes.ok) state.config = await cRes.json();
      if (lRes && lRes.ok) state.postLog = await lRes.json();
    }
    state.dirty = false;
    updateSyncUI();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById('cards-area').innerHTML = `
      <div class="empty-state">
        <h3>Could not load <code>data/queue.json</code></h3>
        <p>${escapeHtml(err.message)}</p>
        <p>If you opened <code>index.html</code> directly from Windows Explorer (<code>file://</code>), browsers block local JSON fetches. Open it on your <strong>GitHub Pages URL</strong>, or run <code>python -m http.server 8000</code> inside <code>social-hub</code> and visit <code>http://localhost:8000</code>.</p>
      </div>`;
  }
}

async function syncToGitHub() {
  if (!state.gh.token || !state.gh.owner || !state.gh.repo) {
    openSettingsModal();
    toast('Add your GitHub token in Settings to save directly to GitHub (or use Export JSON).', 4500);
    return;
  }
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = '⏳ Syncing...';
  try {
    const qJson = JSON.stringify({ version: 1, posts: state.posts }, null, 2);
    const cJson = JSON.stringify(state.config, null, 2);
    await ghPutFile('data/queue.json', utf8ToBase64(qJson), 'chore: update social queue via Social Hub Studio [skip ci]');
    await ghPutFile('data/config.json', utf8ToBase64(cJson), 'chore: update schedule config via Social Hub Studio [skip ci]');
    state.dirty = false;
    toast('✓ Saved & synced to GitHub!');
  } catch (e) {
    alert('Sync failed:\n' + e.message);
  } finally {
    btn.disabled = false;
    updateSyncUI();
  }
}

async function triggerWorkflowRun(platform, maxPosts, ignorePacing, dryRun) {
  if (state.dirty) {
    const ok = confirm('You have unsaved changes. Save & Sync to GitHub first before running?');
    if (ok) await syncToGitHub();
  }
  await ghFetch('actions/workflows/autopost.yml/dispatches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: state.gh.branch,
      inputs: {
        platform: platform || 'all',
        max_posts: String(maxPosts || 1),
        ignore_pacing: ignorePacing ? 'true' : 'false',
        dry_run: dryRun ? 'true' : 'false',
      },
    }),
  });
}

// ---------------- Rendering ---------------- //

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isManualCard(p) {
  if ((p.automation_mode || 'API_AUTO').toUpperCase() === 'MANUAL_ASSIST') return true;
  const enabled = state.config.enabled_platforms || {};
  if (!enabled[p.platform]) return true; // e.g., X when auto-posting is toggled off
  return false;
}

function categorizePosts() {
  const scheduled = [];
  const review = [];
  const manual = [];
  const posted = [];
  for (const p of state.posts) {
    const st = (p.status || 'PENDING').toUpperCase();
    if (st === 'ARCHIVED') continue;
    if (st === 'POSTED') {
      posted.push(p);
    } else if (!p.approved) {
      review.push(p);
    } else if (isManualCard(p)) {
      manual.push(p);
    } else {
      scheduled.push(p);
    }
  }
  // Sort scheduled: exact scheduled_at dates first, then auto-queue
  scheduled.sort((a, b) => {
    if (a.scheduled_at && !b.scheduled_at) return -1;
    if (!a.scheduled_at && b.scheduled_at) return 1;
    if (a.scheduled_at && b.scheduled_at) return a.scheduled_at.localeCompare(b.scheduled_at);
    return a.id.localeCompare(b.id);
  });
  posted.sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  return { scheduled, review, manual, posted };
}

function filterList(list) {
  const q = state.search.trim().toLowerCase();
  return list.filter((p) => {
    if (state.platformFilter !== 'All' && p.platform !== state.platformFilter) return false;
    if (!q) return true;
    return (
      (p.id || '').toLowerCase().includes(q) ||
      (p.project || '').toLowerCase().includes(q) ||
      (p.text || '').toLowerCase().includes(q) ||
      (p.pillar || '').toLowerCase().includes(q) ||
      (p.target_location || '').toLowerCase().includes(q)
    );
  });
}

function mediaSrc(rel) {
  if (!rel) return '';
  if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
  if (state.gh.owner && state.gh.repo && location.protocol === 'file:') {
    return `https://raw.githubusercontent.com/${state.gh.owner}/${state.gh.repo}/${state.gh.branch}/${rel}`;
  }
  return rel;
}

function publicMediaUrl(rel) {
  if (!rel) return '';
  if (rel.startsWith('http')) return rel;
  if (state.gh.owner && state.gh.repo) {
    return `https://raw.githubusercontent.com/${state.gh.owner}/${state.gh.repo}/${state.gh.branch}/${rel}`;
  }
  return rel;
}

function renderCard(p, bucket) {
  const media = p.media || '';
  const isVid = media.toLowerCase().endsWith('.mp4');
  const mediaHtml = media
    ? `<div class="card-media">${
        isVid
          ? `<video src="${escapeHtml(mediaSrc(media))}" controls muted></video>`
          : `<img src="${escapeHtml(mediaSrc(media))}" alt="${escapeHtml(p.project)}" loading="lazy" />`
      }</div>`
    : '';

  let modeBadge = '';
  if (bucket === 'scheduled') {
    modeBadge = p.scheduled_at
      ? `<span class="badge badge-sched">🕒 ${escapeHtml(p.scheduled_at.replace('T', ' '))}</span>`
      : `<span class="badge badge-auto">🎲 Auto-Random Queue</span>`;
  } else if (bucket === 'manual') {
    modeBadge = `<span class="badge badge-manual">📋 Manual Copy-Paste</span>`;
  } else if (bucket === 'posted') {
    modeBadge = `<span class="badge badge-posted">✓ Posted</span>`;
  }

  const ctxHtml =
    p.context && !p.context.startsWith('N/A')
      ? `<div class="card-context"><strong>Context:</strong> ${escapeHtml(p.context)}</div>`
      : '';

  const actions = [];
  if (bucket === 'review') {
    actions.push(`<button class="btn btn-ok btn-sm" onclick="approvePost('${p.id}', true)">✓ Approve & Queue</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="openEditModal('${p.id}')">✎ Edit</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" onclick="archivePost('${p.id}')">🗑 Archive</button>`);
  } else if (bucket === 'scheduled') {
    actions.push(`<button class="btn btn-outline btn-sm" onclick="openEditModal('${p.id}')">✎ Edit / Schedule</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="approvePost('${p.id}', false)">↩ Move to Review</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="copyPostText('${p.id}', this)">📋 Copy</button>`);
  } else if (bucket === 'manual') {
    actions.push(`<button class="btn btn-primary btn-sm" onclick="copyPostText('${p.id}', this)">📋 Copy Text</button>`);
    if (media) {
      actions.push(`<button class="btn btn-outline btn-sm" onclick="copyRaw('${escapeHtml(publicMediaUrl(media))}', this)">🖼 Copy Media URL</button>`);
    }
    const openUrl = p.target_url && p.target_url.startsWith('http') ? p.target_url : '';
    if (openUrl) {
      actions.push(`<a class="btn btn-outline btn-sm" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener">↗ Open Target</a>`);
    }
    actions.push(`<button class="btn btn-ok btn-sm" onclick="markPostedManual('${p.id}')">✓ Mark Posted</button>`);
    actions.push(`<button class="btn btn-outline btn-sm" onclick="openEditModal('${p.id}')">✎</button>`);
  } else if (bucket === 'posted') {
    if (p.live_url && p.live_url.startsWith('http')) {
      actions.push(`<a class="btn btn-primary btn-sm" href="${escapeHtml(p.live_url)}" target="_blank" rel="noopener">↗ View Live Post</a>`);
    }
    actions.push(`<button class="btn btn-outline btn-sm" onclick="requeuePost('${p.id}')">↻ Re-Queue Copy</button>`);
  }

  return `
  <div class="card">
    <div class="card-top">
      <div class="badges">
        <span class="badge plat-${escapeHtml(p.platform)}">${escapeHtml(p.platform)}</span>
        <span class="badge badge-id">${escapeHtml(p.id)}</span>
        ${modeBadge}
      </div>
      <span class="card-meta">${escapeHtml(p.language || '')}</span>
    </div>
    <h3 class="card-title">${escapeHtml(p.project || 'Untitled Post')}</h3>
    <div class="card-meta">${escapeHtml(p.account || '')} · ${escapeHtml(p.target_location || '')}${p.posted_at ? ` · Posted ${escapeHtml(p.posted_at.slice(0, 16).replace('T', ' '))}` : ''}</div>
    ${ctxHtml}
    ${mediaHtml}
    <div class="card-text">${escapeHtml(p.text)}</div>
    <div class="card-actions">${actions.join('')}</div>
  </div>`;
}

function render() {
  const { scheduled, review, manual, posted } = categorizePosts();

  // Stats
  const enabledPlats = Object.entries(state.config.enabled_platforms || {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  document.getElementById('stat-scheduled').textContent = scheduled.length;
  document.getElementById('stat-scheduled-sub').textContent = `Auto: ${enabledPlats.join(', ') || 'None'}`;
  document.getElementById('stat-review').textContent = review.length;
  document.getElementById('stat-manual').textContent = manual.length;
  document.getElementById('stat-posted').textContent = posted.length;

  // Tab counts
  document.getElementById('cnt-scheduled').textContent = scheduled.length;
  document.getElementById('cnt-review').textContent = review.length;
  document.getElementById('cnt-manual').textContent = manual.length;
  document.getElementById('cnt-posted').textContent = posted.length;

  // Active tab highlight
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  document.querySelectorAll('.pill').forEach((b) => b.classList.toggle('active', b.dataset.plat === state.platformFilter));

  const map = { scheduled, review, manual, posted };
  const list = filterList(map[state.tab] || []);
  const area = document.getElementById('cards-area');

  if (!list.length) {
    area.innerHTML = `<div class="empty-state"><h3>Nothing here right now</h3><p>Try switching platform filters, or click <strong>+ New Post</strong> / <strong>📥 Reload Queue</strong> to add fresh posts.</p></div>`;
  } else {
    area.innerHTML = `<div class="cards-grid">${list.map((p) => renderCard(p, state.tab)).join('')}</div>`;
  }

  // Recent Logs (shown in Posted tab)
  const logsBox = document.getElementById('logs-section');
  if (state.tab === 'posted' && state.postLog.length) {
    logsBox.style.display = 'block';
    const rows = [...state.postLog]
      .reverse()
      .slice(0, 30)
      .map(
        (ev) => `
      <tr>
        <td>${escapeHtml((ev.ts || '').slice(0, 19).replace('T', ' '))}</td>
        <td><span class="badge plat-${escapeHtml(ev.platform)}">${escapeHtml(ev.platform)}</span></td>
        <td>${escapeHtml(ev.id || '')}</td>
        <td>${ev.status === 'POSTED' ? '<span class="badge badge-posted">POSTED</span>' : '<span class="badge badge-manual">' + escapeHtml(ev.status) + '</span>'}</td>
        <td>${ev.url ? `<a href="${escapeHtml(ev.url)}" target="_blank" style="color:#8ab8ff">${escapeHtml(ev.url)}</a>` : escapeHtml(ev.error || '')}</td>
      </tr>`
      )
      .join('');
    document.getElementById('logs-tbody').innerHTML = rows;
  } else {
    logsBox.style.display = 'none';
  }
}

// ---------------- Post Actions ---------------- //

function approvePost(id, val) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  p.approved = val;
  markDirty();
  render();
  toast(val ? `✓ ${id} approved & queued!` : `↩ ${id} moved back to Needs Validation`);
}

function archivePost(id) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Archive post ${id}?`)) return;
  p.status = 'ARCHIVED';
  markDirty();
  render();
}

function markPostedManual(id) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  p.status = 'POSTED';
  p.posted_at = new Date().toISOString();
  state.postLog.push({
    ts: p.posted_at,
    platform: p.platform,
    id: p.id,
    project: p.project,
    status: 'POSTED',
    url: p.target_url || '',
  });
  markDirty();
  render();
  toast(`✓ Marked ${id} as Posted!`);
}

function requeuePost(id) {
  const orig = state.posts.find((x) => x.id === id);
  if (!orig) return;
  const copy = {
    ...orig,
    id: `${orig.id}-R${Math.floor(Math.random() * 90 + 10)}`,
    status: 'PENDING',
    approved: false,
    scheduled_at: '',
    posted_at: '',
    live_url: '',
  };
  state.posts.unshift(copy);
  state.tab = 'review';
  markDirty();
  render();
  toast(`↻ Created fresh draft ${copy.id} in Needs Validation!`);
}

function copyPostText(id, btn) {
  const p = state.posts.find((x) => x.id === id);
  if (!p) return;
  navigator.clipboard.writeText(p.text).then(() => {
    const o = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => (btn.textContent = o), 1400);
  });
}

function copyRaw(val, btn) {
  navigator.clipboard.writeText(val).then(() => {
    const o = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => (btn.textContent = o), 1400);
  });
}

// ---------------- Edit / New Post Modal ---------------- //

function populateMediaSelect(currentVal) {
  const sel = document.getElementById('f-media-pick');
  const known = [...new Set(state.posts.map((p) => p.media).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">-- Choose existing media --</option>` + known.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  if (known.includes(currentVal)) sel.value = currentVal;
}

function openEditModal(id = null) {
  state.editingId = id;
  const isNew = !id;
  const p = isNew
    ? {
        id: `NEW-${Date.now().toString().slice(-4)}`,
        platform: 'LinkedIn',
        account: 'Martin Schmalzried',
        language: 'EN',
        pillar: 'General',
        project: '',
        automation_mode: 'API_AUTO',
        approved: false,
        status: 'PENDING',
        scheduled_at: '',
        target_location: 'Main Timeline',
        target_url: '',
        context: '',
        text: '',
        link: '',
        media: '',
        notes: '',
      }
    : state.posts.find((x) => x.id === id);

  document.getElementById('edit-modal-title').textContent = isNew ? 'Create New Post' : `Edit ${p.id}`;
  document.getElementById('f-id').value = p.id;
  document.getElementById('f-platform').value = p.platform;
  document.getElementById('f-mode').value = p.automation_mode || 'API_AUTO';
  document.getElementById('f-project').value = p.project || '';
  document.getElementById('f-account').value = p.account || '';
  document.getElementById('f-lang').value = p.language || 'EN';
  document.getElementById('f-sched').value = p.scheduled_at ? p.scheduled_at.slice(0, 16) : '';
  document.getElementById('f-target-loc').value = p.target_location || '';
  document.getElementById('f-target-url').value = p.target_url || '';
  document.getElementById('f-link').value = p.link || '';
  document.getElementById('f-media').value = p.media || '';
  document.getElementById('f-text').value = p.text || '';
  document.getElementById('f-approved').checked = Boolean(p.approved);
  populateMediaSelect(p.media || '');
  document.getElementById('modal-edit').classList.add('open');
}

function saveEditModal() {
  const obj = {
    id: document.getElementById('f-id').value.trim() || `POST-${Date.now().toString().slice(-4)}`,
    platform: document.getElementById('f-platform').value,
    automation_mode: document.getElementById('f-mode').value,
    project: document.getElementById('f-project').value.trim(),
    account: document.getElementById('f-account').value.trim(),
    language: document.getElementById('f-lang').value.trim() || 'EN',
    scheduled_at: document.getElementById('f-sched').value.trim(),
    target_location: document.getElementById('f-target-loc').value.trim(),
    target_url: document.getElementById('f-target-url').value.trim(),
    link: document.getElementById('f-link').value.trim(),
    media: document.getElementById('f-media').value.trim(),
    text: document.getElementById('f-text').value.trim(),
    approved: document.getElementById('f-approved').checked,
  };
  if (!obj.text) {
    alert('Post text cannot be empty.');
    return;
  }
  if (state.editingId) {
    const idx = state.posts.findIndex((x) => x.id === state.editingId);
    if (idx >= 0) state.posts[idx] = { ...state.posts[idx], ...obj };
  } else {
    state.posts.unshift({ ...obj, status: 'PENDING', pillar: 'Custom', context: '', notes: '', posted_at: '', live_url: '' });
  }
  closeModals();
  markDirty();
  render();
  toast('Saved locally — click "Save & Sync to GitHub" when ready!');
}

async function uploadMediaFileToGitHub(fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  if (!state.gh.token) {
    alert('Connect your GitHub Personal Access Token in Settings first to upload images directly to your repo.');
    fileInput.value = '';
    return;
  }
  const safeName = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
  const repoPath = `media/${safeName}`;
  toast(`⏳ Uploading ${safeName} to GitHub...`, 6000);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const b64 = reader.result.split(',')[1];
      await ghPutFile(repoPath, b64, `chore: upload media ${safeName} via Social Hub Studio [skip ci]`);
      document.getElementById('f-media').value = repoPath;
      toast(`✓ Uploaded ${repoPath} to GitHub!`);
    } catch (e) {
      alert('Upload failed:\n' + e.message);
    } finally {
      fileInput.value = '';
    }
  };
  reader.readAsDataURL(file);
}

// ---------------- Import / Reload New Queue ---------------- //

function openImportModal() {
  document.getElementById('import-text').value = '';
  document.getElementById('modal-import').classList.add('open');
}

function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    document.getElementById('import-text').value = r.result;
  };
  r.readAsText(file);
}

function parseSimpleCsv(text) {
  // RFC-4180 compliant CSV parser for queue_*.csv files
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\r') {}
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (rows.length < 2) return [];
  const hdr = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  return rows.slice(1).filter((r) => r.some((x) => x.trim())).map((r) => {
    const o = {};
    hdr.forEach((h, idx) => (o[h] = (r[idx] || '').trim()));
    return o;
  });
}

function runImport() {
  const raw = document.getElementById('import-text').value.trim();
  const forceReview = document.getElementById('import-as-review').checked;
  if (!raw) return alert('Paste JSON/CSV or choose a file first.');

  let incoming = [];
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    incoming = Array.isArray(parsed) ? parsed : parsed.posts || [];
  } else {
    const csvRows = parseSimpleCsv(raw);
    incoming = csvRows.map((r) => ({
      id: r.ID || `IMP-${Math.floor(Math.random() * 9000 + 1000)}`,
      platform: r.Platform || (r.ID && r.ID.startsWith('LI') ? 'LinkedIn' : r.ID && r.ID.startsWith('FB') ? 'Facebook' : r.ID && r.ID.startsWith('IG') ? 'Instagram' : 'X'),
      account: r.Account || '',
      language: r.Language || 'EN',
      pillar: r.Pillar || '',
      project: r.Project || '',
      automation_mode: r.Automation_Mode || 'API_AUTO',
      approved: false,
      status: 'PENDING',
      scheduled_at: '',
      target_location: r.Target_Location || 'Main Timeline',
      target_url: r.Target_URL || '',
      context: r.Reference_Post_Context || '',
      text: r.Post_Text || r.text || '',
      link: r.Link_To_Attach || r.link || '',
      media: r.Media || r.media || '',
      notes: r.Notes || '',
    }));
  }

  const existingIds = new Set(state.posts.map((p) => p.id));
  let added = 0;
  for (const item of incoming) {
    if (!item.text) continue;
    let id = item.id || `NEW-${Date.now().toString().slice(-4)}-${added}`;
    if (existingIds.has(id)) id = `${id}-${Date.now().toString().slice(-3)}`;
    existingIds.add(id);
    state.posts.unshift({
      id,
      platform: item.platform || 'LinkedIn',
      account: item.account || '',
      language: item.language || 'EN',
      pillar: item.pillar || 'New Batch',
      project: item.project || 'Imported Post',
      automation_mode: item.automation_mode || 'API_AUTO',
      approved: forceReview ? false : Boolean(item.approved),
      status: 'PENDING',
      scheduled_at: item.scheduled_at || '',
      target_location: item.target_location || 'Main Timeline',
      target_url: item.target_url || '',
      context: item.context || '',
      text: item.text,
      link: item.link || '',
      media: item.media || '',
      notes: item.notes || '',
      posted_at: '',
      live_url: '',
    });
    added++;
  }

  closeModals();
  state.tab = 'review';
  markDirty();
  render();
  toast(`📥 Loaded ${added} new post(s) into Needs Validation!`);
}

// ---------------- Settings & Run Now Modals ---------------- //

function openSettingsModal() {
  document.getElementById('s-owner').value = state.gh.owner;
  document.getElementById('s-repo').value = state.gh.repo;
  document.getElementById('s-branch').value = state.gh.branch;
  document.getElementById('s-token').value = state.gh.token;

  const ep = state.config.enabled_platforms || {};
  document.getElementById('c-li').checked = Boolean(ep.LinkedIn);
  document.getElementById('c-fb').checked = Boolean(ep.Facebook);
  document.getElementById('c-ig').checked = Boolean(ep.Instagram);
  document.getElementById('c-x').checked = Boolean(ep.X);
  document.getElementById('c-max').value = state.config.max_posts_per_run || 2;
  document.getElementById('c-hours').value = state.config.min_hours_per_platform || 36;
  document.getElementById('c-jitter').value = state.config.random_jitter_max_minutes ?? 35;
  document.getElementById('c-shuffle').checked = Boolean(state.config.shuffle);
  document.getElementById('modal-settings').classList.add('open');
}

function saveSettingsModal() {
  saveGhSettings({
    owner: document.getElementById('s-owner').value.trim(),
    repo: document.getElementById('s-repo').value.trim() || 'social-hub',
    branch: document.getElementById('s-branch').value.trim() || 'main',
    token: document.getElementById('s-token').value.trim(),
  });
  state.config.enabled_platforms = {
    LinkedIn: document.getElementById('c-li').checked,
    Facebook: document.getElementById('c-fb').checked,
    Instagram: document.getElementById('c-ig').checked,
    X: document.getElementById('c-x').checked,
  };
  state.config.max_posts_per_run = Number(document.getElementById('c-max').value) || 2;
  state.config.min_hours_per_platform = Number(document.getElementById('c-hours').value) || 36;
  state.config.random_jitter_max_minutes = Number(document.getElementById('c-jitter').value) || 0;
  state.config.shuffle = document.getElementById('c-shuffle').checked;
  closeModals();
  markDirty();
  render();
  toast('Settings updated — click "Save & Sync to GitHub" to commit schedule changes!');
}

function openRunNowModal() {
  document.getElementById('modal-run').classList.add('open');
}

async function executeRunNow() {
  const plat = document.getElementById('r-plat').value;
  const maxP = document.getElementById('r-max').value;
  const ign = document.getElementById('r-ignore').checked;
  const dry = document.getElementById('r-dry').checked;
  try {
    await triggerWorkflowRun(plat, maxP, ign, dry);
    closeModals();
    toast('⚡ GitHub Actions auto-poster triggered! Refresh in ~45 seconds to see the published URL.', 5000);
  } catch (e) {
    alert('Could not trigger workflow:\n' + e.message);
  }
}

function exportQueueJson() {
  const blob = new Blob([JSON.stringify({ version: 1, posts: state.posts }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'queue.json';
  a.click();
}

function closeModals() {
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.remove('open'));
}

// ---------------- Init ---------------- //

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      render();
    })
  );
  document.querySelectorAll('.pill').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.platformFilter = btn.dataset.plat;
      render();
    })
  );
  document.getElementById('search-box').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });
  document.getElementById('f-media-pick').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('f-media').value = e.target.value;
  });
  document.querySelectorAll('.modal-backdrop').forEach((bg) =>
    bg.addEventListener('click', (e) => {
      if (e.target === bg) closeModals();
    })
  );
  updateSyncUI();
  loadData();
});

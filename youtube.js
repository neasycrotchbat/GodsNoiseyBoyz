// YouTube helpers: URL parsing, metadata lookup, playlist import and search.
// Works without an API key for single videos (via oEmbed) and for playlists the
// browser has read (lookupMany); server-side playlist import and search need a
// free YouTube Data API v3 key in config.json.

const API = 'https://www.googleapis.com/youtube/v3';
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function parseUrl(input) {
  const text = String(input || '').trim();
  if (ID_RE.test(text)) return { videoId: text, playlistId: null };
  let url;
  try {
    url = new URL(text.startsWith('http') ? text : 'https://' + text);
  } catch {
    return { videoId: null, playlistId: null };
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let videoId = null;
  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1, 12);
  } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    videoId = url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (!videoId && m) videoId = m[1];
  } else {
    return { videoId: null, playlistId: null };
  }
  if (videoId && !ID_RE.test(videoId)) videoId = null;
  const list = url.searchParams.get('list');
  const playlistId = list && /^[A-Za-z0-9_-]{10,64}$/.test(list) ? list : null;
  return { videoId, playlistId };
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    try { err.body = await res.json(); } catch { /* ignore */ }
    throw err;
  }
  return res.json();
}

function songFromApi(item) {
  const sn = item.snippet || {};
  const thumbs = sn.thumbnails || {};
  return {
    videoId: item.id,
    title: sn.title || 'Untitled',
    channel: sn.channelTitle || '',
    duration: parseDuration(item.contentDetails && item.contentDetails.duration),
    thumb: (thumbs.medium || thumbs.default || {}).url || `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
    embeddable: !item.status || item.status.embeddable !== false,
  };
}

// Look up up to N video ids with the Data API (50 per call).
async function videosByIds(ids, key) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await getJson(`${API}/videos?part=snippet,contentDetails,status&id=${chunk.join(',')}&key=${encodeURIComponent(key)}`);
    const byId = new Map((data.items || []).map((it) => [it.id, songFromApi(it)]));
    for (const id of chunk) if (byId.has(id)) out.push(byId.get(id));
  }
  return out;
}

// Single video lookup. Uses the API when a key exists, otherwise oEmbed
// (oEmbed answers 401/403 when the owner has disabled embedding).
async function lookupVideo(videoId, key) {
  if (key) {
    const [song] = await videosByIds([videoId], key);
    if (!song) throw userError("Couldn't find that video. It may be private or deleted.");
    return song;
  }
  try {
    const data = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`);
    return {
      videoId,
      title: data.title || 'YouTube video',
      channel: data.author_name || '',
      duration: 0,
      thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      embeddable: true,
    };
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return { videoId, title: 'Embedding disabled', channel: '', duration: 0, thumb: '', embeddable: false };
    }
    if (e.status === 404 || e.status === 400) throw userError("Couldn't find that video. It may be private or deleted.");
    // Network trouble: still accept the song; the player fills in details later.
    return { videoId, title: `YouTube video ${videoId}`, channel: '', duration: 0, thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, embeddable: true };
  }
}

// Look up a list of video ids, e.g. a playlist read by the browser's player.
// With a key this is one API call per 50; without, a few oEmbed calls at a time.
async function lookupMany(ids, key) {
  ids = [...new Set(ids.filter((id) => ID_RE.test(id)))];
  if (key) return videosByIds(ids, key);
  const out = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try { out[i] = await lookupVideo(ids[i], ''); } catch { out[i] = null; } // private or deleted
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out.filter(Boolean);
}

async function importPlaylist(playlistId, key, limit = 2000) {
  if (!key) throw userError('Playlist import needs a YouTube API key. See the README for the free 5-minute setup.');
  const ids = [];
  let pageToken = '';
  do {
    let data;
    try {
      data = await getJson(`${API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}${pageToken ? '&pageToken=' + pageToken : ''}`);
    } catch (e) {
      if (e.status === 404) throw userError("Couldn't open that playlist. Make sure it's public or unlisted.");
      throw e;
    }
    for (const it of data.items || []) {
      const id = it.contentDetails && it.contentDetails.videoId;
      if (id && ID_RE.test(id)) ids.push(id);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken && ids.length < limit);
  return videosByIds(ids.slice(0, limit), key);
}

// The playlist's name on YouTube, or '' if it can't be found.
async function playlistTitle(playlistId, key) {
  try {
    if (key) {
      const data = await getJson(`${API}/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}`);
      return (data.items && data.items[0] && data.items[0].snippet.title) || '';
    }
    const data = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/playlist?list=' + playlistId)}`);
    return data.title || '';
  } catch {
    return '';
  }
}

async function search(q, key) {
  if (!key) throw userError('Search needs a YouTube API key. You can still paste links.');
  const data = await getJson(`${API}/search?part=snippet&type=video&videoEmbeddable=true&maxResults=10&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`);
  const ids = (data.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
  return ids.length ? videosByIds(ids, key) : [];
}

function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

module.exports = { parseUrl, parseDuration, lookupVideo, lookupMany, importPlaylist, playlistTitle, search, userError };

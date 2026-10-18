// Update check of the "updater" Chrome / Edge package (1.6.4, #62): the package installed by hand ("Load unpacked")
// gets no store updates, so it looks at the latest release on GitHub once a day and tells the user in the popup.
// Nothing is installed automatically; nothing about the user is sent (an ordinary request to the public GitHub API).

export const UPDATE_REPO = 'aspidovss/video-downloader-legal';
export const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
export const UPDATER_MARK = 'updater'; // in version_name of the updater package: "1.6.4 (updater)"

export const isEdge = (ua = globalThis.navigator?.userAgent || '') => /\bEdg\//.test(ua);

// "v1.6.2" / "1.6.2" / "1.6.2.3" -> [1, 6, 2, 3]; null when it is not a version
export function parseVersion(s) {
  const m = /^v?(\d+(?:\.\d+){0,3})$/i.exec(String(s || '').trim());
  return m ? m[1].split('.').map(Number) : null;
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// GitHub "latest release" JSON -> what the popup shows. The download is the updater package of that release
// (video-downloader-legal-chrome-updater-<version>.zip), else the release page.
export function releaseInfo(rel, current, edge = false) {
  if (!rel || rel.draft || rel.prerelease || !parseVersion(rel.tag_name)) return null;
  const version = parseVersion(rel.tag_name).join('.');
  const page = /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${UPDATE_REPO}/releases/latest`;
  // Edge gets its own package name (the same files); the Chrome one when the release has no Edge one
  const pick = (kind) => (rel.assets || []).find((a) => new RegExp(`${kind}-updater-[\\d.]+\\.zip$`, 'i').test(a?.name || '') && /^https:\/\/github\.com\//.test(a?.browser_download_url || ''));
  const asset = (edge && pick('edge')) || pick('chrome');
  return { version, page, zip: asset ? asset.browser_download_url : '', newer: isNewer(version, current) };
}

export const isUpdaterBuild = (manifest) => String(manifest?.version_name || '').includes(UPDATER_MARK);

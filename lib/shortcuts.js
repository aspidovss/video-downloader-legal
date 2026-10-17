// Keyboard shortcuts of the extension (Firefox: commands.update). Pure functions, unit-tested in Node.
// Format of Firefox / WebExtensions: "Ctrl+Shift+Down" = one or two modifiers + one key; at least one of
// Ctrl / Alt / Command / MacCtrl, Shift is optional. An empty string means "no shortcut".

export const DEFAULT_SHORTCUTS = { hkExecute: 'Alt+Up', hkVideo: 'Alt+Down', hkAudio: 'Alt+Shift+Down' };

// settings key -> name of the command in manifest.json
export const COMMAND_OF = { hkExecute: '_execute_action', hkVideo: 'default-action', hkAudio: 'download-audio' };

const PRIMARY = ['Ctrl', 'Alt', 'Command', 'MacCtrl'];
const NAMED = ['Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right'];
const isKey = (k) => /^[A-Z0-9]$/.test(k) || /^F([1-9]|1[0-2])$/.test(k) || NAMED.includes(k);

export function isValidShortcut(s) {
  if (s === '') return true;
  if (typeof s !== 'string') return false;
  const parts = s.split('+');
  const key = parts.pop();
  if (!isKey(key) || parts.length < 1 || parts.length > 2 || new Set(parts).size !== parts.length) return false;
  return parts.every((m) => PRIMARY.includes(m) || m === 'Shift') && parts.some((m) => PRIMARY.includes(m));
}

// KeyboardEvent -> "Alt+Shift+Down", or null while the combination is incomplete / unusable.
export function shortcutFromEvent(e, mac = false) {
  const code = String(e.code || '');
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) key = code.slice(5);
  else if (['Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete'].includes(code)) key = code;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push(mac ? 'MacCtrl' : 'Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) { if (!mac) return null; mods.push('Command'); }
  if (e.shiftKey) mods.push('Shift');
  const s = [...mods, key].join('+');
  return isValidShortcut(s) ? s : null;
}

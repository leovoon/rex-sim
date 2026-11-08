// Typed characters -> USB HID keyboard usages, as Maestro maps KeyboardEvent.code.
const USAGES = {
  "\r": 40, "\x1b": 41, "\x7f": 42, "\t": 43, " ": 44,
  "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49, ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56,
  home: 74, pageup: 75, delete: 76, end: 77, pagedown: 78, right: 79, left: 80, down: 81, up: 82,
};
for (let i = 0; i < 26; i++) USAGES[String.fromCharCode(97 + i)] = 4 + i;
for (let i = 0; i < 10; i++) USAGES["1234567890"[i]] = 30 + i;

// A shifted symbol is its unshifted key with Shift held.
const UNSHIFTED = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};
const CONTROL = 224;
const SHIFT = 225;

// The usage and held modifiers for a character or named key, or null.
// Ctrl-letter arrives as one control byte; Tab, Enter and Backspace keep theirs.
export function keyUsage(key) {
  if (USAGES[key]) return { usage: USAGES[key], modifiers: [] };
  if (UNSHIFTED[key]) return { usage: USAGES[UNSHIFTED[key]], modifiers: [SHIFT] };
  if (/^[A-Z]$/.test(key)) return { usage: USAGES[key.toLowerCase()], modifiers: [SHIFT] };
  const code = key.length === 1 ? key.charCodeAt(0) : 0;
  if (code >= 1 && code <= 26) return { usage: 3 + code, modifiers: [CONTROL] };
  return null;
}

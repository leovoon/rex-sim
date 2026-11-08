// Typed characters -> USB HID keyboard usages, as Maestro maps KeyboardEvent.code.
const USAGES = {
  "\r": 40, "\x1b": 41, "\x7f": 42, "\t": 43, " ": 44,
  "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49, ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56,
  right: 79, left: 80, down: 81, up: 82, delete: 76,
};
for (let i = 0; i < 26; i++) USAGES[String.fromCharCode(97 + i)] = 4 + i;
for (let i = 0; i < 10; i++) USAGES["1234567890"[i]] = 30 + i;

// A shifted symbol is its unshifted key with Shift held.
const UNSHIFTED = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};
const SHIFT = 225;

// The usage and held modifiers for a character or named key, or null.
export function keyUsage(key) {
  let shift = false;
  if (UNSHIFTED[key]) [key, shift] = [UNSHIFTED[key], true];
  else if (/^[A-Z]$/.test(key)) [key, shift] = [key.toLowerCase(), true];
  const usage = USAGES[key];
  return usage ? { usage, modifiers: shift ? [SHIFT] : [] } : null;
}

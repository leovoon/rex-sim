# rex-sim

Your iOS simulator, live in a terminal pane. Click to tap, drag to swipe, scroll, and type, right next to your code.

Built for [Rex](https://www.superlogical.com/rex), and it should work in any terminal that draws Kitty graphics and reports the mouse in pixels, such as Ghostty.

## Use it

Boot a simulator, then in a Rex terminal:

```sh
npm install
node bin/rex-sim.mjs
```

Or open it beside your current pane:

```sh
rex run --split=right -- node /path/to/rex-sim/bin/rex-sim.mjs
```

With several simulators booted, pick one with `--device <udid>`.

- **Click** to tap, **drag** to swipe. A drag that starts at the bottom edge goes home, as on a phone.
- **Scroll** with the mouse wheel or trackpad.
- **Type** and the keys go to the simulator.
- **Ctrl-B** presses Home. **Ctrl-C** quits.

The status line shows the device and how many frames a second it's drawing. It counts only frames that changed, so a still screen shows a low number.

## What it runs

- [serve-sim](https://github.com/EvanBacon/serve-sim) 0.1.49 through `npx`, which streams the simulator's screen and takes its input. It keeps running after rex-sim quits.
- [sharp](https://sharp.pixelplumbing.com) to shrink each frame to the pane's size.

Each frame goes to the terminal as a temp file in `/tmp`, which the terminal reads and deletes. A terminal that can't read it gets the pixels inline instead, and the status line says "(inline)".

## Limits

- iOS only for now. Android would reuse herdr-sim's emulator helper.
- No Lock, volume or rotate buttons yet.
- Typing covers letters, digits, symbols, Enter, Backspace, Tab, Escape, Delete and the arrows. Shortcuts with Ctrl or Option don't reach the device.
- If Rex starts it with a broken `node` on its PATH, run it from your own shell or give `node` by its full path.

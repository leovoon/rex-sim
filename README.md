# rex-sim

Your iOS simulator, Android emulator, and real Android device, live in a [Rex](https://www.superlogical.com/rex) pane, next to your code and terminals.

Pick any simulator or emulator on your Mac — or a physical Android phone over adb — and use it right in Rex. Run your mobile tests and watch them tap through the app while the results print beside it.

## What you can do

- **See the device live.** The screen updates up to about 40 times a second while it moves.
- **Use it in place.** Click to tap, drag to swipe, scroll with your mouse or trackpad, and type with your keyboard. A drag that starts at the bottom edge of an iPhone goes home, as on the phone.
- **Press its buttons.** Home, Lock, the volume keys, Rotate and the iOS on-screen keyboard are actions in the command palette, so you can bind them to keys.
- **Switch devices.** Click the device name at the bottom left, or press Ctrl-P. The picker lists every iOS simulator, Android emulator, and connected physical Android device on your Mac, with the running ones marked green. Pick one that's off and it starts. Android emulators run without a window of their own.
- **Show two at once.** Each pane has its own device, so an iPhone and an Android emulator can run side by side. A new pane starts on the device you picked last.
- **Fix stuck taps.** On Xcode 27, taps on a simulator sometimes stop working. Repair input, at the bottom of the picker, fixes them. It restarts SpringBoard, so open apps close.

## Install

You need macOS, Xcode with at least one simulator, and Node 22 or later. For Android you also need the Android SDK and an emulator image built for your Mac's chip. For a **physical Android device** (wired, or wireless over `adb connect`), also install `scrcpy` and `ffmpeg`:

```sh
brew install scrcpy ffmpeg
```

The phone must have USB debugging authorized (adb shows it as `device`, not `unauthorized`).

Physical-device stream quality is tunable with environment variables (set them before starting the pane):

| Variable | Default | What it sets |
| --- | --- | --- |
| `REX_SIM_WIDTH` | `540` | Stream width in pixels, 240–1080. Higher = sharper, heavier. |
| `REX_SIM_BITRATE` | `4M` | scrcpy video bit-rate (e.g. `2M`, `8M`). |
| `REX_SIM_FPS` | `60` | Maximum capture frame rate, 10–120. |
| `REX_SIM_JPEG_Q` | `4` | MJPEG quality, 1 (best) – 31 (worst). |
| `REX_SIM_CODEC` | `h265` | Capture codec: `h265` (HEVC, smaller on wifi) or `h264`. |
| `REX_SIM_INPUT` | — | `control` opts into the scrcpy control channel (faster, but blocked on some OEMs until “USB debugging (Security settings)” is enabled). |
| `REX_SIM_PIPE` | — | `mkv` forces the older Matroska-over-fifo pipeline; the raw H.264/HEVC socket is the default. |
| `REX_SIM_SCRCPY` / `REX_SIM_FFMPEG` / `REX_SIM_SCRCPY_SERVER` | — | Override tool paths. |

With [Amber](https://github.com/rawnly/amber), add rex-sim to your plugins in `~/.config/rex/init.lua`:

```lua
amber.setup({
  plugins = {
    { "wobsoriano/rex-sim", opts = { keys = { toggle = "cmd+shift+s" } } },
  },
})
```

Then run `rex do amber_install` and `rex config reload`.

Without Amber, clone it anywhere and load it from `~/.config/rex/init.lua`:

```sh
git clone https://github.com/wobsoriano/rex-sim ~/.local/share/rex-sim
```

```lua
dofile(os.getenv("HOME") .. "/.local/share/rex-sim/lua/rex-sim/init.lua").setup({
  keys = { toggle = "cmd+shift+s" },
})
```

Then run `rex config reload`. The first time the pane opens, it installs its one dependency with npm, which takes a few seconds.

## Use it

Press your toggle key, or run **Simulator: Toggle** from the command palette. It opens a pane beside the focused one. Run it again to close the pane.

In the pane, Ctrl-P opens the picker, where the arrow keys or j and k move, Enter picks and Escape closes. Ctrl-C closes the pane. Every other key goes to the device.

These actions work from anywhere in the window, under Simulator in the command palette. Add any of them to `keys` by the part after `sim_`.

| Action | What it does |
| --- | --- |
| `sim_toggle` | Opens the pane, or closes it. A floating pane is hidden instead, and stops streaming while hidden. |
| `sim_open` | Opens another pane. Takes `device` and `placement`. |
| `sim_close` | Closes the pane. |
| `sim_devices` | Opens the picker. |
| `sim_device` | Shows a device, booting it if it's off. Takes `device`. |
| `sim_home`, `sim_lock` | Presses Home or Lock. |
| `sim_volume_up`, `sim_volume_down` | Presses a volume key. |
| `sim_rotate` | Rotates the device a quarter turn. |
| `sim_keyboard` | Shows or hides the iOS on-screen keyboard. |
| `sim_repair` | Repairs input on an iOS simulator. |

A device is a simulator's UDID, from `xcrun simctl list devices`, or `avd:` and an emulator's name, such as `avd:Pixel_3a_API_36`.

## Options

| Option | Default | What it sets |
| --- | --- | --- |
| `node` | `"node"` | The Node that runs the pane. Give a full path if Rex finds a different one on your PATH. |
| `placement` | `"split"` | Where the pane opens: `"split"` beside the focused pane, `"float"`, or `"tab"`. |
| `width` | `0.4` | The pane's share of the width, for a split. |
| `bounds` | `{ 0.62, 0.03, 0.36, 0.94 }` | Where a floating pane sits, as `{ x, y, w, h }` fractions of the window. |
| `device` | none | The device a new pane starts on. Without it, the one you picked last, else the first running one. |
| `keys` | `{}` | Keys for actions, such as `{ toggle = "cmd+shift+s", home = "cmd+shift+h" }`. |

You can also run the pane in any Rex terminal with `node bin/rex-sim.mjs`, and `--device` to pick the device.

## What it runs on your Mac

rex-sim sends nothing over the internet itself.

- For iOS it runs Xcode's simulator tools and [serve-sim](https://github.com/EvanBacon/serve-sim) 0.1.49 through `npx`, which downloads from npm the first time. serve-sim keeps running after the pane closes.
- For Android emulators it runs `adb` and the emulator from your Android SDK, plus a small helper that comes with rex-sim. The helper stops a few seconds after the last pane showing that emulator closes.
- For a real Android device it runs `scrcpy` headless (`--no-playback --no-window`), recording into a pipe as Matroska, and `ffmpeg` turns that into the frame stream. Input goes through `adb shell input`, like the emulator path. The phone's screen wakes when the stream opens; if it's locked, you'll see the lock screen.
- It shrinks each frame to the pane with [sharp](https://sharp.pixelplumbing.com) and hands it to Rex as a file in `/tmp`, which Rex reads and deletes.

## Limits

- It works on macOS only. It's tested with Rex 1853, Xcode 27, Android emulator 37.2 and scrcpy 3.3.4.
- A wireless adb device streams over your network: that works, but expect noticeably slower, less smooth frames than USB. Plug in for demos.
- Rex shows pictures only through the Kitty graphics protocol, so the pane must be a Rex terminal, or another terminal that draws Kitty graphics and reports the mouse in pixels.
- Of the shortcuts, only Ctrl with a letter reaches the device, and on Android it types just the letter.
- On a Rex without minimized floating panes, Simulator: Toggle closes a floating pane instead of hiding it.

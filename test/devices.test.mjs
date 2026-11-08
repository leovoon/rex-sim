import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmulators } from "../src/android.mjs";
import { parseSimulators } from "../src/ios.mjs";

test("simulators: iOS runtimes only, newest OS first, booted marked", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid: "A", name: "iPhone 16", state: "Shutdown" }],
      "com.apple.CoreSimulator.SimRuntime.iOS-27-2": [
        { udid: "C", name: "iPhone 17 Pro", state: "Shutdown" },
        { udid: "B", name: "iPhone 17", state: "Booted" },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "W", name: "Apple Watch", state: "Booted" }],
    },
  });
  assert.deepEqual(parseSimulators(json), [
    { platform: "ios", id: "B", name: "iPhone 17", os: "iOS 27.2", booted: true },
    { platform: "ios", id: "C", name: "iPhone 17 Pro", os: "iOS 27.2", booted: false },
    { platform: "ios", id: "A", name: "iPhone 16", os: "iOS 18.0", booted: false },
  ]);
});

test("emulators: running ones marked, images for another CPU unusable", () => {
  const out = ["host arm64", "avd Pixel_3a_API_36 arm64-v8a 36", "avd Old_x86 x86_64 30", "avd Bare  ", "on Pixel_3a_API_36", ""].join("\n");
  assert.deepEqual(parseEmulators(out), [
    { platform: "android", id: "avd:Pixel_3a_API_36", avd: "Pixel_3a_API_36", name: "Pixel 3a API 36", os: "Android API 36", booted: true, unusable: null },
    { platform: "android", id: "avd:Old_x86", avd: "Old_x86", name: "Old x86", os: "Android API 30", booted: false, unusable: "x86_64 image, can't run on this Mac" },
    { platform: "android", id: "avd:Bare", avd: "Bare", name: "Bare", os: "Android", booted: false, unusable: null },
  ]);
});

test("no Android SDK lists no emulators", () => {
  assert.deepEqual(parseEmulators(""), []);
});

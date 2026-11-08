import { bootEmulator, listEmulators, startEmulator } from "./android.mjs";
import { bootSimulator, listSimulators, repairInput, startSimulator } from "./ios.mjs";

// Grouped in the picker in this order. `start` opens a session: the device, a
// stream of its frames (JPEG or PNG) and its input. `repair` is optional.
export const PLATFORMS = [
  { id: "android", label: "Android", list: listEmulators, boot: bootEmulator, start: startEmulator },
  { id: "ios", label: "iOS", list: listSimulators, boot: bootSimulator, start: startSimulator, repair: repairInput },
];

export const platformOf = (device) => PLATFORMS.find((p) => p.id === device.platform);

// Every device a platform can list; a platform whose tools are missing lists none.
export async function listDevices() {
  return (await Promise.all(PLATFORMS.map((p) => p.list().catch(() => [])))).flat();
}

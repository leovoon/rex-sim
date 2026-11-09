import { bootEmulator, listEmulators, startEmulator } from "./android.mjs";
import { bootSimulator, listSimulators, repairInput, startSimulator } from "./ios.mjs";
import { connectPhysicalDevice, listPhysicalDevices, startPhysicalDevice } from "./physical.mjs";

// Grouped in the picker in this order. `start` opens a session: the device, a
// stream of its frames (JPEG or PNG) and its input. `repair` is optional.
export const PLATFORMS = [
  { id: "android", label: "Android", list: listEmulators, boot: bootEmulator, start: startEmulator },
  { id: "android-physical", label: "Android device", list: listPhysicalDevices, boot: connectPhysicalDevice, start: startPhysicalDevice },
  { id: "ios", label: "iOS", list: listSimulators, boot: bootSimulator, start: startSimulator, repair: repairInput },
];

export const platformOf = (device) => PLATFORMS.find((p) => p.id === device.platform);

// A logical device id resolves through its selected transport id, its serial,
// and any aliases (the other transports of the same physical device).
export const deviceMatchesId = (device, id) =>
  device.id === id || device.serial === id || (device.aliases?.includes(id) ?? false);

export const canRepair = (device) => Boolean(device?.booted && platformOf(device).repair);

// Every device a platform can list; a platform whose tools are missing lists none.
export async function listDevices() {
  return (await Promise.all(PLATFORMS.map((p) => p.list().catch(() => [])))).flat();
}

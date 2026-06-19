// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";

// We inject by EVDEV HARDWARE KEYCODE, not keyval: notify_keyval() reverse-maps
// in the current keyboard group only, so under a non-Latin layout the keyval for
// "v" has no keycode and the paste is dropped. A hardware keycode is the
// layout-independent physical key position. Codes from <linux/input-event-codes.h>.

// Accepts the spellings used in GTK accelerators (`<Primary>` is the portable
// name for Control).
const MODIFIER_KEYCODES = {
  ctrl: 29, // KEY_LEFTCTRL
  control: 29,
  primary: 29,
  shift: 42, // KEY_LEFTSHIFT
  alt: 56, // KEY_LEFTALT
  mod1: 56,
  super: 125, // KEY_LEFTMETA
  meta: 125,
};

// Keyed by US-layout label (layout-independent physical key position).
const CHAR_KEYCODES = {
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6,
  "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
};

const NAMED_KEYCODES = {
  insert: 110, // KEY_INSERT
  ins: 110,
};

// Paster injects key events through GNOME Shell's in-process Clutter virtual
// input device. Running inside the compositor, no Remote Desktop portal session
// is created, so no permission dialog appears.
export class Paster {
  constructor() {
    this._device = null;
  }

  _ensureDevice() {
    if (this._device) return this._device;
    const seat = Clutter.get_default_backend().get_default_seat();
    this._device = seat.create_virtual_device(
      Clutter.InputDeviceType.KEYBOARD_DEVICE,
    );
    return this._device;
  }

  // Returns { modifiers, key } of evdev hardware keycodes, or null if no usable key.
  static parseAccelerator(accel) {
    if (typeof accel !== "string" || accel.length === 0) return null;
    const modifiers = [];
    let rest = accel;
    const re = /<([^>]+)>/g;
    let m;
    while ((m = re.exec(accel)) !== null) {
      const mod = MODIFIER_KEYCODES[m[1].toLowerCase()];
      if (mod) modifiers.push(mod);
    }
    rest = accel.replace(/<[^>]+>/g, "").trim();
    if (rest.length === 0) return null;

    let key;
    if (rest.length === 1) {
      // Any Shift is supplied as a real modifier, so the bare key is lower-case.
      key = CHAR_KEYCODES[rest.toLowerCase()];
    } else {
      key = NAMED_KEYCODES[rest.toLowerCase()];
    }
    if (!key) return null;
    return { modifiers, key };
  }

  // `bindings` is the raw strv from the setting ("WM_CLASS|accelerator");
  // `wmClasses` is the candidate class strings (class and instance).
  static resolveAccelerator(bindings, wmClasses, defaultAccel) {
    const classes = (wmClasses ?? [])
      .filter((c) => typeof c === "string" && c.length > 0)
      .map((c) => c.toLowerCase());
    for (const line of bindings ?? []) {
      const sep = line.indexOf("|");
      if (sep < 0) continue;
      const pattern = line.slice(0, sep).trim().toLowerCase();
      const accel = line.slice(sep + 1).trim();
      // Empty accelerator ("WM_CLASS|") means no override: fall back to default
      // rather than returning "", which would fail to parse instead of pasting.
      if (pattern && classes.includes(pattern)) return accel || defaultAccel;
    }
    return defaultAccel;
  }

  // Monotonic microsecond timestamp the virtual device expects. We inject from a
  // timer, where get_current_event_time() returns 0; each call advances, so
  // press/release pairs get distinct, ordered timestamps.
  _now() {
    return GLib.get_monotonic_time();
  }

  // Press modifiers, press the key, then release in reverse order, via notify_key
  // (hardware evdev keycodes) so the paste works under any keyboard layout.
  injectAccelerator(accel) {
    const parsed = Paster.parseAccelerator(accel);
    if (!parsed) {
      logError(
        new Error(`unparsable paste accelerator: ${accel}`),
        "[wayland-paste] cannot inject paste",
      );
      return false;
    }
    // Injected from a GLib timer; contain a throw so it does not escape into the main loop.
    try {
      const device = this._ensureDevice();

      for (const mod of parsed.modifiers)
        device.notify_key(this._now(), mod, Clutter.KeyState.PRESSED);
      device.notify_key(this._now(), parsed.key, Clutter.KeyState.PRESSED);
      device.notify_key(this._now(), parsed.key, Clutter.KeyState.RELEASED);
      for (const mod of [...parsed.modifiers].reverse())
        device.notify_key(this._now(), mod, Clutter.KeyState.RELEASED);
    } catch (err) {
      logError(err, "[wayland-paste] failed to inject paste keys");
      return false;
    }
    return true;
  }

  destroy() {
    // Drop the reference; GJS disposes on GC. Deliberately no run_dispose() — it
    // is discouraged for extension code and can dispose an object still in use.
    this._device = null;
  }
}

// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";

// We inject paste by EVDEV HARDWARE KEYCODE, not by keyval. notify_keyval()
// reverse-maps the keyval to a keycode *in the current keyboard group only*
// (mutter: pick_keycode_for_keyval_in_current_group); under a non-Latin layout
// (e.g. Russian) the keyval for "v" has no keycode in the active group, so the
// injection is dropped and nothing is pasted. A hardware keycode is the physical
// key position and is layout-independent — exactly like physically pressing
// Ctrl+V, which pastes under any layout because toolkits match the accelerator
// against the group-0 (Latin) keysym. Codes are Linux evdev codes from
// <linux/input-event-codes.h>.

// Modifier token -> evdev keycode. Accepts the spellings used in GTK
// accelerators (`<Primary>` is the portable name for Control).
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

// Single-character final key -> evdev keycode. The accelerator names the key by
// its US-layout label, which is a fixed hardware position.
const CHAR_KEYCODES = {
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6,
  "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
};

// Named (non-character) final keys we support in a paste accelerator.
const NAMED_KEYCODES = {
  insert: 110, // KEY_INSERT
  ins: 110,
};

// Paster injects key events through GNOME Shell's in-process Clutter virtual
// input device. Because this runs inside the compositor (the same mechanism the
// on-screen keyboard uses), the synthesized keys go to whatever window holds the
// keyboard focus and no Remote Desktop portal session is created, so no
// permission dialog appears.
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

  // Parse "<Shift><Ctrl>v" into { modifiers: [evcode...], key: evcode } where
  // each value is an evdev hardware keycode. Returns null if no usable key.
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
      // Single character: any Shift is supplied as a real modifier, so map the
      // lower-case label to its hardware key position.
      key = CHAR_KEYCODES[rest.toLowerCase()];
    } else {
      key = NAMED_KEYCODES[rest.toLowerCase()];
    }
    if (!key) return null;
    return { modifiers, key };
  }

  // Choose the accelerator for the given WM_CLASS values from the per-app list,
  // falling back to the default accelerator. `bindings` is the raw strv from the
  // setting ("WM_CLASS|accelerator"); `wmClasses` is an array of candidate
  // class strings (class and instance).
  static resolveAccelerator(bindings, wmClasses, defaultAccel) {
    const classes = (wmClasses ?? [])
      .filter((c) => typeof c === "string" && c.length > 0)
      .map((c) => c.toLowerCase());
    for (const line of bindings ?? []) {
      const sep = line.indexOf("|");
      if (sep < 0) continue;
      const pattern = line.slice(0, sep).trim().toLowerCase();
      const accel = line.slice(sep + 1).trim();
      if (pattern && classes.includes(pattern)) return accel;
    }
    return defaultAccel;
  }

  // Monotonic timestamp in microseconds. The virtual device expects monotonic
  // microsecond timestamps (the OSK uses `get_current_event_time() * 1000`, but
  // that returns 0 outside an event handler — and we inject from a timer). Each
  // call advances, so press/release pairs get distinct, ordered timestamps.
  _now() {
    return GLib.get_monotonic_time();
  }

  // Type the given accelerator now. Presses modifiers, presses the key, then
  // releases everything in reverse order. Uses notify_key (hardware evdev
  // keycodes) so the paste works under any keyboard layout.
  injectAccelerator(accel) {
    const parsed = Paster.parseAccelerator(accel);
    if (!parsed) {
      logError(
        new Error(`unparsable paste accelerator: ${accel}`),
        "[wayland-paste] cannot inject paste",
      );
      return false;
    }
    const device = this._ensureDevice();

    for (const mod of parsed.modifiers)
      device.notify_key(this._now(), mod, Clutter.KeyState.PRESSED);
    device.notify_key(this._now(), parsed.key, Clutter.KeyState.PRESSED);
    device.notify_key(this._now(), parsed.key, Clutter.KeyState.RELEASED);
    for (const mod of [...parsed.modifiers].reverse())
      device.notify_key(this._now(), mod, Clutter.KeyState.RELEASED);
    return true;
  }

  destroy() {
    // The virtual device is released when its last reference is dropped; GJS
    // disposes it on garbage collection. Drop our reference explicitly.
    if (this._device) {
      this._device.run_dispose?.();
      this._device = null;
    }
  }
}

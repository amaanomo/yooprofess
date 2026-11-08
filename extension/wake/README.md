# Wake word files (optional)

Nova spots "Hey Nova" with Chrome's speech recognition by default, so **nothing here is required**. These files are only for the optional on-device Picovoice engine, which Nova uses automatically when an AccessKey is saved in settings *and* `hey-nova_wasm.ppn` exists.

- `porcupine_params.pv`: Porcupine v4 English model (from github.com/Picovoice/porcupine, `lib/common/`).
- `hey-nova_wasm.ppn`: **you add this.** On https://console.picovoice.ai/ open Porcupine, type
  "Hey Nova", pick English + **Web (WASM)**, train, download, and save the `.ppn` here with this exact name.
  Then reload the extension on `chrome://extensions`.

The vendored engine is `../vendor/porcupine-web-4.0.1.min.js` (`@picovoice/porcupine-web` 4.0.1, Apache-2.0).

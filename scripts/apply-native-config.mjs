// apply-native-config.mjs — inject the microphone permissions the app needs.
//
// Capacitor generates the native ios/ and android/ projects with `cap add`.
// Rather than hand-editing (and risking loss on regeneration), this script
// idempotently patches:
//   - iOS   Info.plist         -> NSMicrophoneUsageDescription
//   - Android AndroidManifest  -> RECORD_AUDIO + MODIFY_AUDIO_SETTINGS
//
// It is safe to run repeatedly and before the native folders exist (it just
// reports and skips). Run it after `cap add` and before `cap sync`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIC_REASON =
  'Kaleidosound uses the microphone to turn live sound — music, singing, or ' +
  'ambient audio — into real-time visuals. Audio is processed on-device and ' +
  'never recorded or transmitted.';

let changed = false;

// ---- iOS ------------------------------------------------------------------
const infoPlist = resolve(root, 'ios/App/App/Info.plist');
if (existsSync(infoPlist)) {
  let xml = readFileSync(infoPlist, 'utf8');
  if (xml.includes('NSMicrophoneUsageDescription')) {
    console.log('iOS: NSMicrophoneUsageDescription already present.');
  } else {
    const entry = `\t<key>NSMicrophoneUsageDescription</key>\n\t<string>${MIC_REASON}</string>\n`;
    // Insert just before the final </dict>.
    const idx = xml.lastIndexOf('</dict>');
    if (idx !== -1) {
      xml = xml.slice(0, idx) + entry + xml.slice(idx);
      writeFileSync(infoPlist, xml);
      console.log('iOS: added NSMicrophoneUsageDescription.');
      changed = true;
    } else {
      console.error('iOS: could not find </dict> in Info.plist.');
    }
  }
} else {
  console.log('iOS: project not found yet (run `npx cap add ios`). Skipping.');
}

// ---- Android --------------------------------------------------------------
const manifest = resolve(root, 'android/app/src/main/AndroidManifest.xml');
if (existsSync(manifest)) {
  let xml = readFileSync(manifest, 'utf8');
  const perms = [
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
  ];
  const toAdd = perms.filter((p) => !xml.includes(p));
  if (toAdd.length === 0) {
    console.log('Android: audio permissions already present.');
  } else {
    const block =
      toAdd.map((p) => `    <uses-permission android:name="${p}" />`).join('\n') + '\n';
    // Insert right after the opening <manifest ...> tag.
    const m = xml.match(/<manifest[^>]*>\s*\n/);
    if (m) {
      const at = m.index + m[0].length;
      xml = xml.slice(0, at) + block + xml.slice(at);
      writeFileSync(manifest, xml);
      console.log(`Android: added ${toAdd.length} audio permission(s).`);
      changed = true;
    } else {
      console.error('Android: could not locate <manifest> tag.');
    }
  }
} else {
  console.log('Android: project not found yet (run `npx cap add android`). Skipping.');
}

console.log(changed ? 'Native config updated.' : 'Native config already up to date.');

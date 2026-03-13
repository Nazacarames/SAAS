import fs from "fs";
import path from "path";
import { getRuntimeSettings, saveRuntimeSettings } from "../src/services/SettingsServices/RuntimeSettingsService";

const filePath = path.resolve(process.cwd(), "runtime-settings.json");
const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;

const restore = () => {
  if (original === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } else {
    fs.writeFileSync(filePath, original, "utf-8");
  }
};

try {
  saveRuntimeSettings({ waInboundReplayFailClosed: false });
  const s1 = getRuntimeSettings();
  if (s1.waInboundReplayFailClosed !== false) {
    throw new Error(`Expected false after patch, got ${String(s1.waInboundReplayFailClosed)}`);
  }

  saveRuntimeSettings({ waInboundReplayFailClosed: true });
  const s2 = getRuntimeSettings();
  if (s2.waInboundReplayFailClosed !== true) {
    throw new Error(`Expected true after patch, got ${String(s2.waInboundReplayFailClosed)}`);
  }

  console.log("runtimeSettingsPatchCheck: OK");
} finally {
  restore();
}

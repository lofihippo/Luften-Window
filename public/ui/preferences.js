// Browser preference storage. Inject the accessor to test blocked storage safely.
export const STORAGE_KEY = "openwindow.settings";
const storage = () => globalThis.localStorage;

export function readPreferences(getStorage = storage) {
  try {
    const raw = getStorage().getItem(STORAGE_KEY);
    if (raw === null) return { settings: {}, notice: "" };
    const value = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { settings: {}, notice: "Saved settings were invalid and have been ignored." };
    }
    return { settings: value, notice: "" };
  } catch {
    return { settings: {}, notice: "Saved settings could not be read. You can still use and share this page." };
  }
}

export function writePreferences(settings, getStorage = storage) {
  try {
    getStorage().setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function clearPreferences(getStorage = storage) {
  try {
    getStorage().removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export const CLICKTHROUGH_RECOVERY_SHORTCUTS = Object.freeze([
  'CommandOrControl+Shift+M',
  'CommandOrControl+Alt+M',
]);

/**
 * Build hotkeys that can always recover an accidentally click-through HUD.
 * The click-through recovery combinations are intentionally independent of
 * the user's general hotkey preference because the HUD itself cannot receive
 * mouse input while setIgnoreMouseEvents(true) is active.
 */
export function getGlobalHotkeyDefinitions(enabled = true) {
  const definitions = [];
  if (enabled !== false) {
    definitions.push(
      { accelerator: 'CommandOrControl+Shift+O', action: 'toggle-overlay' },
      { accelerator: 'CommandOrControl+Shift+N', action: 'open-dashboard' },
      { accelerator: 'CommandOrControl+Shift+P', action: 'toggle-pin' },
    );
  }
  definitions.push(
    { accelerator: CLICKTHROUGH_RECOVERY_SHORTCUTS[0], action: 'toggle-clickthrough', recovery: true },
    { accelerator: CLICKTHROUGH_RECOVERY_SHORTCUTS[1], action: 'disable-clickthrough', recovery: true },
  );
  return definitions;
}

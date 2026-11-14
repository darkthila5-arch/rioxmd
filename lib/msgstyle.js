// WA button MESSAGE TYPE (not the web UI button style in btnstyle.js).
// Styles:
//   'viewonce'  – default: native-flow interactive buttons wrapped in a viewOnceMessage (current behaviour)
//   'hydrated'  – legacy hydrated template buttons (max 3: quick reply / url). Only used when every button
//                 in a given message actually fits that shape; sendInteractive() falls back to 'viewonce'
//                 automatically for anything bigger (e.g. the list-menu buttons), so this never breaks a menu.
import { getSetting, setSetting } from './storage.js';

const G = '_global';
export const MSG_STYLES = ['viewonce', 'hydrated'];

export const getMsgStyle = () => {
  const v = getSetting(G, 'msgStyle', 'viewonce');
  return MSG_STYLES.includes(v) ? v : 'viewonce';
};

export function setMsgStyle(style) {
  if (!MSG_STYLES.includes(style)) throw new Error('Unknown button message style.');
  setSetting(G, 'msgStyle', style);
}

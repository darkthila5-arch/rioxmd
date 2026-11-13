// Button style for the web UI (pair site, settings site).
// Styles:
//   'filled'  – default: solid green gradient button (original look)
//   'outline' – pill/outline style matching WhatsApp native button look
import { getSetting, setSetting } from './storage.js';

const G = '_global';
export const BTN_STYLES = ['filled', 'outline'];

export const getBtnStyle = () => {
  const v = getSetting(G, 'btnStyle', 'filled');
  return BTN_STYLES.includes(v) ? v : 'filled';
};

export function setBtnStyle(style) {
  if (!BTN_STYLES.includes(style)) throw new Error('Unknown button style.');
  setSetting(G, 'btnStyle', style);
}
